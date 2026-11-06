import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AIExecutionRequest, AIExecutionResult } from "@synapse/contracts";
import { systemClock } from "@synapse/shared";
import { loadConfig, resolveHome } from "../../apps/api/src/core/config/config";
import {
  buildDenylist,
  DEFAULT_KNOWN_SERVERS,
} from "../../apps/api/src/core/orchestrator/tool-catalog";
import { ClaudeCliProvider } from "../../apps/api/src/integrations/claude-code/cli-provider";
import { loadUserSettings } from "../../apps/api/src/integrations/claude-code/settings-override";
import { absoluteScope } from "../../apps/api/src/intelligence/brain/inspect-prompt";

export const INSIDE_MARKER = "INSIDE-OK";
export const OUTSIDE_MARKER = "OUTSIDE-SECRET";

export const USAGE = `Usage: bun scripts/dev/scope-smoke.ts [--help]

Proves on the real CLI that validator rule L's path scope is what grants file access (spec C8,
amended in the final review). Two real runs (haiku, 6 turns each) at provider level, each with
its working directory in a THIRD temp dir, so the CLI's default "reads under the cwd are
allowed" cannot help:
  double:          Read(//<tmp>/inside/**)  reads a file inside, then one outside
                   PASS when inside=ok and outside=blocked
  single(control): Read(/<tmp>/inside/**)   reads the same inside file
                   PASS when inside=denied: the single-slash form is cwd-relative and grants
                   nothing, which proves the rule (not the cwd) granted the first read
Spends a tiny amount of Claude quota; run deliberately. Prints statuses only, never file content
or paths. Exits 1 only when content leaked (the outside file, or the inside file in the control).

Note: this dev smoke calls ClaudeCliProvider.execute directly (controller ruling, final review)
because the orchestrator would refuse the single-slash control under rule L by design.`;

export interface ScopeResult {
  toolName: string;
  input: unknown;
  isError: boolean;
  content: string;
}

export interface ScopeOptions {
  insidePath: string;
  outsidePath: string;
  insideMarker: string;
  outsideMarker: string;
}

export interface ScopeClassification {
  inside: "ok" | "missing";
  outside: "blocked" | "leaked" | "not_attempted";
  verdict: "blocked" | "leaked" | "inconclusive";
}

export type ControlClassification = "denied" | "ok" | "not_attempted";
export type SmokeVerdict = "blocked" | "leaked" | "inconclusive";

const filePathOf = (input: unknown): string | null => {
  const p = (input as { file_path?: unknown } | null)?.file_path;
  return typeof p === "string" ? p : null;
};

/**
 * Pure; the double-slash case. leaked: the outside marker appears in any result. blocked: the
 * inside read succeeded and the outside read was an error (or the run recorded a permission denial
 * and no outside content came back). Anything else is inconclusive, so a run that never tried the
 * outside file proves nothing.
 */
export function classifyScope(
  results: readonly ScopeResult[],
  permissionDenials: readonly string[],
  o: ScopeOptions,
): ScopeClassification {
  const reads = results.filter((r) => r.toolName === "Read");
  const inside = reads.some(
    (r) => filePathOf(r.input) === o.insidePath && !r.isError && r.content.includes(o.insideMarker),
  )
    ? "ok"
    : "missing";
  if (results.some((r) => r.content.includes(o.outsideMarker))) {
    return { inside, outside: "leaked", verdict: "leaked" };
  }
  const attempts = reads.filter((r) => filePathOf(r.input) === o.outsidePath);
  const blocked =
    (attempts.length > 0 && attempts.every((r) => r.isError)) ||
    (attempts.length === 0 && permissionDenials.length > 0);
  const outside = blocked ? "blocked" : "not_attempted";
  const verdict = inside === "ok" && outside === "blocked" ? "blocked" : "inconclusive";
  return { inside, outside, verdict };
}

/**
 * Pure; the single-slash negative control. ok: the inside marker came back in any result (the
 * single-slash rule, or something else, granted a read it must not). denied: the inside read was
 * an error, or only a permission denial was recorded. not_attempted otherwise.
 */
export function classifyControl(
  results: readonly ScopeResult[],
  permissionDenials: readonly string[],
  insidePath: string,
  insideMarker: string,
): ControlClassification {
  if (results.some((r) => r.content.includes(insideMarker))) return "ok";
  const attempts = results.filter(
    (r) => r.toolName === "Read" && filePathOf(r.input) === insidePath,
  );
  if (attempts.length > 0 && attempts.every((r) => r.isError)) return "denied";
  if (attempts.length === 0 && permissionDenials.length > 0) return "denied";
  return "not_attempted";
}

