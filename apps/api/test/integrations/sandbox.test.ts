import { describe, expect, test } from "bun:test";
import { SANDBOX_MASKED_ROOTS, type SandboxSpec } from "@synapse/contracts";
import {
  buildSandboxSettings,
  SANDBOX_FAILURE_RE,
  SANDBOX_MASKS,
  withSandboxSettings,
} from "../../src/integrations/claude-code/sandbox";
import { DEFAULT_SETTINGS_OVERRIDE } from "../../src/integrations/claude-code/settings-override";

const spec = (): SandboxSpec => ({
  tmpDir: "/home/u/s/runs/j1/tmp",
  denyRead: ["/home/u/.ssh"],
});

const EXPECTED = {
  sandbox: {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: false,
    allowUnsandboxedCommands: false,
    excludedCommands: [],
    filesystem: {
      denyRead: ["/home/u/.ssh", "/run", "/var/run", "/tmp"],
      allowRead: ["/home/u/s/runs/j1/tmp"],
    },
    network: {
      allowedDomains: [],
      deniedDomains: ["*"],
      strictAllowlist: true,
      allowAllUnixSockets: true,
    },
  },
};

describe("buildSandboxSettings (F1.2)", () => {
  test("returns exactly the validated sandbox settings, masks after the request's entries", () => {
    expect(buildSandboxSettings(spec())).toEqual(EXPECTED);
  });

  test("the masks are the shared contract roots", () => {
    expect(SANDBOX_MASKS).toEqual(["/run", "/var/run", "/tmp"]);
    expect([...SANDBOX_MASKS]).toEqual([...SANDBOX_MASKED_ROOTS]);
  });

  test("never mutates the spec, and returned arrays are fresh", () => {
    const s = spec();
    const out = buildSandboxSettings(s);
    expect(s).toEqual(spec());
    const fs = out.sandbox.filesystem as { denyRead: string[]; allowRead: string[] };
    fs.denyRead.push("/x");
    fs.allowRead.push("/y");
    expect(s.denyRead).toEqual(["/home/u/.ssh"]);
    expect(buildSandboxSettings(s)).toEqual(EXPECTED);
  });
});

describe("withSandboxSettings", () => {
  test("keeps plugins and hooks of the default override and adds the sandbox", () => {
    const o = JSON.parse(withSandboxSettings(DEFAULT_SETTINGS_OVERRIDE, spec()));
    expect(o).toEqual({ enabledPlugins: {}, hooks: {}, ...EXPECTED });
  });

  test("a sandbox key already in the override is replaced, other keys are kept", () => {
    const base = JSON.stringify({
      enabledPlugins: { "p@m": false },
      hooks: { PreToolUse: [{ matcher: "x", hooks: [] }] },
      disableAllHooks: false,
      sandbox: { enabled: false, excludedCommands: ["bun"] },
    });
    const o = JSON.parse(withSandboxSettings(base, spec()));
    expect(o.enabledPlugins).toEqual({ "p@m": false });
    expect(o.hooks.PreToolUse[0].matcher).toBe("x");
    expect(o.disableAllHooks).toBe(false);
    expect(o.sandbox).toEqual(EXPECTED.sandbox);
  });

  test("a non-object override throws", () => {
    for (const bad of ["[]", "null", "1", '"s"']) {
      expect(() => withSandboxSettings(bad, spec())).toThrow(
        "sandbox: settings override is not an object",
      );
    }
    expect(() => withSandboxSettings("{not json", spec())).toThrow();
  });
});

test("SANDBOX_FAILURE_RE matches a sandbox startup error", () => {
  expect(SANDBOX_FAILURE_RE.test("Error: sandbox required but not available")).toBe(true);
  expect(SANDBOX_FAILURE_RE.test("Sandbox unavailable")).toBe(true);
  expect(SANDBOX_FAILURE_RE.test("something else broke")).toBe(false);
});
