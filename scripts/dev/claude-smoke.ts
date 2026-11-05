import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AIExecutionResult, ClaudeJobRequest, ConnectorStatus } from "@synapse/contracts";
import { z } from "zod";
import { createContainer } from "../../apps/api/src/container";
import { loadConfig } from "../../apps/api/src/core/config/config";

export type SmokeMode = "no-tools" | "deny-check" | "help";

export const USAGE = `Usage: bun scripts/dev/claude-smoke.ts [--no-tools | --deny-check | --help]

Runs ONE real Claude request on a temporary database. Spends a tiny amount of
Claude quota; run deliberately. Prints ids, counts and statuses, never content.

  --no-tools    (default) intelligence request replying {"ok":true}
  --deny-check  collector request; verifies the Gmail connector is connected at init
                yet no mcp__claude_ai_Gmail tool is listed (read-only, no Slack call)
  --help        print this text`;

export function parseArgs(argv: string[]): { mode: SmokeMode } {
  let mode: SmokeMode | undefined;
  for (const a of argv) {
    let next: SmokeMode;
    if (a === "--no-tools") next = "no-tools";
    else if (a === "--deny-check") next = "deny-check";
    else if (a === "--help" || a === "-h") next = "help";
    else throw new Error(`unknown argument: ${a}`);
    if (mode && mode !== next) throw new Error("conflicting flags");
    mode = next;
  }
  return { mode: mode ?? "no-tools" };
}

/** Formats ids, statuses and counts only. Never finalText or tool result content. */
export function summarize(r: AIExecutionResult, runId?: string): string[] {
  const lines = [
    ...(runId ? [`runId: ${runId}`] : []),
    `status: ${r.status}`,
    `turns: ${r.numTurns}`,
    `durationMs: ${r.durationMs}`,
    `tokens: in=${r.usage.inputTokens} out=${r.usage.outputTokens} cacheCreate=${r.usage.cacheCreationInputTokens} cacheRead=${r.usage.cacheReadInputTokens}`,
    `toolResults: ${r.toolResults.length}`,
    `availableTools: ${r.availableTools.length}`,
    `permissionDenials: ${r.permissionDenials.length}`,
    `exitCode: ${r.exitCode}`,
  ];
  if (r.quota) {
    const w = (x: { utilization: number; status: string } | undefined) =>
      x ? `${x.utilization} (${x.status})` : "absent";
    lines.push(`quota fiveHour: ${w(r.quota.fiveHour)}`, `quota sevenDay: ${w(r.quota.sevenDay)}`);
  }
  for (const c of r.connectors) lines.push(`connector: ${c.name} = ${c.status}`);
  if (r.error) lines.push(`error: ${r.error.kind}`);
  return lines;
}

export type DenyVerdict = "PASS" | "FAIL" | "INCONCLUSIVE";

/**
 * R34: PASS iff the Gmail connector is `connected` at init and no Gmail tool is listed (the
 * server-level deny removed them); FAIL if any Gmail tool is listed; otherwise INCONCLUSIVE.
 */
export function denyVerdict(tools: string[], connectors: ConnectorStatus[]): DenyVerdict {
  if (tools.some((t) => t.startsWith("mcp__claude_ai_Gmail"))) return "FAIL";
  const gmail = connectors.find((c) => c.name === "claude.ai Gmail");
  return gmail?.status === "connected" ? "PASS" : "INCONCLUSIVE";
}

/** --deny-check exit code: non-zero on FAIL, or when the run itself did not succeed. */
export function exitCodeFor(verdict: DenyVerdict, status: AIExecutionResult["status"]): number {
  return verdict === "FAIL" || status !== "succeeded" ? 1 : 0;
}

const SLACK_READ = "mcp__claude_ai_Slack__slack_search_users";

async function main(): Promise<number> {
  const { mode } = parseArgs(process.argv.slice(2));
  if (mode === "help") {
    console.log(USAGE);
    return 0;
  }
  const dir = mkdtempSync(join(tmpdir(), "synapse-smoke-"));
  const config = { ...loadConfig(process.env), dbPath: join(dir, "smoke.db") };
  const c = createContainer(config);
  const signal = new AbortController().signal;
  try {
    let result: AIExecutionResult;
    if (mode === "no-tools") {
      const req: ClaudeJobRequest = {
        workerProfile: "intelligence",
        priorityClass: "batch",
        instructions: 'Reply with exactly {"ok":true}',
        allowedTools: ["ToolSearch"],
        maxTurns: 3,
      };
      ({ result } = await c.orchestrator.runStructured(
        req,
        z.object({ ok: z.literal(true) }),
        signal,
      ));
    } else {
      const req: ClaudeJobRequest = {
        workerProfile: "collector",
        priorityClass: "collection",
        instructions: "Do not call any tools. Reply DONE.",
        allowedTools: [SLACK_READ],
        maxTurns: 2,
      };
      result = await c.orchestrator.run(req, signal);
    }
    for (const line of summarize(result)) console.log(line);
    if (mode === "deny-check") {
      const v = denyVerdict(result.availableTools, result.connectors);
      console.log(`deny-check: ${v}`);
      return exitCodeFor(v, result.status);
    }
    return result.status === "succeeded" ? 0 : 1;
  } finally {
    c.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
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
