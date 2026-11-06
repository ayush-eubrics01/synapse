import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeJobRequest, RawToolResult } from "@synapse/contracts";
import { createContainer } from "../../apps/api/src/container";
import { loadConfig } from "../../apps/api/src/core/config/config";

const TOOL = "mcp__claude_ai_Slack__slack_search_users";
const REASON = "send arguments differ from the approved message";

export type HookSmokeVerdict = "blocked" | "not_blocked" | "inconclusive";

/**
 * A15: not blocked if the guarded tool returned a non-error result; blocked if it did not and
 * the run shows a permission denial for it or an error result carrying the guard reason;
 * otherwise inconclusive (for example the model never called the tool).
 */
export function classifyHookSmoke(r: {
  toolResults: RawToolResult[];
  permissionDenials: unknown[];
}): HookSmokeVerdict {
  const forTool = r.toolResults.filter((t) => t.toolName === TOOL);
  if (forTool.some((t) => !t.isError)) return "not_blocked";
  const denied = r.permissionDenials.includes(TOOL);
  const reasoned = forTool.some((t) => t.isError && t.content.includes(REASON));
  return denied || reasoned ? "blocked" : "inconclusive";
}

async function main(): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), "synapse-hook-smoke-"));
  const c = createContainer({ ...loadConfig(process.env), dbPath: join(dir, "smoke.db") });
  try {
    const req: ClaudeJobRequest = {
      workerProfile: "collector",
      priorityClass: "collection",
      instructions: `Call ${TOOL} exactly once with query "synapse-hook-smoke". Then reply DONE.`,
      allowedTools: [TOOL, "ToolSearch"],
      maxTurns: 5,
      sendGuard: { toolName: TOOL, expectedInputSha256: "0".repeat(64) },
    };
    const result = await c.orchestrator.run(req, new AbortController().signal);
    const verdict = classifyHookSmoke(result);
    console.log(`status: ${result.status}`);
    console.log(`toolResults: ${result.toolResults.length}`);
    console.log(`permissionDenials: ${result.permissionDenials.length}`);
    console.log(`hook-smoke: ${verdict === "not_blocked" ? "NOT BLOCKED" : verdict}`);
    return verdict === "not_blocked" ? 1 : 0;
  } finally {
    c.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`hook-smoke failed: ${e instanceof Error ? e.constructor.name : "error"}`);
      process.exit(1);
    },
  );
}
