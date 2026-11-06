import { afterAll, describe, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AIExecutionRequest } from "@synapse/contracts";
import { FakeClock } from "@synapse/shared";
import { buildClaudeArgs } from "../../src/core/orchestrator/cli-args";
import { StreamParser } from "../../src/core/orchestrator/stream-parser";
import {
  ClaudeCliProvider,
  StderrHead,
  spawnErrorMessage,
} from "../../src/integrations/claude-code/cli-provider";
import {
  buildGuardedOverride,
  SEND_GUARD_HOOK_PATH,
} from "../../src/integrations/claude-code/send-guard";
import { DEFAULT_SETTINGS_OVERRIDE } from "../../src/integrations/claude-code/settings-override";

const fixture = resolve(import.meta.dir, "../fixtures/fake-claude.ts");
const tmp = mkdtempSync(join(tmpdir(), "cli-provider-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function provider(env: Record<string, string>, binary = process.execPath) {
  return new ClaudeCliProvider({
    binary,
    prefixArgs: ["run", fixture],
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    clock: new FakeClock("2026-11-05T00:00:00Z"),
    killGraceMs: 200,
  });
}

function req(over: Partial<AIExecutionRequest> = {}): AIExecutionRequest {
  return {
    runId: "run1",
    jobId: null,
    workerProfile: "collector",
    model: "sonnet",
    systemPrompt: "sys",
    prompt: "hello",
    promptParts: [],
    allowedTools: ["mcp__claude_ai_Slack__slack_search_public"],
    disallowedTools: ["Bash"],
    maxTurns: 3,
    timeoutMs: 10_000,
    workingDirectory: tmp,
    ...over,
  };
}

const sig = () => new AbortController().signal;

describe("ClaudeCliProvider.execute", () => {
  test("success", async () => {
    const r = await provider({ FAKE_CLAUDE_MODE: "success" }).execute(req(), sig());
    expect(r.status).toBe("succeeded");
    expect(r.toolResults).toHaveLength(2);
    expect(r.quota).toBeDefined();
    expect(r.exitCode).toBe(0);
    expect(r.availableTools).toEqual(["ToolSearch"]);
  });

  test("fabricated with expectedToolNames is incomplete", async () => {
    const r = await provider({ FAKE_CLAUDE_MODE: "fabricated" }).execute(
      req({ expectedToolNames: ["mcp__claude_ai_Slack__slack_search_public"] }),
      sig(),
    );
    expect(r.status).toBe("failed");
    expect(r.error?.kind).toBe("incomplete_ai_output");
    expect(r.toolResults).toEqual([]);
  });

  test("noisy output still succeeds", async () => {
    const r = await provider({ FAKE_CLAUDE_MODE: "noisy" }).execute(req(), sig());
    expect(r.status).toBe("succeeded");
  });

  test("R16: an error_max_turns result is provider_error with details.maxTurns and its denials", async () => {
    const r = await provider({ FAKE_CLAUDE_MODE: "max_turns" }).execute(req(), sig());
    expect(r.status).toBe("failed");
    expect(r.error).toMatchObject({
      kind: "provider_error",
      message: "claude reached max turns",
      details: { maxTurns: true },
    });
    expect(r.permissionDenials).toEqual(["mcp__claude_ai_Slack__slack_send_message"]);
  });

  test("rate_rejected is quota_exhausted with retryAfter", async () => {
    const r = await provider({ FAKE_CLAUDE_MODE: "rate_rejected" }).execute(req(), sig());
    expect(r.status).toBe("failed");
    expect(r.error?.kind).toBe("quota_exhausted");
    expect(r.error?.retryAfter).toBe(new Date(1793893800 * 1000).toISOString());
  });

  test("R39: 'the login page returned 500' is provider_error", async () => {
    const r = await provider({ FAKE_CLAUDE_MODE: "login_page_500" }).execute(req(), sig());
    expect(r.error?.kind).toBe("provider_error");
  });

  test("auth_error is auth_failed", async () => {
    const r = await provider({ FAKE_CLAUDE_MODE: "auth_error" }).execute(req(), sig());
    expect(r.error?.kind).toBe("auth_failed");
  });

  test("crash is provider_error with no tool results", async () => {
    const r = await provider({ FAKE_CLAUDE_MODE: "crash" }).execute(req(), sig());
    expect(r.status).toBe("failed");
    expect(r.error?.kind).toBe("provider_error");
    expect(r.toolResults).toEqual([]);
    expect(r.exitCode).toBe(1);
  });

  test("hang times out and the process group is gone", async () => {
    const pidFile = join(tmp, "hang.pid");
    const t0 = Date.now();
    const r = await provider({ FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_PID_FILE: pidFile }).execute(
      req({ timeoutMs: 300 }),
      sig(),
    );
    expect(r.status).toBe("timed_out");
    expect(r.exitCode).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(-pid, 0)).toThrow();
  });

  test("abort signal cancels and the group is gone", async () => {
    const pidFile = join(tmp, "abort.pid");
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const t0 = Date.now();
    const r = await provider({ FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_PID_FILE: pidFile }).execute(
      req(),
      ac.signal,
    );
    expect(r.status).toBe("cancelled");
    expect(r.exitCode).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(() => process.kill(-Number(readFileSync(pidFile, "utf8")), 0)).toThrow();
  });

  test("already-aborted signal cancels without running", async () => {
    const pidFile = join(tmp, "pre.pid");
    const ac = new AbortController();
    ac.abort();
    const r = await provider({ FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_PID_FILE: pidFile }).execute(
      req(),
      ac.signal,
    );
    expect(r.status).toBe("cancelled");
    expect(r.exitCode).toBeNull();
  });

  test("abort then timeout: first cause (abort) wins", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const r = await provider({ FAKE_CLAUDE_MODE: "hang" }).execute(
      req({ timeoutMs: 150 }),
      ac.signal,
    );
    expect(r.status).toBe("cancelled");
  });

  test("SIGTERM-ignoring child is SIGKILLed after the grace period", async () => {
    const pidFile = join(tmp, "ign.pid");
    const t0 = Date.now();
    const r = await provider({
      FAKE_CLAUDE_MODE: "hang_ignore_term",
      FAKE_CLAUDE_PID_FILE: pidFile,
    }).execute(req({ timeoutMs: 300 }), sig());
    const elapsed = Date.now() - t0;
    expect(r.status).toBe("timed_out");
    expect(elapsed).toBeGreaterThanOrEqual(450);
    expect(elapsed).toBeLessThan(1500);
    expect(() => process.kill(-Number(readFileSync(pidFile, "utf8")), 0)).toThrow();
  });

  test("grandchild holding stdio does not stall a finished run", async () => {
    const t0 = Date.now();
    const r = await provider({ FAKE_CLAUDE_MODE: "grandchild" }).execute(
      req({ timeoutMs: 3000 }),
      sig(),
    );
    expect(r.status).toBe("succeeded");
    expect(r.exitCode).toBe(0);
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  test("setsid grandchild still resolves by the hard deadline", async () => {
    const t0 = Date.now();
    const r = await provider({ FAKE_CLAUDE_MODE: "grandchild_setsid" }).execute(
      req({ timeoutMs: 300 }),
      sig(),
    );
    expect(r.status).toBe("succeeded");
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  test("success result with non-zero exit is provider_error", async () => {
    const r = await provider({ FAKE_CLAUDE_MODE: "success_exit1" }).execute(req(), sig());
    expect(r.status).toBe("failed");
    expect(r.error?.kind).toBe("provider_error");
    expect(r.toolResults).toEqual([]);
  });

  test("connector_not_ready beats provider_error", async () => {
    const r = await provider({ FAKE_CLAUDE_MODE: "connector_not_ready" }).execute(req(), sig());
    expect(r.status).toBe("failed");
    expect(r.error?.kind).toBe("connector_not_ready");
    expect(r.toolResults).toEqual([]);
  });

  test("missing binary is provider_error without throwing", async () => {
    const r = await provider({}, "/nonexistent/claude").execute(req(), sig());
    expect(r.status).toBe("failed");
    expect(r.error?.kind).toBe("provider_error");
    expect(r.error?.message).toBe("claude binary not found or not executable");
    expect(r.exitCode).toBeNull();
  });

  test("argv matches buildClaudeArgs", async () => {
    const argvFile = join(tmp, "argv.json");
    const request = req();
    await provider({ FAKE_CLAUDE_MODE: "success", FAKE_CLAUDE_ARGV_FILE: argvFile }).execute(
      request,
      sig(),
    );
    const argv = JSON.parse(readFileSync(argvFile, "utf8"));
    expect(argv).toEqual(buildClaudeArgs(request, DEFAULT_SETTINGS_OVERRIDE));
    const custom = '{"enabledPlugins":{"x@y":false},"hooks":{}}';
    await new ClaudeCliProvider({
      binary: process.execPath,
      prefixArgs: ["run", fixture],
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        FAKE_CLAUDE_MODE: "success",
        FAKE_CLAUDE_ARGV_FILE: argvFile,
      },
      clock: new FakeClock("2026-11-05T00:00:00Z"),
      settingsOverride: custom,
    }).execute(request, sig());
    expect(JSON.parse(readFileSync(argvFile, "utf8"))).toEqual(buildClaudeArgs(request, custom));
  });

  test("every run is hermetic: auto memory and CLAUDE.md files are disabled in the env", async () => {
    const envFile = join(tmp, "env.json");
    // Even a caller env that tries to turn them back on is overridden.
    await provider({
      FAKE_CLAUDE_MODE: "success",
      FAKE_CLAUDE_ENV_FILE: envFile,
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0",
    }).execute(req({ workerProfile: "engineering" }), sig());
    expect(JSON.parse(readFileSync(envFile, "utf8"))).toEqual({
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
      hasPath: true,
      hasHome: true,
      TMPDIR: null,
    });
    rmSync(envFile);
    await provider({ FAKE_CLAUDE_MODE: "success", FAKE_CLAUDE_ENV_FILE: envFile }).execute(
      req(),
      sig(),
    );
    expect(JSON.parse(readFileSync(envFile, "utf8"))).toMatchObject({
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
    });
  });

  test("J2: a sendGuard adds a per-run PreToolUse hook; plugins stay disabled", async () => {
    const argvFile = join(tmp, "argv-guard.json");
    const custom = '{"enabledPlugins":{"x@y":false},"hooks":{}}';
    const SEND = "mcp__claude_ai_Slack__slack_send_message";
    const sha = "a".repeat(64);
    const guard = { toolName: SEND, expectedInputSha256: sha };
    const p = new ClaudeCliProvider({
      binary: process.execPath,
      prefixArgs: ["run", fixture],
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        FAKE_CLAUDE_MODE: "success",
        FAKE_CLAUDE_ARGV_FILE: argvFile,
      },
      clock: new FakeClock("2026-11-05T00:00:00Z"),
      settingsOverride: custom,
    });
    const settingsOf = () => {
      const argv: string[] = JSON.parse(readFileSync(argvFile, "utf8"));
      return argv[argv.indexOf("--settings") + 1] ?? "";
    };

    await p.execute(req({ sendGuard: guard }), sig());
    const o = JSON.parse(settingsOf());
    expect(o.enabledPlugins).toEqual({ "x@y": false });
    expect(o.hooks.PreToolUse[0].matcher).toBe(SEND);
    expect(o.hooks.PreToolUse[0].hooks[0].command).toContain(sha);
    expect(o.hooks.PreToolUse[0].hooks[0].command).toContain(SEND_GUARD_HOOK_PATH);
    expect(settingsOf()).toBe(
      buildGuardedOverride(custom, guard, [process.execPath, SEND_GUARD_HOOK_PATH]),
    );

    // per run only: the next run without a guard gets the unchanged override
    await p.execute(req(), sig());
    expect(settingsOf()).toBe(custom);
  });

  test("J2: a guard that cannot be built fails closed before spawning", async () => {
    const argvFile = join(tmp, "argv-guard-bad.json");
    const r = await new ClaudeCliProvider({
      binary: process.execPath,
      prefixArgs: ["run", fixture],
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        FAKE_CLAUDE_MODE: "success",
        FAKE_CLAUDE_ARGV_FILE: argvFile,
      },
      clock: new FakeClock("2026-11-05T00:00:00Z"),
      settingsOverride: "[]",
    }).execute(
      req({
        sendGuard: {
          toolName: "mcp__claude_ai_Slack__slack_send_message",
          expectedInputSha256: "c".repeat(64),
        },
      }),
      sig(),
    );
    expect(r.status).toBe("failed");
    expect(r.error).toEqual({
      kind: "provider_error",
      message: "send guard could not be built",
      details: { notSpawned: true },
    });
    expect(existsSync(argvFile)).toBe(false);
  });
});

