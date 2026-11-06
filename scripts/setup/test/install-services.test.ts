import { describe, expect, test } from "bun:test";
import { planInstall, renderUnit } from "../install-services";

const vars = { BUN: "/home/u/.bun/bin/bun", REPO: "/repo", PATH: "/a:/b", DB_PATH: "/db/s.db" };

describe("renderUnit", () => {
  test("replaces every placeholder", () => {
    const out = renderUnit(
      "ExecStart={{BUN}} run --cwd {{REPO}}/apps/api start\nE={{PATH}} {{DB_PATH}} {{BUN}}",
      { ...vars, BUN: "/home/u/.bun/bin/bun" },
    );
    expect(out).toContain("ExecStart=/home/u/.bun/bin/bun run --cwd /repo/apps/api start");
    expect(out).not.toContain("{{");
  });

  test("throws when a placeholder has no value", () => {
    const partial = { BUN: "/b", REPO: "/r", PATH: "/p" } as unknown as typeof vars;
    expect(() => renderUnit("{{BUN}} {{DB_PATH}}", partial)).toThrow(/placeholder/);
  });
});

describe("planInstall", () => {
  const plan = planInstall({
    home: "/home/u",
    repo: "/repo",
    bunPath: "/home/u/.bun/bin/bun",
    dbPath: "/home/u/.local/share/synapse/synapse.db",
  });

  test("renders both units into the user systemd dir", () => {
    expect(plan.files.map((f) => f.path)).toEqual([
      "/home/u/.config/systemd/user/synapse-api.service",
      "/home/u/.config/systemd/user/synapse-web.service",
    ]);
    const [api, web] = plan.files;
    expect(api?.content).toContain("ExecStart=/home/u/.bun/bin/bun run --cwd /repo/apps/api start");
    expect(api?.content).toContain(
      "Environment=SYNAPSE_DB_PATH=/home/u/.local/share/synapse/synapse.db",
    );
    expect(web?.content).toContain("ExecStart=/home/u/.bun/bin/bun run --cwd /repo/apps/web start");
    expect(web?.content).toContain("After=synapse-api.service");
  });

  test("units are hardened and rate-limited", () => {
    for (const f of plan.files) {
      const c = f.content;
      for (const line of [
        "StartLimitIntervalSec=300",
        "StartLimitBurst=5",
        "TimeoutStopSec=30",
        "UMask=0077",
        "NoNewPrivileges=yes",
      ]) {
        expect(c).toContain(line);
      }
      expect(c).not.toContain("TimeoutStopSec=20");
      expect(c.indexOf("StartLimitIntervalSec=300")).toBeGreaterThan(c.indexOf("[Unit]"));
      expect(c.indexOf("StartLimitBurst=5")).toBeLessThan(c.indexOf("[Service]"));
      expect(c.indexOf("StartLimitIntervalSec=300")).toBeLessThan(c.indexOf("[Service]"));
    }
    const web = plan.files[1]?.content ?? "";
    expect(web).toContain("Wants=synapse-api.service");
    expect(web).toContain("After=synapse-api.service");
  });

  test("service PATH contains .bun/bin and .local/bin", () => {
    const line = plan.files[0]?.content.split("\n").find((l) => l.startsWith("Environment=PATH="));
    expect(line).toBe("Environment=PATH=/home/u/.bun/bin:/home/u/.local/bin:/usr/bin:/bin");
  });

  test("returns commands without running them", () => {
    expect(plan.commands).toEqual([
      "systemctl --user daemon-reload && systemctl --user enable --now synapse-api synapse-web",
    ]);
  });
});
