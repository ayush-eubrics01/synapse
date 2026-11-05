import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AIExecutionRequest } from "@synapse/contracts";
import { FakeClock } from "@synapse/shared";
import { buildClaudeArgs } from "../../src/core/orchestrator/cli-args";
import { ClaudeCliProvider } from "../../src/integrations/claude-code/cli-provider";

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

  test("rate_rejected is quota_exhausted with retryAfter", async () => {
    const r = await provider({ FAKE_CLAUDE_MODE: "rate_rejected" }).execute(req(), sig());
    expect(r.status).toBe("failed");
    expect(r.error?.kind).toBe("quota_exhausted");
    expect(r.error?.retryAfter).toBe(new Date(1793893800 * 1000).toISOString());
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
    expect(Date.now() - t0).toBeLessThan(1000);
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(-pid, 0)).toThrow();
  });

  test("abort signal cancels", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const r = await provider({ FAKE_CLAUDE_MODE: "hang" }).execute(req(), ac.signal);
    expect(r.status).toBe("cancelled");
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
    expect(JSON.parse(readFileSync(argvFile, "utf8"))).toEqual(buildClaudeArgs(request));
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
