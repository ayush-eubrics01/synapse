import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildGuardedOverride,
  canonicalSendInput,
  normaliseSendInput,
  SEND_GUARD_HOOK_PATH,
  sendInputSha256,
  shellQuote,
} from "../../src/integrations/claude-code/send-guard";
import { DEFAULT_SETTINGS_OVERRIDE } from "../../src/integrations/claude-code/settings-override";

const SEND = "mcp__claude_ai_Slack__slack_send_message";
const DIR = resolve(import.meta.dir, "../../src/integrations/claude-code");
const HOOK = join(DIR, "send-guard-hook.ts");
const REASON = "send arguments differ from the approved message";
const tmp = mkdtempSync(join(tmpdir(), "send-guard-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const args = { channel_id: "D0SYNTH1", message: "SYNTH: on it", thread_ts: "1793872900.000300" };
const hookJson = (toolInput: unknown) =>
  JSON.stringify({
    session_id: "s",
    hook_event_name: "PreToolUse",
    tool_name: SEND,
    tool_input: toolInput,
  });

async function runArgv(argv: string[], stdin: string) {
  const p = Bun.spawn(argv, { stdin: new Blob([stdin]), stdout: "pipe", stderr: "pipe" });
  const [code, stderr] = await Promise.all([p.exited, new Response(p.stderr).text()]);
  return { code, stderr };
}
const runHook = (sha: string, stdin: string, hook = HOOK, tool = SEND) =>
  runArgv([process.execPath, hook, sha, tool], stdin);

/** The hook command from a guarded override, run the way Claude Code runs it: through a shell. */
function commandOf(override: string): string {
  const parsed = JSON.parse(override);
  return parsed.hooks.PreToolUse[0].hooks[0].command;
}

describe("canonicalSendInput / sendInputSha256", () => {
  test("key order does not matter", () => {
    expect(canonicalSendInput({ message: "a", channel_id: "D1" })).toBe(
      canonicalSendInput({ channel_id: "D1", message: "a" }),
    );
    expect(canonicalSendInput({ message: "a", channel_id: "D1" })).toBe(
      '{"channel_id":"D1","message":"a"}',
    );
  });
  test("nested keys are sorted, arrays keep order, undefined keys are dropped", () => {
    expect(canonicalSendInput({ b: [3, { y: 1, x: 2 }], a: undefined, c: null })).toBe(
      '{"b":[3,{"x":2,"y":1}],"c":null}',
    );
    expect(canonicalSendInput({ channel_id: "D1", message: "a", thread_ts: undefined })).toBe(
      canonicalSendInput({ channel_id: "D1", message: "a" }),
    );
  });
  test("integer-like keys are sorted as strings too", () => {
    expect(canonicalSendInput({ "10": 1, "2": 2, a: 3 })).toBe('{"10":1,"2":2,"a":3}');
  });
  test("__proto__ is an ordinary key", () => {
    const o = JSON.parse('{"__proto__":{"x":1},"a":1}');
    expect(canonicalSendInput(o)).toBe('{"__proto__":{"x":1},"a":1}');
  });
  test("sha256 is hex of the canonical form", () => {
    expect(sendInputSha256(args)).toBe(
      createHash("sha256").update(canonicalSendInput(args), "utf8").digest("hex"),
    );
    expect(sendInputSha256(args)).toMatch(/^[0-9a-f]{64}$/);
  });
  test.each([
    ["channel_id", { ...args, channel_id: "D0SYNTH2" }],
    ["message", { ...args, message: "SYNTH: on it!" }],
    ["leading message whitespace", { ...args, message: " SYNTH: on it" }],
    ["thread_ts", { ...args, thread_ts: "1793872900.000301" }],
    ["thread_ts absent", { channel_id: args.channel_id, message: args.message }],
    ["extra key", { ...args, reply_broadcast: true }],
    ["unfurl_app_links true", { ...args, unfurl_app_links: true }],
    ["unfurl_app_links null", { ...args, unfurl_app_links: null }],
  ])("the sha256 changes when %s changes", (_n, other) => {
    expect(sendInputSha256(other)).not.toBe(sendInputSha256(args));
  });
  test.each([
    ["unfurl_app_links false", { ...args, unfurl_app_links: false }],
    ["trailing message spaces", { ...args, message: "SYNTH: on it  \n" }],
    ["both", { ...args, message: "SYNTH: on it ", unfurl_app_links: false }],
  ])("parity with matchesCommand: %s hashes like the approved args", (_n, other) => {
    expect(sendInputSha256(other)).toBe(sendInputSha256(args));
  });
  test("normaliseSendInput leaves non-objects and other keys alone", () => {
    expect(normaliseSendInput("x")).toBe("x");
    expect(normaliseSendInput([1])).toEqual([1]);
    expect(normaliseSendInput({ message: 3, unfurl_app_links: 0, a: " b " })).toEqual({
      message: 3,
      unfurl_app_links: 0,
      a: " b ",
    });
  });
});

describe("buildGuardedOverride", () => {
  const sha = sendInputSha256(args);
  const base = '{"enabledPlugins":{"x@y":false,"z@w":false},"hooks":{}}';

  test("adds one PreToolUse hook for the tool and keeps plugins disabled", () => {
    const o = JSON.parse(
      buildGuardedOverride(base, { toolName: SEND, expectedInputSha256: sha }, ["/b", "/h.ts"]),
    );
    expect(o.enabledPlugins).toEqual({ "x@y": false, "z@w": false });
    expect(Object.keys(o.hooks)).toEqual(["PreToolUse"]);
    expect(o.hooks.PreToolUse).toHaveLength(1);
    expect(o.hooks.PreToolUse[0].matcher).toBe(SEND);
    expect(o.hooks.PreToolUse[0].hooks).toEqual([
      { type: "command", command: `'/b' '/h.ts' '${sha}' '${SEND}' || exit 2`, timeout: 10 },
    ]);
  });

  test("disableAllHooks is forced to false so a user-level true cannot switch the guard off", () => {
    const g = { toolName: SEND, expectedInputSha256: sha };
    const withTrue = JSON.parse(
      buildGuardedOverride('{"disableAllHooks":true,"hooks":{}}', g, ["/b"]),
    );
    expect(withTrue.disableAllHooks).toBe(false);
    const plain = JSON.parse(buildGuardedOverride(base, g, ["/b"]));
    expect(plain.disableAllHooks).toBe(false);
  });

  test("the default override gains only the hook", () => {
    const o = JSON.parse(
      buildGuardedOverride(
        DEFAULT_SETTINGS_OVERRIDE,
        { toolName: SEND, expectedInputSha256: sha },
        ["/b"],
      ),
    );
    expect(o.enabledPlugins).toEqual({});
    expect(o.hooks.PreToolUse[0].hooks[0].command).toContain(sha);
  });

  test.each([
    ["short sha", { toolName: SEND, expectedInputSha256: "abc" }],
    ["uppercase sha", { toolName: SEND, expectedInputSha256: sha.toUpperCase() }],
    ["shell in sha", { toolName: SEND, expectedInputSha256: `${sha.slice(0, 60)};rm ` }],
    ["bad tool name", { toolName: "Bash|.*", expectedInputSha256: sha }],
  ])("rejects a malformed guard (%s)", (_n, guard) => {
    expect(() => buildGuardedOverride(base, guard, ["/b"])).toThrow();
  });

  test("rejects an empty hook command and a non-object base", () => {
    const g = { toolName: SEND, expectedInputSha256: sha };
    expect(() => buildGuardedOverride(base, g, [])).toThrow();
    expect(() => buildGuardedOverride("[]", g, ["/b"])).toThrow();
  });

  test("shellQuote survives spaces and single quotes", () => {
    expect(shellQuote("a b'c")).toBe("'a b'\\''c'");
  });

  test("SEND_GUARD_HOOK_PATH is the absolute path of the hook script", () => {
    expect(SEND_GUARD_HOOK_PATH).toBe(HOOK);
  });
});

describe("send-guard-hook.ts", () => {
  const sha = sendInputSha256(args);

  test("matching tool_input (any key order) exits 0", async () => {
    const reordered = {
      thread_ts: args.thread_ts,
      message: args.message,
      channel_id: args.channel_id,
    };
    const r = await runHook(sha, hookJson(reordered));
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
  });

  test("a changed message exits 2 with the reason on stderr, never the content", async () => {
    const r = await runHook(sha, hookJson({ ...args, message: "SYNTH: something else" }));
    expect(r.code).toBe(2);
    expect(r.stderr.trim()).toBe(REASON);
    expect(r.stderr).not.toContain("SYNTH");
  });

  test.each([
    ["unfurl_app_links false", { ...args, unfurl_app_links: false }],
    ["trailing message spaces", { ...args, message: "SYNTH: on it   " }],
  ])("parity: %s is allowed (exit 0)", async (_n, input) => {
    expect((await runHook(sha, hookJson(input))).code).toBe(0);
  });

  test.each([
    ["unfurl_app_links true", { ...args, unfurl_app_links: true }],
    ["reply_broadcast true", { ...args, reply_broadcast: true }],
  ])("parity: %s is blocked (exit 2)", async (_n, input) => {
    const r = await runHook(sha, hookJson(input));
    expect(r.code).toBe(2);
    expect(r.stderr.trim()).toBe(REASON);
  });

  test.each([
    ["not JSON", "{nope"],
    ["empty", ""],
    ["no tool_input", JSON.stringify({ tool_name: SEND })],
    ["array tool_input", hookJson([args])],
    ["string tool_input", hookJson("x")],
    ["null", "null"],
  ])("malformed stdin (%s) exits 2", async (_n, stdin) => {
    const r = await runHook(sha, stdin);
    expect(r.code).toBe(2);
    expect(r.stderr.length).toBeGreaterThan(0);
  });

  test("a missing or malformed expected sha exits 2", async () => {
    expect((await runArgv([process.execPath, HOOK], hookJson(args))).code).toBe(2);
    expect((await runHook("abc", hookJson(args))).code).toBe(2);
  });

  test("a missing or malformed tool name argument exits 2", async () => {
    expect((await runArgv([process.execPath, HOOK, sha], hookJson(args))).code).toBe(2);
    expect((await runHook(sha, hookJson(args), HOOK, "Bash|.*")).code).toBe(2);
  });

  test("a tool_name that differs from the guarded tool exits 2 with the fixed reason", async () => {
    const other = JSON.stringify({ tool_name: "mcp__x__other", tool_input: args });
    const r = await runHook(sha, other);
    expect(r.code).toBe(2);
    expect(r.stderr.trim()).toBe(REASON);
    const none = await runHook(sha, JSON.stringify({ tool_input: args }));
    expect(none.code).toBe(2);
    expect(none.stderr.trim()).toBe(REASON);
  });

  test("the built command runs through a shell from a path with spaces and quotes", async () => {
    const dir = join(tmp, "dir with space's");
    mkdirSync(dir, { recursive: true });
    for (const f of ["send-guard-hook.ts", "send-guard-canonical.ts"]) {
      copyFileSync(join(DIR, f), join(dir, f));
    }
    const override = buildGuardedOverride(
      DEFAULT_SETTINGS_OVERRIDE,
      { toolName: SEND, expectedInputSha256: sha },
      [process.execPath, join(dir, "send-guard-hook.ts")],
    );
    const cmd = commandOf(override);
    expect((await runArgv(["sh", "-c", cmd], hookJson(args))).code).toBe(0);
    const bad = await runArgv(["sh", "-c", cmd], hookJson({ ...args, channel_id: "D0OTHER" }));
    expect(bad.code).toBe(2);
    expect(bad.stderr.trim()).toBe(REASON);
  });

  test("a hook that cannot start still blocks (exit 2, not a non-blocking error)", async () => {
    const override = buildGuardedOverride(
      DEFAULT_SETTINGS_OVERRIDE,
      { toolName: SEND, expectedInputSha256: sha },
      [join(tmp, "no-such-binary"), HOOK],
    );
    expect((await runArgv(["sh", "-c", commandOf(override)], hookJson(args))).code).toBe(2);
  });
});
