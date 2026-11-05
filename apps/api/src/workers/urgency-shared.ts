import { type ClassifiedError, JobError } from "@synapse/contracts";
import { type Db, schema } from "@synapse/database";
import { desc, eq, sql } from "drizzle-orm";
import { classifyTool } from "../core/orchestrator/tool-catalog";
import type { SecurityFlagsService } from "../modules/security-flags/service";

const { claudeRuns } = schema;

/** Helpers shared by the urgency Claude jobs (assess, suggest). */
export function createRunHelpers(db: Db, securityFlags: SecurityFlagsService) {
  const latestRunId = (jobId: string): string => {
    const row = db
      .select({ id: claudeRuns.id })
      .from(claudeRuns)
      .where(eq(claudeRuns.jobId, jobId))
      .orderBy(desc(claudeRuns.startedAt), sql`${claudeRuns}.rowid desc`)
      .limit(1)
      .get();
    if (!row) throw new JobError({ kind: "unknown", message: "claude run record unavailable" });
    return row.id;
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
    const severity = names.some((n) => {
      const c = classifyTool(n);
      return c === "write" || c === "builtin_write";
    })
      ? "high"
      : "warning";
    const parts: string[] = [];
    if (denied.length > 0) parts.push(`denied tools: ${[...new Set(denied)].join(", ")}`);
    if (used.length > 0) parts.push(`unexpected tools used: ${[...new Set(used)].join(", ")}`);
    const runId = latestRunId(jobId);
    db.transaction(
      (tx) => {
        securityFlags.recordRuntimeFlag(tx, messageIds, runId, parts.join("; "), severity);
      },
      { behavior: "immediate" },
    );
  };

  return { latestRunId, runtimeFlags };
}

/** Content-free wrapping: only the classified error survives, never a raw message. */
export function wrapFailure(err: unknown): { classified: ClassifiedError; rethrow: JobError } {
  const classified: ClassifiedError =
    err instanceof JobError
      ? err.classified
      : { kind: "unknown", message: "unexpected urgency assessment failure" };
  return { classified, rethrow: err instanceof JobError ? err : new JobError(classified) };
}
