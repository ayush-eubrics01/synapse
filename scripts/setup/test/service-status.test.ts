import { expect, test } from "bun:test";
import { collectServiceStatus, type StatusDeps, UNITS } from "../service-status";

function deps(
  over: Partial<StatusDeps> & { out?: Record<string, { stdout: string; code: number }> },
) {
  const cmds: string[][] = [];
  const out = over.out ?? {};
  const d: StatusDeps = {
    run: async (cmd) => {
      cmds.push(cmd);
      return out[cmd.join(" ")] ?? { stdout: "", code: 0 };
    },
    fetchHealth: async () => "ok",
    user: "u",
    ...over,
  };
  return { cmds, d };
}

const OK = {
  "systemctl --user is-active synapse-api.service": { stdout: "active\n", code: 0 },
  "systemctl --user is-enabled synapse-api.service": { stdout: "enabled\n", code: 0 },
  "systemctl --user is-active synapse-web.service": { stdout: "active\n", code: 0 },
  "systemctl --user is-enabled synapse-web.service": { stdout: "enabled\n", code: 0 },
  "loginctl show-user u -p Linger": { stdout: "Linger=yes\n", code: 0 },
};

test("prints unit states, linger and api health", async () => {
  const { d } = deps({ out: OK });
  expect(await collectServiceStatus(d)).toEqual([
    "synapse-api.service: active=active enabled=enabled",
    "synapse-web.service: active=active enabled=enabled",
    "linger: on",
    "api health: ok",
  ]);
});

test("a non-zero exit is parsed", async () => {
  const { d } = deps({
    out: {
      ...OK,
      "systemctl --user is-active synapse-web.service": { stdout: "inactive\n", code: 3 },
    },
  });
  expect((await collectServiceStatus(d))[1]).toBe(
    "synapse-web.service: active=inactive enabled=enabled",
  );
});

test("unexpected output becomes unknown", async () => {
  const { d } = deps({
    out: {
      ...OK,
      "systemctl --user is-active synapse-api.service": {
        stdout: "Failed to connect to bus: No medium found\n",
        code: 1,
      },
      "loginctl show-user u -p Linger": { stdout: "garbage", code: 1 },
    },
  });
  const lines = await collectServiceStatus(d);
  expect(lines[0]).toBe("synapse-api.service: active=unknown enabled=enabled");
  expect(lines[2]).toBe("linger: unknown");
});

test("linger off", async () => {
  const { d } = deps({
    out: { ...OK, "loginctl show-user u -p Linger": { stdout: "Linger=no\n", code: 0 } },
  });
  expect((await collectServiceStatus(d))[2]).toBe("linger: off");
});

test("null health is unreachable", async () => {
  const { d } = deps({ out: OK, fetchHealth: async () => null });
  expect((await collectServiceStatus(d)).at(-1)).toBe("api health: unreachable");
});

test("only read-only commands run", async () => {
  const { cmds, d } = deps({ out: OK });
  await collectServiceStatus(d);
  expect(UNITS).toEqual(["synapse-api.service", "synapse-web.service"]);
  expect(cmds).toHaveLength(5);
  for (const cmd of cmds) {
    const line = cmd.join(" ");
    expect(
      /^(systemctl --user is-(active|enabled) synapse-(api|web)\.service|loginctl show-user u -p Linger)$/.test(
        line,
      ),
    ).toBe(true);
    for (const bad of ["start", "stop", "restart", "enable ", "daemon-reload", "journalctl"]) {
      expect(line).not.toContain(bad);
    }
  }
});
