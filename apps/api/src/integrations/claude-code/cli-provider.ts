import { spawn } from "node:child_process";
import type {
  AIExecutionRequest,
  AIExecutionResult,
  AIProvider,
  ClassifiedError,
  HealthStatus,
} from "@synapse/contracts";
import type { Clock } from "@synapse/shared";
import { buildClaudeArgs } from "../../core/orchestrator/cli-args";
import { clampQuotaRetry } from "../../core/orchestrator/quota-gate";
import { StreamParser } from "../../core/orchestrator/stream-parser";
import { buildGuardedOverride, SEND_GUARD_HOOK_PATH } from "./send-guard";
import { DEFAULT_SETTINGS_OVERRIDE } from "./settings-override";

const TESTED_VERSION = "2.1.318";
const HEALTH_TIMEOUT_MS = 5000;
const CLOSE_CAP_MS = 500;
const AUTH_RE =
  /oauth token|please run \/login|not logged in|authentication (failed|error|required)|unauthori[sz]ed|invalid api key/i;
const QUOTA_TEXT_RE = /usage limit|rate limit|quota (exceeded|exhausted|reached)/i;

/** A spawn failure message by errno code; never includes paths or arguments. */
export function spawnErrorMessage(code: string | undefined): string {
  if (code === "ENOENT" || code === "EACCES") return "claude binary not found or not executable";
  if (code === "E2BIG") return "arguments too large";
  return `spawn failed (${code ?? "unknown"})`;
}

function errnoCode(e: unknown): string | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : undefined;
}

export interface ClaudeCliProviderOptions {
  binary: string;
  prefixArgs?: string[];
  env: Record<string, string>;
  clock: Clock;
  killGraceMs?: number;
  /** `--settings` JSON disabling plugins and hooks (R34); defaults to an empty override. */
  settingsOverride?: string;
}

interface SpawnOutcome {
  stdout: string;
  stderrBytes: number;
  exitCode: number | null;
  spawnError: boolean;
  spawnErrorCode?: string;
  timedOut: boolean;
  aborted: boolean;
  /** A child process was actually started. */
  spawned: boolean;
}

interface SpawnOptions {
  args: string[];
  cwd?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
}

const emptyUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  costUsdEquivalent: 0,
};

const normalize = (s: string): string => s.replace(/[^A-Za-z0-9]/g, "_");

export class ClaudeCliProvider implements AIProvider {
  private readonly killGraceMs: number;

  constructor(private readonly opts: ClaudeCliProviderOptions) {
    this.killGraceMs = opts.killGraceMs ?? 5000;
  }

