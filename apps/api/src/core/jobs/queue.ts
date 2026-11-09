import type { ClassifiedError, Job, JobStatus } from "@synapse/contracts";
import { type Db, type DbOrTx, schema, type Tx } from "@synapse/database";
import { type Clock, isoNow, newId } from "@synapse/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import { decideFailure, UNCERTAIN_EXTERNAL_ERROR } from "./retry";

export interface EnqueueInput {
  type: string;
  input?: unknown;
  idempotencyKey: string;
  /** higher runs first, default 100 */
  priority?: number;
  runAfter?: string;
  maxAttempts?: number;
  concurrencyGroup?: string;
  /** Writes to an external system: an uncertain outcome goes to NEEDS_ATTENTION, not RETRY. */
  externalWrite?: boolean;
}

const { jobs, jobAttempts, jobCheckpoints } = schema;

export class JobQueue {
  private readonly random: (() => number) | undefined;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    opts: { random?: () => number } = {},
  ) {
    this.random = opts.random;
  }

  enqueue(tx: DbOrTx, input: EnqueueInput): { id: string; created: boolean } {
    const now = isoNow(this.clock);
    const id = newId();
    const inserted = tx
      .insert(jobs)
      .values({
        id,
        type: input.type,
        priority: input.priority ?? 100,
        input: input.input ?? null,
        maxAttempts: input.maxAttempts ?? 3,
        idempotencyKey: input.idempotencyKey,
        concurrencyGroup: input.concurrencyGroup ?? null,
        externalWrite: input.externalWrite ?? false,
        runAfter: input.runAfter ?? now,
        createdAt: now,
      })
      .onConflictDoNothing({ target: jobs.idempotencyKey })
      .returning({ id: jobs.id })
      .all();
    if (inserted.length > 0) return { id, created: true };
    const existing = tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(eq(jobs.idempotencyKey, input.idempotencyKey))
      .get();
    if (!existing) throw new Error(`job ${input.idempotencyKey} vanished during enqueue`);
    return { id: existing.id, created: false };
  }

  /**
   * Shutdown: expires the leases of this worker's RUNNING jobs so startup recovery reclaims them
   * at once, under its existing external-write rules.
   */
  expireLeasesOwnedBy(workerId: string): number {
    const now = this.clock.now().toISOString();
    const escaped = workerId.replace(/[\\%_]/g, "\\$&");
    return this.db.all<{ id: string }>(
      sql`UPDATE jobs SET lease_expires_at = ${now}
            WHERE status = 'RUNNING' AND lease_owner LIKE ${`${escaped}:%`} ESCAPE '\\'
            RETURNING id`,
    ).length;
  }

  /**
   * Leases the next job to `workerId`. The lease owner is a per-claim token
   * (`${workerId}:${newId()}`, returned as `job.leaseOwner`), so a stale holder cannot act on a
   * job its own worker later re-claims.
   */
  claim(workerId: string, leaseMs: number, types: string[]): Job | null {
    if (types.length === 0) return null;
    const nowDate = this.clock.now();
    const now = nowDate.toISOString();
    const leaseExpiresAt = new Date(nowDate.getTime() + leaseMs).toISOString();
    const owner = `${workerId}:${newId()}`;
    return this.db.transaction(
      (tx) => {
        const rows = tx.all<{ id: string; attempts: number }>(sql`
        UPDATE jobs
        SET status = 'RUNNING', lease_owner = ${owner}, lease_expires_at = ${leaseExpiresAt},
            attempts = attempts + 1, started_at = ${now}
        WHERE id = (
          SELECT j.id FROM jobs j
          WHERE j.status IN ('PENDING', 'RETRY')
            AND j.run_after <= ${now}
            AND j.type IN (${sql.join(
              types.map((t) => sql`${t}`),
              sql`, `,
            )})
            AND NOT EXISTS (
              SELECT 1 FROM jobs r
              WHERE r.status = 'RUNNING' AND r.concurrency_group = j.concurrency_group
            )
          ORDER BY j.priority DESC, j.run_after, j.created_at
          LIMIT 1
        )
        RETURNING id, attempts`);
        const row = rows[0];
        if (!row) return null;
        tx.insert(jobAttempts)
          .values({
            id: newId(),
            jobId: row.id,
            attempt: row.attempts,
            startedAt: now,
            status: "running",
          })
          .run();
        return this.getIn(tx, row.id);
      },
      { behavior: "immediate" },
    );
  }

  heartbeat(jobId: string, owner: string, leaseMs: number): boolean {
    const leaseExpiresAt = new Date(this.clock.now().getTime() + leaseMs).toISOString();
    const res = this.db
      .update(jobs)
      .set({ leaseExpiresAt })
      .where(this.owned(jobId, owner))
      .returning({ id: jobs.id })
      .all();
    return res.length > 0;
  }

  complete(jobId: string, owner: string, output?: unknown): boolean {
    const now = isoNow(this.clock);
    return this.db.transaction(
      (tx) => {
        const res = tx
          .update(jobs)
          .set({
            status: "COMPLETED",
            output: output ?? null,
            finishedAt: now,
            leaseOwner: null,
            leaseExpiresAt: null,
          })
          .where(this.owned(jobId, owner))
          .returning({ id: jobs.id })
          .all();
        if (res.length === 0) return false;
        this.closeAttempt(tx, jobId, "completed", now, null);
        return true;
      },
      { behavior: "immediate" },
    );
  }

  fail(jobId: string, owner: string, error: ClassifiedError): JobStatus {
    const nowDate = this.clock.now();
    const now = nowDate.toISOString();
    return this.db.transaction(
      (tx) => {
        const job = tx.select().from(jobs).where(this.owned(jobId, owner)).get();
        if (!job) return this.currentStatus(tx, jobId);
        const outcome = decideFailure(error, job.attempts, job.maxAttempts, nowDate, this.random);
        if (outcome.status === "DEFER") {
          this.deferIn(tx, jobId, outcome.runAfter, now, error);
          return "PENDING";
        }
        const terminal = outcome.status !== "RETRY";
        tx.update(jobs)
          .set({
            status: outcome.status,
            lastError: error,
            leaseOwner: null,
            leaseExpiresAt: null,
            ...("runAfter" in outcome ? { runAfter: outcome.runAfter } : {}),
            ...(terminal ? { finishedAt: now } : {}),
          })
          .where(eq(jobs.id, jobId))
          .run();
        this.closeAttempt(tx, jobId, "failed", now, error);
        return outcome.status;
      },
      { behavior: "immediate" },
    );
  }

  /**
   * The outcome of an owned external-write job is unknown (timeout, forced stop): park it in
   * NEEDS_ATTENTION instead of retrying. The attempt keeps the original cause.
   */
  failUncertain(jobId: string, owner: string, cause: ClassifiedError): JobStatus {
    const now = isoNow(this.clock);
    return this.db.transaction(
      (tx) => {
        const res = tx
          .update(jobs)
          .set({
            status: "NEEDS_ATTENTION",
            lastError: UNCERTAIN_EXTERNAL_ERROR,
            leaseOwner: null,
            leaseExpiresAt: null,
            finishedAt: now,
          })
          .where(this.owned(jobId, owner))
          .returning({ id: jobs.id })
          .all();
        if (res.length === 0) return this.currentStatus(tx, jobId);
        this.closeAttempt(tx, jobId, "failed", now, cause);
        return "NEEDS_ATTENTION";
      },
      { behavior: "immediate" },
    );
  }

  defer(jobId: string, owner: string, runAfter: string): void {
    const now = isoNow(this.clock);
    this.db.transaction(
      (tx) => {
        if (!tx.select({ id: jobs.id }).from(jobs).where(this.owned(jobId, owner)).get()) return;
        this.deferIn(tx, jobId, runAfter, now, null);
      },
      { behavior: "immediate" },
    );
  }

  /** Sets external_write = 1 on a job the caller still owns; false if the lease is not theirs. */
  markExternalWrite(jobId: string, owner: string): boolean {
    return (
      this.db
        .update(jobs)
        .set({ externalWrite: true })
        .where(this.owned(jobId, owner))
        .returning({ id: jobs.id })
        .all().length > 0
    );
  }

  /** Stores the checkpoint only while `owner` still holds the lease; returns whether it did. */
  checkpoint(jobId: string, owner: string, data: unknown): boolean {
    const now = isoNow(this.clock);
    return this.db.transaction(
      (tx) => {
        if (!tx.select({ id: jobs.id }).from(jobs).where(this.owned(jobId, owner)).get())
          return false;
        const existing = tx
          .select({ id: jobCheckpoints.id })
          .from(jobCheckpoints)
          .where(eq(jobCheckpoints.jobId, jobId))
          .get();
        if (existing) {
          tx.update(jobCheckpoints)
            .set({ checkpoint: data, updatedAt: now })
            .where(eq(jobCheckpoints.id, existing.id))
            .run();
        } else {
          tx.insert(jobCheckpoints)
            .values({ id: newId(), jobId, checkpoint: data, updatedAt: now })
            .run();
        }
        return true;
      },
      { behavior: "immediate" },
    );
  }

  getCheckpoint<T>(jobId: string): T | undefined {
    const row = this.db
      .select({ checkpoint: jobCheckpoints.checkpoint })
      .from(jobCheckpoints)
      .where(eq(jobCheckpoints.jobId, jobId))
      .get();
    return row ? (row.checkpoint as T) : undefined;
  }

  cancel(jobId: string): boolean {
    const res = this.db
      .update(jobs)
      .set({ status: "CANCELLED", finishedAt: isoNow(this.clock) })
      .where(and(eq(jobs.id, jobId), sql`${jobs.status} IN ('PENDING', 'RETRY')`))
      .returning({ id: jobs.id })
      .all();
    return res.length > 0;
  }

  /**
   * Closes the parked (NEEDS_ATTENTION) jobs of `type` after the user resolved what they waited
   * for: they become CANCELLED so the health check and retention stop counting them. Runs in the
   * caller's transaction; returns how many were moved.
   */
  resolveParked(tx: DbOrTx, type: string): number {
    return tx
      .update(jobs)
      .set({ status: "CANCELLED", finishedAt: isoNow(this.clock) })
      .where(and(eq(jobs.type, type), eq(jobs.status, "NEEDS_ATTENTION")))
      .returning({ id: jobs.id })
      .all().length;
  }

  get(id: string): Job | null {
    return this.getIn(this.db, id);
  }

  /** `order`: "claim" (default) is the order jobs are claimed in; "newest" is by created_at desc. */
  list(filter: { status?: JobStatus; limit?: number; order?: "claim" | "newest" } = {}): Job[] {
    const q = this.db.select().from(jobs);
    const filtered = filter.status ? q.where(eq(jobs.status, filter.status)) : q;
    const order =
      filter.order === "newest"
        ? [desc(jobs.createdAt), desc(sql`rowid`)]
        : [desc(jobs.priority), jobs.runAfter, jobs.createdAt];
    return filtered
      .orderBy(...order)
      .limit(filter.limit ?? 100)
      .all()
      .map(toJob);
  }

  private owned(jobId: string, owner: string) {
    return and(eq(jobs.id, jobId), eq(jobs.status, "RUNNING"), eq(jobs.leaseOwner, owner));
  }

  private getIn(tx: DbOrTx, id: string): Job | null {
    const row = tx.select().from(jobs).where(eq(jobs.id, id)).get();
    return row ? toJob(row) : null;
  }

  private currentStatus(tx: DbOrTx, jobId: string): JobStatus {
    const row = tx.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, jobId)).get();
    if (!row) throw new Error(`job ${jobId} not found`);
    return row.status;
  }

  private deferIn(
    tx: Tx,
    jobId: string,
    runAfter: string,
    now: string,
    error: ClassifiedError | null,
  ): void {
    tx.update(jobs)
      .set({
        status: "PENDING",
        attempts: sql`${jobs.attempts} - 1`,
        runAfter,
        leaseOwner: null,
        leaseExpiresAt: null,
        ...(error ? { lastError: error } : {}),
      })
      .where(eq(jobs.id, jobId))
      .run();
    this.closeAttempt(tx, jobId, "deferred", now, error);
  }

  private closeAttempt(
    tx: Tx,
    jobId: string,
    status: string,
    now: string,
    error: ClassifiedError | null,
  ): void {
    tx.update(jobAttempts)
      .set({ finishedAt: now, status, error })
      .where(and(eq(jobAttempts.jobId, jobId), eq(jobAttempts.status, "running")))
      .run();
  }
}

function toJob(r: typeof jobs.$inferSelect): Job {
  return {
    id: r.id,
    type: r.type,
    priority: r.priority,
    status: r.status,
    input: r.input,
    attempts: r.attempts,
    maxAttempts: r.maxAttempts,
    idempotencyKey: r.idempotencyKey,
    concurrencyGroup: r.concurrencyGroup,
    externalWrite: r.externalWrite,
    runAfter: r.runAfter,
    leaseOwner: r.leaseOwner,
    leaseExpiresAt: r.leaseExpiresAt,
    lastError: (r.lastError as ClassifiedError | null) ?? null,
    createdAt: r.createdAt,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
  };
}