describe("ADR-040: the develop-run sandbox", () => {
  const sandboxed = (tmpDir: string): Partial<AIExecutionRequest> => ({
    workerProfile: "engineering",
    allowedTools: ["Bash(bun test:*)"],
    disallowedTools: [],
    sandbox: { tmpDir, denyRead: ["/home/u/.ssh"] },
  });
  const settingsIn = (argvFile: string): Record<string, unknown> => {
    const argv: string[] = JSON.parse(readFileSync(argvFile, "utf8"));
    return JSON.parse(argv[argv.indexOf("--settings") + 1] ?? "");
  };

  test("the sandbox is merged into --settings, TMPDIR is set and tmpDir is created 0700", async () => {
    const dir = mkdtempSync(join(tmp, "sbx-"));
    const tmpDir = join(dir, "runs", "j1", "tmp");
    const argvFile = join(dir, "argv.json");
    const envFile = join(dir, "env.json");
    const r = await provider({
      FAKE_CLAUDE_MODE: "success",
      FAKE_CLAUDE_ARGV_FILE: argvFile,
      FAKE_CLAUDE_ENV_FILE: envFile,
    }).execute(req(sandboxed(tmpDir)), sig());
    expect(r.status).toBe("succeeded");
    const o = settingsIn(argvFile) as {
      enabledPlugins: unknown;
      hooks: unknown;
      sandbox: {
        enabled: boolean;
        failIfUnavailable: boolean;
        filesystem: { denyRead: string[]; allowRead: string[] };
        network: { deniedDomains: string[] };
      };
    };
    expect(o.enabledPlugins).toEqual({});
    expect(o.hooks).toEqual({});
    expect(o.sandbox.enabled).toBe(true);
    expect(o.sandbox.failIfUnavailable).toBe(true);
    expect(o.sandbox.network.deniedDomains).toEqual(["*"]);
    expect(o.sandbox.filesystem.denyRead).toEqual(["/home/u/.ssh", "/run", "/var/run", "/tmp"]);
    expect(o.sandbox.filesystem.allowRead).toEqual([tmpDir]);
    expect(JSON.parse(readFileSync(envFile, "utf8")).TMPDIR).toBe(tmpDir);
    expect(statSync(tmpDir).mode & 0o777).toBe(0o700);
  });

  test("an existing, looser tmpDir is tightened to 0700", async () => {
    const dir = mkdtempSync(join(tmp, "sbx-"));
    const tmpDir = join(dir, "tmp");
    mkdirSync(tmpDir, { mode: 0o755 });
    const r = await provider({ FAKE_CLAUDE_MODE: "success" }).execute(
      req(sandboxed(tmpDir)),
      sig(),
    );
    expect(r.status).toBe("succeeded");
    expect(statSync(tmpDir).mode & 0o777).toBe(0o700);
  });

  test("without a sandbox, --settings has no sandbox key and TMPDIR is not set", async () => {
    const dir = mkdtempSync(join(tmp, "sbx-"));
    const argvFile = join(dir, "argv.json");
    const envFile = join(dir, "env.json");
    await provider({
      FAKE_CLAUDE_MODE: "success",
      FAKE_CLAUDE_ARGV_FILE: argvFile,
      FAKE_CLAUDE_ENV_FILE: envFile,
    }).execute(req(), sig());
    expect(settingsIn(argvFile)).not.toHaveProperty("sandbox");
    expect(JSON.parse(readFileSync(envFile, "utf8")).TMPDIR).toBeNull();
  });

  test("the user's plugin override is kept, and a send guard does not drop the sandbox", async () => {
    const dir = mkdtempSync(join(tmp, "sbx-"));
    const argvFile = join(dir, "argv.json");
    const custom = '{"enabledPlugins":{"x@y":false},"hooks":{}}';
    const SEND = "mcp__claude_ai_Slack__slack_send_message";
    const sha = "b".repeat(64);
    const r = await new ClaudeCliProvider({
      binary: process.execPath,
      prefixArgs: ["run", fixture],
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        FAKE_CLAUDE_MODE: "success",
        FAKE_CLAUDE_ARGV_FILE: argvFile,
      },
      clock: new FakeClock("2026-11-05T00:00:00Z"),
      settingsOverride: custom,
    }).execute(
      req({
        ...sandboxed(join(dir, "tmp")),
        sendGuard: { toolName: SEND, expectedInputSha256: sha },
      }),
      sig(),
    );
    expect(r.status).toBe("succeeded");
    const o = settingsIn(argvFile) as {
      enabledPlugins: unknown;
      disableAllHooks: boolean;
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
      sandbox: { enabled: boolean; filesystem: { allowRead: string[] } };
    };
    expect(o.enabledPlugins).toEqual({ "x@y": false });
    expect(o.disableAllHooks).toBe(false);
    expect(o.hooks.PreToolUse[0]?.matcher).toBe(SEND);
    expect(o.hooks.PreToolUse[0]?.hooks[0]?.command).toContain(sha);
    expect(o.sandbox.enabled).toBe(true);
    expect(o.sandbox.filesystem.allowRead).toEqual([join(dir, "tmp")]);
  });

  test("a sandbox that fails at startup is sandboxUnavailable", async () => {
    const dir = mkdtempSync(join(tmp, "sbx-"));
    const r = await provider({ FAKE_CLAUDE_MODE: "sandbox_unavailable" }).execute(
      req(sandboxed(join(dir, "tmp"))),
      sig(),
    );
    expect(r.status).toBe("failed");
    expect(r.error?.kind).toBe("provider_error");
    expect(r.error?.message).toBe("sandbox unavailable");
    expect(r.error?.details?.sandboxUnavailable).toBe(true);
    expect(r.error?.details?.stderrBytes).toBeGreaterThan(0);
    // stderr is matched, never returned
    expect(JSON.stringify(r)).not.toMatch(/required but not available/);
  });

  test("the real CLI's startup refusal is sandboxUnavailable: its stderr line, or its result reason alone", async () => {
    const dir = mkdtempSync(join(tmp, "sbx-"));
    for (const mode of ["sandbox_unavailable_cli_stderr", "sandbox_startup_result"]) {
      const r = await provider({ FAKE_CLAUDE_MODE: mode }).execute(
        req(sandboxed(join(dir, "tmp"))),
        sig(),
      );
      expect(r.status).toBe("failed");
      expect(r.error?.message).toBe("sandbox unavailable");
      expect(r.error?.details?.sandboxUnavailable).toBe(true);
    }
  });

  test("sandbox violation notices are not a startup failure", async () => {
    const dir = mkdtempSync(join(tmp, "sbx-"));
    const viaStderr = await provider({ FAKE_CLAUDE_MODE: "sandbox_violation_stderr" }).execute(
      req(sandboxed(join(dir, "tmp"))),
      sig(),
    );
    expect(viaStderr.status).toBe("failed");
    expect(viaStderr.error?.message).toBe("claude exited abnormally despite a result event");
    expect(viaStderr.error?.details?.sandboxUnavailable).toBeUndefined();
    const viaResult = await provider({ FAKE_CLAUDE_MODE: "sandbox_violation_result" }).execute(
      req(sandboxed(join(dir, "tmp"))),
      sig(),
    );
    expect(viaResult.status).toBe("failed");
    expect(viaResult.error?.message).toBe("claude reported an error result");
    expect(viaResult.error?.details?.sandboxUnavailable).toBeUndefined();
  });

  test("max turns is classified first and keeps its marker", async () => {
    const dir = mkdtempSync(join(tmp, "sbx-"));
    const r = await provider({ FAKE_CLAUDE_MODE: "max_turns_sandbox_stderr" }).execute(
      req(sandboxed(join(dir, "tmp"))),
      sig(),
    );
    expect(r.error?.message).toBe("claude reached max turns");
    expect(r.error?.details?.maxTurns).toBe(true);
    expect(r.error?.details?.sandboxUnavailable).toBeUndefined();
  });

  test("an error result naming the sandbox is sandboxUnavailable", async () => {
    const dir = mkdtempSync(join(tmp, "sbx-"));
    const r = await provider({ FAKE_CLAUDE_MODE: "sandbox_error_result" }).execute(
      req(sandboxed(join(dir, "tmp"))),
      sig(),
    );
    expect(r.error?.message).toBe("sandbox unavailable");
    expect(r.error?.details?.sandboxUnavailable).toBe(true);
  });

  test("the same failures without a sandbox are not sandboxUnavailable", async () => {
    const r = await provider({ FAKE_CLAUDE_MODE: "sandbox_unavailable" }).execute(req(), sig());
    expect(r.status).toBe("failed");
    expect(r.error?.message).toBe("claude exited without a result event");
    expect(r.error?.details?.sandboxUnavailable).toBeUndefined();
    const e = await provider({ FAKE_CLAUDE_MODE: "sandbox_error_result" }).execute(req(), sig());
    expect(e.error?.message).toBe("claude reported an error result");
    expect(e.error?.details?.sandboxUnavailable).toBeUndefined();
  });

  test("a sandboxed failure whose stderr does not name the sandbox is not sandboxUnavailable", async () => {
    const dir = mkdtempSync(join(tmp, "sbx-"));
    const r = await provider({ FAKE_CLAUDE_MODE: "success_exit1" }).execute(
      req(sandboxed(join(dir, "tmp"))),
      sig(),
    );
    expect(r.status).toBe("failed");
    expect(r.error?.message).toBe("claude exited abnormally despite a result event");
    expect(r.error?.details?.sandboxUnavailable).toBeUndefined();
  });

  test("a successful sandboxed run is never sandboxUnavailable", async () => {
    const dir = mkdtempSync(join(tmp, "sbx-"));
    const r = await provider({ FAKE_CLAUDE_MODE: "success" }).execute(
      req(sandboxed(join(dir, "tmp"))),
      sig(),
    );
    expect(r.status).toBe("succeeded");
    expect(r.error).toBeUndefined();
  });

  test("a tmpDir that cannot be created fails closed before spawning", async () => {
    const dir = mkdtempSync(join(tmp, "sbx-"));
    const file = join(dir, "file");
    writeFileSync(file, "x");
    const argvFile = join(dir, "argv.json");
    const r = await provider({
      FAKE_CLAUDE_MODE: "success",
      FAKE_CLAUDE_ARGV_FILE: argvFile,
    }).execute(req(sandboxed(join(file, "tmp"))), sig());
    expect(r.status).toBe("failed");
    expect(r.error).toEqual({
      kind: "provider_error",
      message: "sandbox tmp dir could not be created",
      details: { notSpawned: true },
    });
    expect(existsSync(argvFile)).toBe(false);
  });

  test("a tmpDir that is a symlink fails closed before spawning", async () => {
    const dir = mkdtempSync(join(tmp, "sbx-"));
    const target = join(dir, "elsewhere");
    mkdirSync(target, { mode: 0o700 });
    const link = join(dir, "tmp");
    symlinkSync(target, link);
    const argvFile = join(dir, "argv.json");
    const r = await provider({
      FAKE_CLAUDE_MODE: "success",
      FAKE_CLAUDE_ARGV_FILE: argvFile,
    }).execute(req(sandboxed(link)), sig());
    expect(r.error).toEqual({
      kind: "provider_error",
      message: "sandbox tmp dir could not be created",
      details: { notSpawned: true },
    });
    expect(existsSync(argvFile)).toBe(false);
  });

  test("settings that cannot take the sandbox fail closed before spawning", async () => {
    const dir = mkdtempSync(join(tmp, "sbx-"));
    const argvFile = join(dir, "argv.json");
    const tmpDir = join(dir, "tmp");
    const r = await new ClaudeCliProvider({
      binary: process.execPath,
      prefixArgs: ["run", fixture],
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        FAKE_CLAUDE_MODE: "success",
        FAKE_CLAUDE_ARGV_FILE: argvFile,
      },
      clock: new FakeClock("2026-11-05T00:00:00Z"),
      settingsOverride: "[]",
    }).execute(req(sandboxed(tmpDir)), sig());
    expect(r.status).toBe("failed");
    expect(r.error).toEqual({
      kind: "provider_error",
      message: "sandbox settings could not be built",
      details: { notSpawned: true },
    });
    expect(existsSync(argvFile)).toBe(false);
    // Fails before the dir is created.
    expect(existsSync(tmpDir)).toBe(false);
  });
});

