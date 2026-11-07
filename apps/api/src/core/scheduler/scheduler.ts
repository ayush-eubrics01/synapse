import { type Db, schema } from "@synapse/database";
import { type Clock, isoNow, newId } from "@synapse/shared";
import { Cron } from "croner";
import { and, eq, inArray, isNotNull, lte } from "drizzle-orm";
import type { JobQueue } from "../jobs/queue";

export interface ScheduleInput {
  name: string;
  jobType: string;
  intervalSeconds?: number;
  cron?: string;
  input?: unknown;
  enabled?: boolean;
  priority?: number;
  /**
   * R58: when true, a tick enqueues nothing while a PENDING/RETRY/RUNNING job of the same type
   * exists (nextRunAt still advances), so deferrals never build a backlog. Held in memory: every
   * schedule is re-registered at startup, so no column is needed.
   */
  coalesce?: boolean;
}

const { scheduledTasks, jobs } = schema;
const LIVE_STATUSES = ["PENDING", "RETRY", "RUNNING"] as const;

export class SchedulerService {
  private readonly coalesced = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly queue: JobQueue,
  ) {}

  upsert(s: ScheduleInput): void {
    const hasInterval = s.intervalSeconds !== undefined;
    const hasCron = s.cron !== undefined;
    if (hasInterval === hasCron) {
      throw new Error(`schedule ${s.name}: exactly one of intervalSeconds or cron is required`);
    }
    if (hasInterval && !(Number.isInteger(s.intervalSeconds) && (s.intervalSeconds ?? 0) > 0)) {
      throw new Error(`schedule ${s.name}: intervalSeconds must be a positive integer`);
    }
    if (s.cron !== undefined) new Cron(s.cron, { timezone: "UTC" }); // throws if invalid
    const intervalSeconds = s.intervalSeconds ?? null;
    const cron = s.cron ?? null;
    const now = isoNow(this.clock);
    if (s.coalesce) this.coalesced.add(s.name);
    else this.coalesced.delete(s.name);

    this.db.transaction(
      (tx) => {
        const existing = tx
          .select()
          .from(scheduledTasks)
          .where(eq(scheduledTasks.name, s.name))
          .get();
        const fields = {
          jobType: s.jobType,
          intervalSeconds,
          cron,
          input: s.input ?? null,
          enabled: s.enabled ?? true,
          priority: s.priority ?? 100,
        };
        if (!existing) {
          tx.insert(scheduledTasks)
            .values({ id: newId(), name: s.name, ...fields, nextRunAt: now })
            .run();
          return;
        }
        const timingChanged =
          existing.intervalSeconds !== intervalSeconds || existing.cron !== cron;
        tx.update(scheduledTasks)
          .set({ ...fields, ...(timingChanged ? { nextRunAt: now } : {}) })
          .where(eq(scheduledTasks.id, existing.id))
          .run();
      },
      { behavior: "immediate" },
    );
  }

  /** Makes an enabled schedule due on the next tick. False when no enabled row has that name. */
  runNow(name: string): boolean {
    const now = isoNow(this.clock);
    return this.db.transaction(
      (tx) => {
        const row = tx
          .select({ id: scheduledTasks.id })
          .from(scheduledTasks)
          .where(and(eq(scheduledTasks.name, name), eq(scheduledTasks.enabled, true)))
          .get();
        if (!row) return false;
        tx.update(scheduledTasks)
          .set({ nextRunAt: now })
          .where(eq(scheduledTasks.id, row.id))
          .run();
        return true;
      },
      { behavior: "immediate" },
    );
  }

  /** Enqueue each due task once; reschedule from now so downtime never causes a catch-up storm. */
  tick(): number {
    const nowDate = this.clock.now();
    const now = nowDate.toISOString();
    const due = this.db
      .select()
      .from(scheduledTasks)
      .where(
        and(
          eq(scheduledTasks.enabled, true),
          isNotNull(scheduledTasks.nextRunAt),
          lte(scheduledTasks.nextRunAt, now),
        ),
      )
      .all();
    let enqueued = 0;
    for (const task of due) {
      const done = this.db.transaction(
        (tx) => {
          const fresh = tx
            .select()
            .from(scheduledTasks)
            .where(eq(scheduledTasks.id, task.id))
            .get();
          if (!fresh?.enabled || !fresh.nextRunAt || fresh.nextRunAt > now) return false;
          const skip =
            this.coalesced.has(fresh.name) &&
            tx
              .select({ id: jobs.id })
              .from(jobs)
              .where(and(eq(jobs.type, fresh.jobType), inArray(jobs.status, [...LIVE_STATUSES])))
              .limit(1)
              .all().length > 0;
          if (!skip) {
            this.queue.enqueue(tx, {
              type: fresh.jobType,
              input: fresh.input,
              priority: fresh.priority,
              idempotencyKey: `sched:${fresh.name}:${fresh.nextRunAt}`,
            });
          }
          let next: Date | null;
          if (fresh.cron) {
            next = new Cron(fresh.cron, { timezone: "UTC" }).nextRun(nowDate);
          } else {
            next = new Date(nowDate.getTime() + (fresh.intervalSeconds ?? 0) * 1000);
          }
          tx.update(scheduledTasks)
            .set({
              nextRunAt: next ? next.toISOString() : null,
              ...(skip ? {} : { lastRunAt: now }),
            })
            .where(eq(scheduledTasks.id, fresh.id))
            .run();
          return !skip;
        },
        { behavior: "immediate" },
      );
      if (done) enqueued++;
    }
    return enqueued;
  }
}