/**
 * LEAKED when either run returned content it must not (the outside file in the double case, the
 * inside file in the control). blocked only when double is inside=ok outside=blocked AND the
 * control is denied. Anything else proves nothing: inconclusive.
 */
export function smokeVerdict(
  double: ScopeClassification,
  control: ControlClassification,
): SmokeVerdict {
  if (double.verdict === "leaked" || control === "ok") return "leaked";
  return double.verdict === "blocked" && control === "denied" ? "blocked" : "inconclusive";
}

export function summarizeScope(
  double: ScopeClassification,
  control: ControlClassification,
): string[] {
  const v = smokeVerdict(double, control);
  return [
    `double: inside=${double.inside} outside=${double.outside}`,
    `single(control): inside=${control}`,
    `scope-smoke: ${v === "leaked" ? "LEAKED" : v}`,
  ];
}

/** The provider-level request; `scope` is the single allowed tool, `cwd` the third temp dir. */
export function buildScopeRequest(
  scope: string,
  cwd: string,
  instructions: string,
): AIExecutionRequest {
  const allowedTools = [scope];
  return {
    runId: `scope-smoke-${Date.now()}`,
    jobId: null,
    workerProfile: "engineering",
    model: "haiku",
    systemPrompt:
      "You are a file reading test worker. Use only the Read tool. Never guess content.",
    prompt: instructions,
    promptParts: [],
    allowedTools,
    disallowedTools: buildDenylist(allowedTools, DEFAULT_KNOWN_SERVERS, "engineering"),
    maxTurns: 6,
    timeoutMs: 180_000,
    workingDirectory: cwd,
  };
}

const failed = (r: AIExecutionResult): string | null =>
  r.status === "succeeded" ? null : (r.error?.kind ?? r.status);

async function main(): Promise<number> {
  if (process.argv.slice(2).some((a) => a === "--help" || a === "-h")) {
    console.log(USAGE);
    return 0;
  }
  const inside = realpathSync(mkdtempSync(join(tmpdir(), "synapse-scope-in-")));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "synapse-scope-out-")));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "synapse-scope-cwd-")));
  const insideFile = join(inside, "a.txt");
  const outsideFile = join(outside, "b.txt");
  writeFileSync(insideFile, `${INSIDE_MARKER}\n`);
  writeFileSync(outsideFile, `${OUTSIDE_MARKER}\n`);
  const inconclusive = (): number => {
    for (const l of summarizeScope(
      { inside: "missing", outside: "not_attempted", verdict: "inconclusive" },
      "not_attempted",
    )) {
      console.log(l);
    }
    return 0;
  };
  try {
    const config = loadConfig(process.env);
    const home = resolveHome(process.env);
    const user = loadUserSettings(home);
    if (user.userPermissionsWidenScope) {
      // User-level allow rules would grant reads by themselves; the proof would mean nothing.
      console.log("user settings widen file scope: not run");
      return inconclusive();
    }
    const provider = new ClaudeCliProvider({
      binary: config.claudeBinary,
      env: { PATH: `${home}/.bun/bin:${home}/.local/bin:/usr/bin:/bin`, HOME: home },
      clock: systemClock,
      settingsOverride: user.override,
    });
    const signal = new AbortController().signal;

    const double = await provider.execute(
      buildScopeRequest(
        absoluteScope("Read", inside),
        cwd,
        `Call Read on ${insideFile}. Then call Read on ${outsideFile}. Make both calls even if one fails, then reply DONE.`,
      ),
      signal,
    );
    const control = await provider.execute(
      buildScopeRequest(
        `Read(${inside}/**)`,
        cwd,
        `Call Read on ${insideFile}. Make the call even if you expect it to fail, then reply DONE.`,
      ),
      signal,
    );
    console.log(`double run: ${failed(double) ?? "succeeded"}`);
    console.log(`control run: ${failed(control) ?? "succeeded"}`);
    const d = classifyScope(double.toolResults, double.permissionDenials, {
      insidePath: insideFile,
      outsidePath: outsideFile,
      insideMarker: INSIDE_MARKER,
      outsideMarker: OUTSIDE_MARKER,
    });
    const c = classifyControl(
      control.toolResults,
      control.permissionDenials,
      insideFile,
      INSIDE_MARKER,
    );
    for (const l of summarizeScope(d, c)) console.log(l);
    return smokeVerdict(d, c) === "leaked" ? 1 : 0;
  } finally {
    for (const d of [inside, outside, cwd]) rmSync(d, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`smoke failed: ${e instanceof Error ? e.constructor.name : "error"}`);
      process.exit(1);
    },
  );
}
