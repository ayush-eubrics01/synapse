import type { SuspectedInjection } from "@synapse/contracts";
import { type ClassifiedError, JobError } from "@synapse/contracts";
import { type Db, schema } from "@synapse/database";
import { desc, eq, sql } from "drizzle-orm";
import { classifyTool } from "../core/orchestrator/tool-catalog";
import type { SecurityFlagsService } from "../modules/security-flags/service";

const { claudeRuns } = schema;

const MAX_TURNS_REASON = "max_turns reached";

const isWrite = (name: string) => {
  const c = classifyTool(name);
  return c === "write" || c === "builtin_write";
};

/** Helpers shared by the Claude jobs of every module (urgency, people). */
export function createRunHelpers(db: Db, securityFlags: SecurityFlagsService) {
  const latestRun = (jobId: string) =>
    db
      .select({ id: claudeRuns.id, permissionDenials: claudeRuns.permissionDenials })
      .from(claudeRuns)
      .where(eq(claudeRuns.jobId, jobId))
      .orderBy(desc(claudeRuns.startedAt), sql`${claudeRuns}.rowid desc`)
      .limit(1)
      .get();

  const latestRunId = (jobId: string): string => {
    const row = latestRun(jobId);
    if (!row) throw new JobError({ kind: "unknown", message: "claude run record unavailable" });
    return row.id;
  };

  /** The latest run id for the job, or null; taken before a run to recognise this attempt's row. */
  const runIdBefore = (jobId: string): string | null => latestRun(jobId)?.id ?? null;

  const record = (
    runId: string,
    messageIds: string[],
    parts: string[],
    severity: "warning" | "high",
  ) => {
    db.transaction(
      (tx) => {
        securityFlags.recordRuntimeFlag(tx, messageIds, runId, parts.join("; "), severity);
      },
      { behavior: "immediate" },
    );
  };

  /** Any permission denial or non-ToolSearch tool result raises runtime flags. Content-free reasons. */
  const runtimeFlags = (
    jobId: string,
    messageIds: string[],
    result: { permissionDenials: string[]; toolResults: { toolName: string }[] },
  ) => {
    const used = result.toolResults.map((t) => t.toolName).filter((n) => n !== "ToolSearch");
    const denied = result.permissionDenials;
    if (denied.length === 0 && used.length === 0) return;
    const names = [...new Set([...denied, ...used])];
    const parts: string[] = [];
    if (denied.length > 0) parts.push(`denied tools: ${[...new Set(denied)].join(", ")}`);
    if (used.length > 0) parts.push(`unexpected tools used: ${[...new Set(used)].join(", ")}`);
    record(latestRunId(jobId), messageIds, parts, names.some(isWrite) ? "high" : "warning");
  };

  /**
   * R16: the run threw (provider error, timeout, max turns), so there is no result to inspect. The
   * orchestrator still persisted `permission_denials` on this attempt's `claude_runs` row; a denial
   * raises a runtime flag (`high` for a write/send tool), and a max-turns stop a `warning` one.
   * Only a row newer than `before` counts, so an earlier attempt's denials are never re-read.
   */
  const failedRunFlags = (
    jobId: string,
    messageIds: string[],
    classified: ClassifiedError,
    before: string | null,
  ) => {
    const row = latestRun(jobId);
    if (!row || row.id === before) return;
    const denied = Array.isArray(row.permissionDenials)
      ? [...new Set(row.permissionDenials.filter((n): n is string => typeof n === "string"))]
      : [];
    const maxTurns = classified.details?.maxTurns === true;
    if (denied.length === 0 && !maxTurns) return;
    const parts: string[] = [];
    if (denied.length > 0) parts.push(`denied tools: ${denied.join(", ")}`);
    if (maxTurns) parts.push(MAX_TURNS_REASON);
    record(row.id, messageIds, parts, denied.some(isWrite) ? "high" : "warning");
  };

  return { latestRunId, runIdBefore, runtimeFlags, failedRunFlags };
}

/** Content-free wrapping: only the classified error survives, never a raw message. */
export function wrapFailure(err: unknown): { classified: ClassifiedError; rethrow: JobError } {
  const classified: ClassifiedError =
    err instanceof JobError
      ? err.classified
      : { kind: "unknown", message: "unexpected job failure" };
  return { classified, rethrow: err instanceof JobError ? err : new JobError(classified) };
}

/** Flag bookkeeping on a failure path must never replace the original error. */
export const safely = (fn: () => void) => {
  try {
    fn();
  } catch {
    console.error("claude job: runtime flag recording failed");
  }
};

/**
 * R5 flag attribution: the newest message of someone else (a "them" first), never the user's own.
 * Null when only the user's messages were provided; then no flag is recorded.
 */
export function flagTargetOf(items: { messageId: string; author: "them" | "self" | "other" }[]) {
  const newestBy = (ok: (a: "them" | "self" | "other") => boolean) =>
    items.findLast((i) => ok(i.author))?.messageId ?? null;
  return newestBy((a) => a === "them") ?? newestBy((a) => a !== "self");
}

/** R1/R5: the provided non-self message whose text holds the model's quote, else `fallback`. */
export function flaggedMessageOf(
  used: { messageId: string; author: "them" | "self" | "other"; text: string }[],
  s: SuspectedInjection,
  fallback: string | null,
): string | null {
  const quote = s.quote.trim();
  if (quote === "") return fallback;
  return used.find((i) => i.author !== "self" && i.text.includes(quote))?.messageId ?? fallback;
}
