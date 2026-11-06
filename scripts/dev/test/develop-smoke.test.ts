import { expect, test } from "bun:test";
import {
  formatSummary,
  outcomeOf,
  parseSandboxProbe,
  probeTestSource,
  type SandboxSummary,
  type SmokeSummary,
  smokeExitCode,
} from "../develop-smoke";

const base: SmokeSummary = {
  investigate: { ok: true },
  develop: { files: 2, testsPassed: true, unsafe: false },
  commit: { ok: true },
  mergeLocal: { ok: true },
  cancelledBeforePush: true,
  lockReleased: true,
  sandbox: { outsideWrite: "blocked", secret: "blocked", network: "blocked" },
};

test("formatSummary prints statuses and counts only, in the documented lines", () => {
  expect(formatSummary(base)).toEqual([
    "investigate: ok",
    "develop: files=2 testsPassed=true unsafe=false",
    "commit: ok",
    "merge_local: ok",
    "cancelled_before_push: true",
    "lock_released: true",
    "sandbox: outside_write=blocked secret=blocked network=blocked",
  ]);
});

test("formatSummary shows failure codes and a develop run that never happened", () => {
  const lines = formatSummary({
    ...base,
    investigate: { ok: false, code: "parse_failed" },
    develop: null,
    commit: { ok: false, code: "not_run" },
    mergeLocal: { ok: false, code: "not_run" },
    cancelledBeforePush: false,
    lockReleased: false,
  });
  expect(lines).toEqual([
    "investigate: failed(parse_failed)",
    "develop: not_run",
    "commit: failed(not_run)",
    "merge_local: failed(not_run)",
    "cancelled_before_push: false",
    "lock_released: false",
    "sandbox: outside_write=blocked secret=blocked network=blocked",
  ]);
});

test("outcomeOf maps a done step to ok and anything else to a fixed code", () => {
  expect(outcomeOf("done", null)).toEqual({ ok: true });
  expect(outcomeOf("failed", "unsafe_change")).toEqual({ ok: false, code: "unsafe_change" });
  expect(outcomeOf("awaiting_approval", null)).toEqual({ ok: false, code: "awaiting_approval" });
  expect(outcomeOf(undefined, null)).toEqual({ ok: false, code: "not_run" });
});

test("outcomeOf never echoes a failure that is not a fixed code", () => {
  expect(outcomeOf("failed", "secret text /home/me/x")).toEqual({ ok: false, code: "unknown" });
  expect(outcomeOf("failed", "registry_error:duplicate_name")).toEqual({
    ok: false,
    code: "registry_error:duplicate_name",
  });
});

const ALL_BLOCKED: SandboxSummary = {
  outsideWrite: "blocked",
  secret: "blocked",
  network: "blocked",
};

test("parseSandboxProbe reads the marker line", () => {
  const tail = "ok\nSANDBOX_PROBE outside_write=blocked secret=blocked network=blocked\n";
  expect(parseSandboxProbe(tail)).toEqual(ALL_BLOCKED);
});

test("parseSandboxProbe: the last marker line wins", () => {
  const tail =
    "SANDBOX_PROBE outside_write=allowed secret=allowed network=allowed\nSANDBOX_PROBE outside_write=blocked secret=allowed network=blocked\n";
  expect(parseSandboxProbe(tail)).toEqual({
    outsideWrite: "blocked",
    secret: "allowed",
    network: "blocked",
  });
});

test("parseSandboxProbe gives unknown for a missing or malformed line", () => {
  const unknown: SandboxSummary = {
    outsideWrite: "unknown",
    secret: "unknown",
    network: "unknown",
  };
  expect(parseSandboxProbe(null)).toEqual(unknown);
  expect(parseSandboxProbe("no marker")).toEqual(unknown);
  expect(
    parseSandboxProbe("SANDBOX_PROBE outside_write=maybe secret=blocked network=blocked"),
  ).toEqual({ ...ALL_BLOCKED, outsideWrite: "unknown" });
});

test("smokeExitCode is 1 only when a sandbox probe was allowed", () => {
  expect(smokeExitCode(base)).toBe(0);
  expect(smokeExitCode({ ...base, sandbox: { ...ALL_BLOCKED, secret: "unknown" } })).toBe(0);
  expect(smokeExitCode({ ...base, sandbox: { ...ALL_BLOCKED, network: "allowed" } })).toBe(1);
});

test("the generated sandbox probe test names the probes, never logs the secret", () => {
  const src = probeTestSource({
    outsideFile: "/h/root/outside-probe.txt",
    secretFile: "/h/root/data/probe-secret.txt",
    url: "https://example.com/",
  });
  expect(src).toContain("SANDBOX_PROBE");
  expect(src).toContain("/h/root/outside-probe.txt");
  expect(src).toContain("/h/root/data/probe-secret.txt");
  expect(src).toContain("https://example.com/");
  const logs = src.split("\n").filter((l) => l.includes("console.log"));
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain("SANDBOX_PROBE");
});
