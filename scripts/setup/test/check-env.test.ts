import { describe, expect, test } from "bun:test";
import { type EnvDeps, runChecks } from "../check-env";

function deps(over: Partial<EnvDeps> = {}): EnvDeps {
  return {
    bunVersion: "1.4.4",
    servicePath: "/home/u/.bun/bin:/home/u/.local/bin:/usr/bin:/bin",
    isExecutable: (p) => p === "/home/u/.local/bin/claude",
    run: async () => "Linger=yes\n",
    user: "u",
    ...over,
  };
}

describe("runChecks", () => {
  test("all ok", async () => {
    const r = await runChecks(deps());
    expect(r.ok).toBe(true);
    expect(r.lines).toHaveLength(3);
    expect(r.lines.every((l) => l.startsWith("✓"))).toBe(true);
  });

  test("old bun fails", async () => {
    const r = await runChecks(deps({ bunVersion: "1.3.9" }));
    expect(r.ok).toBe(false);
    expect(r.lines[0]).toMatch(/^✗.*1\.3\.9/);
  });

  test("claude missing from service PATH fails", async () => {
    const r = await runChecks(deps({ isExecutable: () => false }));
    expect(r.ok).toBe(false);
    expect(r.lines[1]).toMatch(/^✗.*claude/);
  });

  test("linger off fails with fix command", async () => {
    const r = await runChecks(deps({ run: async () => "Linger=no\n" }));
    expect(r.ok).toBe(false);
    expect(r.lines[2]).toContain("loginctl enable-linger u");
  });

  test("loginctl failure is reported, not thrown", async () => {
    const r = await runChecks(
      deps({
        run: async () => {
          throw new Error("no loginctl");
        },
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.lines[2]).toMatch(/^✗.*no loginctl/);
  });
});