describe("StderrHead", () => {
  test("keeps the first 4096 characters, cut on a character boundary", () => {
    const h = new StderrHead();
    h.push(Buffer.from(`${"x".repeat(4095)}\u2014tail`));
    expect(h.text).toHaveLength(4096);
    expect(h.text.endsWith("\u2014")).toBe(true);
    expect(h.text).not.toContain("\uFFFD");
    h.push(Buffer.from("more"));
    expect(h.text).toHaveLength(4096);
  });

  test("a character split across chunks is decoded whole", () => {
    const h = new StderrHead();
    const dash = Buffer.from("a\u2014b");
    h.push(dash.subarray(0, 2));
    h.push(dash.subarray(2));
    expect(h.text).toBe("a\u2014b");
  });

  test("a surrogate pair is never split at the limit", () => {
    const h = new StderrHead();
    h.push(Buffer.from(`${"x".repeat(4095)}\u{1F600}`));
    expect(h.text).toBe("x".repeat(4095));
  });
});

describe("final-review fixes", () => {
  const NOW_PLUS_15 = "2026-11-05T00:15:00.000Z";

  test("I1: rejected window without resetsAt is quota_exhausted, retryAfter >= now + 15 min", async () => {
    const r = await provider({ FAKE_CLAUDE_MODE: "rate_no_reset" }).execute(req(), sig());
    expect(r.error?.kind).toBe("quota_exhausted");
    expect(r.error?.retryAfter).toBe(NOW_PLUS_15);
  });

  test("I1: rejected window with a past resetsAt is clamped to now + 15 min", async () => {
    const r = await provider({ FAKE_CLAUDE_MODE: "rate_past_reset" }).execute(req(), sig());
    expect(r.error?.kind).toBe("quota_exhausted");
    expect(r.error?.retryAfter).toBe(NOW_PLUS_15);
  });

  test("I1: a five-hour-only rejected event is quota_exhausted", async () => {
    const r = await provider({ FAKE_CLAUDE_MODE: "rate_five_only" }).execute(req(), sig());
    expect(r.error?.kind).toBe("quota_exhausted");
    expect(r.error?.retryAfter).toBe(new Date(1793893800 * 1000).toISOString());
    expect(r.quota?.sevenDay).toBeUndefined();
  });

  test("I1d: an error result mentioning a usage limit is quota_exhausted", async () => {
    const r = await provider({ FAKE_CLAUDE_MODE: "quota_text" }).execute(req(), sig());
    expect(r.status).toBe("failed");
    expect(r.error?.kind).toBe("quota_exhausted");
    expect(r.error?.retryAfter).toBe(NOW_PLUS_15);
    expect(r.error?.message).toBe("Claude usage quota exhausted");
  });

  test("P3: 'the quota was refreshed' is not quota_exhausted", async () => {
    const r = await provider({ FAKE_CLAUDE_MODE: "quota_refreshed" }).execute(req(), sig());
    expect(r.error?.kind).not.toBe("quota_exhausted");
  });

  test("I2: resetsAt 1e20 neither throws nor kills the process", async () => {
    const r = await provider({ FAKE_CLAUDE_MODE: "rate_huge_reset" }).execute(req(), sig());
    expect(r.status).toBe("succeeded");
    expect(r.quota?.fiveHour?.resetsAt).toBeUndefined();
  });

  test("I2: a parser fault is provider_error without content", async () => {
    const spy = spyOn(StreamParser.prototype, "push").mockImplementation(() => {
      throw new RangeError("secret-content");
    });
    try {
      const r = await provider({ FAKE_CLAUDE_MODE: "success" }).execute(req(), sig());
      expect(r.status).toBe("failed");
      expect(r.error?.kind).toBe("provider_error");
      expect(r.error?.message).toBe("claude output could not be parsed");
      expect(JSON.stringify(r.error)).not.toContain("secret-content");
      expect(r.toolResults).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  test("spawn errors are reported by code", () => {
    expect(spawnErrorMessage("ENOENT")).toBe("claude binary not found or not executable");
    expect(spawnErrorMessage("EACCES")).toBe("claude binary not found or not executable");
    expect(spawnErrorMessage("E2BIG")).toBe("arguments too large");
    expect(spawnErrorMessage("EMFILE")).toBe("spawn failed (EMFILE)");
    expect(spawnErrorMessage(undefined)).toBe("spawn failed (unknown)");
  });

  test("a huge argv is E2BIG: arguments too large, marked not spawned", async () => {
    const r = await provider({ FAKE_CLAUDE_MODE: "success" }).execute(
      req({ prompt: "x".repeat(300_000) }),
      sig(),
    );
    expect(r.status).toBe("failed");
    expect(r.error?.kind).toBe("provider_error");
    expect(r.error?.message).toBe("arguments too large");
    expect(r.error?.details).toMatchObject({ notSpawned: true });
  });

  test("missing binary and pre-abort are marked not spawned", async () => {
    const missing = await provider({}, "/nonexistent/claude").execute(req(), sig());
    expect(missing.error?.details).toMatchObject({ notSpawned: true });
    const ac = new AbortController();
    ac.abort();
    const pre = await provider({ FAKE_CLAUDE_MODE: "success" }).execute(req(), ac.signal);
    expect(pre.status).toBe("cancelled");
    expect(pre.error?.details).toMatchObject({ notSpawned: true });
  });
});

describe("ClaudeCliProvider.getHealth", () => {
  test("ok for tested version", async () => {
    const h = await provider({ FAKE_CLAUDE_MODE: "version" }).getHealth();
    expect(h).toMatchObject({ status: "ok", version: "2.1.318" });
  });
  test("degraded for another version", async () => {
    const h = await provider({ FAKE_CLAUDE_VERSION: "9.9.9" }).getHealth();
    expect(h.status).toBe("degraded");
    expect(h.detail).toBe("untested Claude Code version 9.9.9");
  });
  test("down for missing binary", async () => {
    expect((await provider({}, "/nonexistent/claude").getHealth()).status).toBe("down");
  });
});

describe("userPermissionsWidenScope", () => {
  test("defaults to false and carries the startup flag when given", () => {
    expect(provider({}).userPermissionsWidenScope).toBe(false);
    const p = new ClaudeCliProvider({
      binary: process.execPath,
      env: { PATH: process.env.PATH ?? "" },
      clock: new FakeClock("2026-11-05T00:00:00Z"),
      userPermissionsWidenScope: true,
    });
    expect(p.userPermissionsWidenScope).toBe(true);
  });
  test("carries the user-allowed connector server names, empty by default", () => {
    expect(provider({}).userAllowedConnectorServers).toEqual([]);
    const p = new ClaudeCliProvider({
      binary: process.execPath,
      env: { PATH: process.env.PATH ?? "" },
      clock: new FakeClock("2026-11-05T00:00:00Z"),
      userAllowedConnectorServers: ["mcp__demo_srv"],
    });
    expect(p.userAllowedConnectorServers).toEqual(["mcp__demo_srv"]);
  });
});