  private run(o: SpawnOptions): Promise<SpawnOutcome> {
    return new Promise((resolve) => {
      const out: SpawnOutcome = {
        stdout: "",
        stderrBytes: 0,
        exitCode: null,
        spawnError: false,
        timedOut: false,
        aborted: false,
        spawned: false,
      };
      if (o.signal?.aborted) {
        out.aborted = true;
        resolve(out);
        return;
      }
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(this.opts.binary, [...(this.opts.prefixArgs ?? []), ...o.args], {
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
          cwd: o.cwd,
          env: this.opts.env,
        });
      } catch (e) {
        out.spawnError = true;
        out.spawnErrorCode = errnoCode(e);
        resolve(out);
        return;
      }

      out.spawned = child.pid !== undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      let closeCapTimer: ReturnType<typeof setTimeout> | undefined;
      let hardTimer: ReturnType<typeof setTimeout> | undefined;
      let done = false;
      let exited = false;
      let rawCode: number | null = null;
      let rawSignal: NodeJS.Signals | null = null;

      const killGroup = (sig: "SIGTERM" | "SIGKILL"): void => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, sig);
        } catch {
          // ESRCH: group already gone
        }
      };
      const terminate = (): void => {
        if (done || killTimer) return;
        killGroup("SIGTERM");
        killTimer = setTimeout(() => killGroup("SIGKILL"), this.killGraceMs);
      };
      const onAbort = (): void => {
        if (exited || out.timedOut || out.aborted) return;
        out.aborted = true;
        clearTimeout(timeoutTimer);
        terminate();
      };
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timeoutTimer);
        clearTimeout(killTimer);
        clearTimeout(closeCapTimer);
        clearTimeout(hardTimer);
        o.signal?.removeEventListener("abort", onAbort);
        child.stdout?.destroy();
        child.stderr?.destroy();
        const clean = !out.spawnError && !out.timedOut && !out.aborted && rawSignal === null;
        out.exitCode = clean ? rawCode : null;
        resolve(out);
      };

      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        if (done) return;
        out.stdout += o.onStdout ? "" : chunk;
        o.onStdout?.(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (!done) out.stderrBytes += chunk.length;
      });
      child.on("error", (e) => {
        out.spawnError = true;
        out.spawnErrorCode = errnoCode(e);
        finish();
      });
      // The leader's exit ends the run; pipe holders (grandchildren) must not stall it.
      child.on("exit", (code, signal) => {
        exited = true;
        clearTimeout(timeoutTimer);
        rawCode = code;
        rawSignal = signal;
        killGroup("SIGKILL");
        closeCapTimer = setTimeout(finish, CLOSE_CAP_MS);
      });
      child.on("close", () => finish());

      timeoutTimer = setTimeout(() => {
        if (exited || out.aborted) return;
        out.timedOut = true;
        terminate();
      }, o.timeoutMs);
      hardTimer = setTimeout(finish, o.timeoutMs + this.killGraceMs + 1000);
      if (o.signal?.aborted) onAbort();
      else o.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async execute(r: AIExecutionRequest, signal: AbortSignal): Promise<AIExecutionResult> {
    const started = this.opts.clock.now().getTime();
    const parser = new StreamParser();
    // A parser exception inside the stdout listener would be uncaught and kill the process.
    let parserFault = false;
    const baseOverride = this.opts.settingsOverride ?? DEFAULT_SETTINGS_OVERRIDE;
    // J2: a guarded send gets a PreToolUse hook for this run only. If the guard cannot be built the
    // run fails closed before spawning (a thrown error would count as a spawned, uncertain send).
    let settingsOverride = baseOverride;
    if (r.sendGuard) {
      try {
        settingsOverride = buildGuardedOverride(baseOverride, r.sendGuard, [
          process.execPath,
          SEND_GUARD_HOOK_PATH,
        ]);
      } catch {
        return {
          status: "failed",
          toolResults: [],
          finalText: "",
          numTurns: 0,
          durationMs: 0,
          usage: emptyUsage,
          permissionDenials: [],
          connectors: [],
          availableTools: [],
          exitCode: null,
          error: {
            kind: "provider_error",
            message: "send guard could not be built",
            details: { notSpawned: true },
          },
        };
      }
    }
    const out = await this.run({
      args: buildClaudeArgs(r, settingsOverride),
      cwd: r.workingDirectory,
      timeoutMs: r.timeoutMs,
      signal,
      onStdout: (c) => {
        if (parserFault) return;
        try {
          parser.push(c);
        } catch {
          parserFault = true;
        }
      },
    });
    const now = this.opts.clock.now();
    let parsed: ReturnType<StreamParser["end"]>;
    try {
      parsed = parser.end(now);
    } catch {
      parserFault = true;
      parsed = new StreamParser().end(now);
    }
    const result = parsed.result;

    const base = {
      finalText: result?.text ?? parsed.finalText,
      numTurns: result?.numTurns ?? 0,
      durationMs: result?.durationMs ?? Math.max(0, now.getTime() - started),
      usage: result?.usage ?? emptyUsage,
      quota: parsed.quota,
      permissionDenials: result?.permissionDenials ?? [],
      connectors: parsed.connectors,
      availableTools: parsed.availableTools,
      exitCode: out.exitCode,
    };
    const fail = (
      status: AIExecutionResult["status"],
      error?: ClassifiedError,
    ): AIExecutionResult => ({ ...base, status, toolResults: [], error });

    // Classification order (R28, amended by the final review fixes):
    //   spawn error (by errno code; marked notSpawned)
    //   → timed_out / cancelled (a pre-spawn abort is marked notSpawned)
    //   → parser fault (provider_error)
    //   → quota: a rejected window in a rate_limit_event
    //   → quota: an error result whose text mentions a usage/rate limit or quota (no event)
    //   → auth_failed → connector_not_ready → no result event (provider_error)
    //   → error_max_turns (provider_error, details.maxTurns, R16) → result.isError (provider_error) → non-zero exit (R29) → expectedToolNames unmet
    //   (incomplete_ai_output) → succeeded.
    // quota_exhausted retryAfter is max(resetsAt, now + 15 min), so it can never loop.
    if (out.spawnError) {
      return fail("failed", {
        kind: "provider_error",
        message: spawnErrorMessage(out.spawnErrorCode),
        details: { notSpawned: true },
      });
    }
    if (out.timedOut) {
      return fail("timed_out", {
        kind: "timeout",
        message: `claude run exceeded ${r.timeoutMs}ms`,
      });
    }
    if (out.aborted) {
      return fail(
        "cancelled",
        out.spawned
          ? undefined
          : { kind: "timeout", message: "cancelled before start", details: { notSpawned: true } },
      );
    }
    if (parserFault) {
      return fail("failed", {
        kind: "provider_error",
        message: "claude output could not be parsed",
      });
    }

    const rejected = [parsed.quota?.fiveHour, parsed.quota?.sevenDay].find(
      (w) => w?.status === "rejected",
    );
    if (rejected || (result?.isError && QUOTA_TEXT_RE.test(result.text))) {
      return fail("failed", {
        kind: "quota_exhausted",
        message: "Claude usage quota exhausted",
        retryAfter: clampQuotaRetry(rejected?.resetsAt, now),
      });
    }
    if (result?.isError && AUTH_RE.test(result.text)) {
      return fail("failed", { kind: "auth_failed", message: "Claude authentication failed" });
    }

    const notReady = new Set(
      parsed.connectors
        .filter((c) => c.status === "pending" || c.status === "failed")
        .map((c) => c.name),
    );
    const connectorFailure = parsed.toolResults.find(
      (t) =>
        t.isError &&
        /not connected|pending/i.test(t.content) &&
        [...notReady].some((name) => t.toolName.startsWith(`mcp__${normalize(name)}__`)),
    );
    if (connectorFailure) {
      return fail("failed", {
        kind: "connector_not_ready",
        message: "A required connector was not ready",
        details: { tool: connectorFailure.toolName },
      });
    }

    if (!result) {
      return fail("failed", {
        kind: "provider_error",
        message: "claude exited without a result event",
        details: { stderrBytes: out.stderrBytes },
      });
    }
    // R16: a run stopped by --max-turns is a runtime security signal for untrusted-content runs.
    // Classified by the result subtype whatever is_error or the exit code say.
    if (result.subtype === "error_max_turns") {
      return fail("failed", {
        kind: "provider_error",
        message: "claude reached max turns",
        details: { maxTurns: true, stderrBytes: out.stderrBytes },
      });
    }
    if (result.isError) {
      return fail("failed", {
        kind: "provider_error",
        message: "claude reported an error result",
        details: { stderrBytes: out.stderrBytes },
      });
    }
    if (out.exitCode !== 0) {
      return fail("failed", {
        kind: "provider_error",
        message: "claude exited abnormally despite a result event",
        details: { stderrBytes: out.stderrBytes },
      });
    }
    if (r.expectedToolNames) {
      const expected = new Set(r.expectedToolNames);
      if (!parsed.toolResults.some((t) => !t.isError && expected.has(t.toolName))) {
        return fail("failed", {
          kind: "incomplete_ai_output",
          message: "no successful result from an expected tool",
        });
      }
    }
    return { ...base, status: "succeeded", toolResults: parsed.toolResults };
  }

  async getHealth(): Promise<{ status: HealthStatus; detail?: string; version?: string }> {
    const out = await this.run({ args: ["--version"], timeoutMs: HEALTH_TIMEOUT_MS });
    const version = out.stdout.trim().split(/\s+/)[0] ?? "";
    if (out.spawnError || out.timedOut || out.exitCode !== 0 || !version) {
      return { status: "down", detail: "claude --version failed" };
    }
    if (version === TESTED_VERSION) return { status: "ok", version };
    return { status: "degraded", version, detail: `untested Claude Code version ${version}` };
  }
}
