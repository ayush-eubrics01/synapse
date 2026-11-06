import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeJobRequest, RawToolResult } from "@synapse/contracts";
import { createContainer } from "../../apps/api/src/container";
import { loadConfig } from "../../apps/api/src/core/config/config";
import { sendInputSha256 } from "../../apps/api/src/integrations/claude-code/send-guard";

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

/** `--allow` guards with the hash of the exact instructed input, so a correct call must pass. */
export const isAllowMode = (argv: string[]): boolean => argv.includes("--allow");

/** Exit code: deny mode passes when blocked; allow mode passes only when the call went through. */
export const smokeExitCode = (verdict: HookSmokeVerdict, allow: boolean): number =>
  allow ? (verdict === "not_blocked" ? 0 : 1) : verdict === "not_blocked" ? 1 : 0;

const QUERY = "synapse-hook-smoke";

async function main(allow: boolean): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), "synapse-hook-smoke-"));
  const c = createContainer({ ...loadConfig(process.env), dbPath: join(dir, "smoke.db") });
  try {
    const req: ClaudeJobRequest = {
      workerProfile: "collector",
      priorityClass: "collection",
      instructions: `Call ${TOOL} exactly once with exactly one argument, query "${QUERY}", and no other arguments. Then reply DONE.`,
      allowedTools: [TOOL, "ToolSearch"],
      maxTurns: 5,
      sendGuard: {
        toolName: TOOL,
        expectedInputSha256: allow ? sendInputSha256({ query: QUERY }) : "0".repeat(64),
      },
    };
    const result = await c.orchestrator.run(req, new AbortController().signal);
    const verdict = classifyHookSmoke(result);
    console.log(`status: ${result.status}`);
    console.log(`toolResults: ${result.toolResults.length}`);
    console.log(`permissionDenials: ${result.permissionDenials.length}`);
    const label = allow
      ? verdict === "not_blocked"
        ? "allowed"
        : `NOT ALLOWED (${verdict})`
      : verdict === "not_blocked"
        ? "NOT BLOCKED"
        : verdict;
    console.log(`hook-smoke${allow ? " --allow" : ""}: ${label}`);
    return smokeExitCode(verdict, allow);
  } finally {
    c.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  main(isAllowMode(process.argv.slice(2))).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`hook-smoke failed: ${e instanceof Error ? e.constructor.name : "error"}`);
      process.exit(1);
    },
  );
}
