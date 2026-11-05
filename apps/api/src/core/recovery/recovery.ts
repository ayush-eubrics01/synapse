import type { ClassifiedError } from "@synapse/contracts";
import { type Db, schema } from "@synapse/database";
import { type Clock, isoNow } from "@synapse/shared";
import { and, eq, lte, ne } from "drizzle-orm";
import type { AuditLogger } from "../audit/audit";
import type { LeaseService } from "../leases/leases";

const { jobs, jobAttempts, leases } = schema;

const EXTERNAL_WRITE_ERROR: ClassifiedError = {
  kind: "unknown",
  message: "verify external outcome before retry",
};

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
      const stuck = tx
        .select()
        .from(jobs)
        .where(and(eq(jobs.status, "RUNNING"), lte(jobs.leaseExpiresAt, now)))
        .all();
      let requeued = 0;
      let needsAttention = 0;
      for (const job of stuck) {
        const external = (job.input as { externalWrite?: unknown } | null)?.externalWrite === true;
        tx.update(jobs)
          .set(
            external
              ? {
                  status: "NEEDS_ATTENTION",
                  lastError: EXTERNAL_WRITE_ERROR,
                  leaseOwner: null,
                  leaseExpiresAt: null,
                  finishedAt: now,
                }
              : { status: "RETRY", runAfter: now, leaseOwner: null, leaseExpiresAt: null },
          )
          .where(eq(jobs.id, job.id))
          .run();
        tx.update(jobAttempts)
          .set({ finishedAt: now, status: "interrupted" })
          .where(and(eq(jobAttempts.jobId, job.id), eq(jobAttempts.status, "running")))
          .run();
        if (external) needsAttention++;
        else requeued++;
      }
      const released = tx
        .delete(leases)
        .where(and(lte(leases.expiresAt, now), ne(leases.name, "engineering")))
        .returning({ name: leases.name })
        .all();
      const result = { requeued, needsAttention, leasesReleased: released.length };
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
