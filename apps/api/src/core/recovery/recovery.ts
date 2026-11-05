import type { ClassifiedError } from "@synapse/contracts";
import { type Db, schema, type Tx } from "@synapse/database";
import { type Clock, isoNow } from "@synapse/shared";
import { and, eq, lte, ne } from "drizzle-orm";
import type { AuditLogger } from "../audit/audit";
import { isExternalWrite, UNCERTAIN_EXTERNAL_ERROR } from "../jobs/retry";
import type { LeaseService } from "../leases/leases";

const { jobs, jobAttempts, leases } = schema;

const MAX_ATTEMPTS_ERROR: ClassifiedError = {
  kind: "unknown",
  message: "interrupted after max attempts",
};

/** Reaper period. Must stay well below the worker lease (60 s) so orphans are reclaimed quickly. */
export const REAP_INTERVAL_MS = 30_000;

export interface RecoveredJobs {
  requeued: number;
  needsAttention: number;
}

/**
 * Reclaims RUNNING jobs whose lease expired (the owning worker died or stalled). A live owner
 * notices on its next heartbeat or settle, which check ownership, and aborts. External-write jobs
 * and jobs out of attempts go to NEEDS_ATTENTION; everything else is retried now.
 */
export function recoverExpiredJobs(tx: Tx, now: string): RecoveredJobs {
  const stuck = tx
    .select()
    .from(jobs)
    .where(and(eq(jobs.status, "RUNNING"), lte(jobs.leaseExpiresAt, now)))
    .all();
  let requeued = 0;
  let needsAttention = 0;
  for (const job of stuck) {
    const parkedWith = isExternalWrite(job)
      ? UNCERTAIN_EXTERNAL_ERROR
      : job.attempts >= job.maxAttempts
        ? MAX_ATTEMPTS_ERROR
        : null;
    tx.update(jobs)
      .set(
        parkedWith
          ? {
              status: "NEEDS_ATTENTION",
              lastError: parkedWith,
              leaseOwner: null,
              leaseExpiresAt: null,
              finishedAt: now,
            }
          : { status: "RETRY", runAfter: now, leaseOwner: null, leaseExpiresAt: null },
      )
      .where(and(eq(jobs.id, job.id), eq(jobs.status, "RUNNING")))
      .run();
    tx.update(jobAttempts)
      .set({ finishedAt: now, status: "interrupted" })
      .where(and(eq(jobAttempts.jobId, job.id), eq(jobAttempts.status, "running")))
      .run();
    if (parkedWith) needsAttention++;
    else requeued++;
  }
  return { requeued, needsAttention };
}

export function recoverOnStartup(deps: {
  db: Db;
  clock: Clock;
  leases: LeaseService;
  audit: AuditLogger;
}): { requeued: number; needsAttention: number; leasesReleased: number } {
  const { db, clock, audit } = deps;
  const now = isoNow(clock);
  return db.transaction(
    (tx) => {
      const recovered = recoverExpiredJobs(tx, now);
      const released = tx
        .delete(leases)
        .where(and(lte(leases.expiresAt, now), ne(leases.name, "engineering")))
        .returning({ name: leases.name })
        .all();
      const result = { ...recovered, leasesReleased: released.length };
      audit.record(tx, {
        actor: "system",
        module: "recovery",
        action: "startup_recovery",
        result: "ok",
        details: result,
      });
      return result;
    },
    { behavior: "immediate" },
  );
}

/** Periodic in-process recovery of expired RUNNING jobs. Audits only when it reclaimed something. */
export function reapExpiredJobs(deps: { db: Db; clock: Clock; audit: AuditLogger }): RecoveredJobs {
  const { db, clock, audit } = deps;
  const now = isoNow(clock);
  return db.transaction(
    (tx) => {
      const result = recoverExpiredJobs(tx, now);
      if (result.requeued + result.needsAttention > 0) {
        audit.record(tx, {
          actor: "system",
          module: "recovery",
          action: "reap_expired_jobs",
          result: "ok",
          details: { ...result },
        });
      }
      return result;
    },
    { behavior: "immediate" },
  );
}

/**
 * Marks every claude_runs row still `running` as failed. Called once at startup: no run can
 * outlive the process that spawned it. Returns the number of rows swept.
 */
export function recoverOrphanRuns(db: Db, clock: Clock): number {
  const rows = db
    .update(schema.claudeRuns)
    .set({
      status: "failed",
      error: { kind: "unknown", message: "interrupted by restart" },
      finishedAt: isoNow(clock),
    })
    .where(eq(schema.claudeRuns.status, "running"))
    .returning({ id: schema.claudeRuns.id })
    .all();
  return rows.length;
}
