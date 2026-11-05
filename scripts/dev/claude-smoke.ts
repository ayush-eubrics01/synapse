import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AIExecutionResult, ClaudeJobRequest } from "@synapse/contracts";
import { z } from "zod";
import { createContainer } from "../../apps/api/src/container";
import { loadConfig } from "../../apps/api/src/core/config/config";

export type SmokeMode = "no-tools" | "deny-check" | "help";

export const USAGE = `Usage: bun scripts/dev/claude-smoke.ts [--no-tools | --deny-check | --help]

Runs ONE real Claude request on a temporary database. Spends a tiny amount of
Claude quota; run deliberately. Prints ids, counts and statuses, never content.

  --no-tools    (default) intelligence request replying {"ok":true}
  --deny-check  collector request; verifies no mcp__claude_ai_Gmail tool is listed
                at init and that Slack tools are (read-only, no Slack call)
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
    lines.push(
      `quota fiveHour: ${r.quota.fiveHour.utilization} (${r.quota.fiveHour.status})`,
      `quota sevenDay: ${r.quota.sevenDay.utilization} (${r.quota.sevenDay.status})`,
    );
  }
  for (const c of r.connectors) lines.push(`connector: ${c.name} = ${c.status}`);
  if (r.error) lines.push(`error: ${r.error.kind}`);
  return lines;
}

export type DenyVerdict = "PASS" | "FAIL" | "INCONCLUSIVE";

export function denyVerdict(tools: string[]): DenyVerdict {
  if (tools.some((t) => t.startsWith("mcp__claude_ai_Gmail"))) return "FAIL";
  return tools.some((t) => t.startsWith("mcp__claude_ai_Slack__")) ? "PASS" : "INCONCLUSIVE";
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
      ({ result } = await c.orchestrator.runStructured(req, z.object({ ok: z.literal(true) })));
    } else {
      const req: ClaudeJobRequest = {
        workerProfile: "collector",
        priorityClass: "collection",
        instructions: "Do not call any tools. Reply DONE.",
        allowedTools: [SLACK_READ],
        maxTurns: 2,
      };
      result = await c.orchestrator.run(req);
    }
    for (const line of summarize(result)) console.log(line);
    if (mode === "deny-check") {
      const v = denyVerdict(result.availableTools);
      console.log(`deny-check: ${v}`);
      return v === "FAIL" ? 1 : 0;
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
