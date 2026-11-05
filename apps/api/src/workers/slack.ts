import {
  type ClassifiedError,
  type CollectResult,
  type Job,
  JobError,
  type MessageSource,
  retryDecision,
} from "@synapse/contracts";
import { type Db, schema, type Tx } from "@synapse/database";
import { type Clock, isoNow } from "@synapse/shared";
import { and, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import type { AuditLogger } from "../core/audit/audit";
import type { SettingsService } from "../core/config/settings";
import type { EventPublisher } from "../core/events/publisher";
import type { JobQueue } from "../core/jobs/queue";
import type { HandlerRegistration, JobContext } from "../core/jobs/worker";
import type { SchedulerService } from "../core/scheduler/scheduler";
import type { InboxStore } from "../modules/inbox/store";
import type { SyncState, SyncStateService, SyncStream } from "../modules/inbox/sync-state";

export interface SlackJobDeps {
  db: Db;
  clock: Clock;
  source: MessageSource;
  store: InboxStore;
  sync: SyncStateService;
  queue: JobQueue;
  settings: SettingsService;
  events: EventPublisher;
  audit: AuditLogger;
  scheduler: SchedulerService;
  handlers: Map<string, HandlerRegistration>;
}

const HANDLER_TIMEOUT_MS = 300_000; // R36
const RETENTION_TIMEOUT_MS = 60_000;
const DAY_MS = 86_400_000;
const MIN_MS = 60_000;
const MAX_STALLS = 3;
const threadInput = z.object({ conversationId: z.string().min(1), parentTs: z.string().min(1) });

export const tsFromMs = (ms: number): string => (ms / 1000).toFixed(6);

export function registerSlackJobs(deps: SlackJobDeps): {
  startBackfill(): { started: boolean; state: SyncState; reason?: string };
} {
  const { db, clock, source, store, sync, queue, settings, events, audit, scheduler } = deps;
  const nowMs = () => clock.now().getTime();

  const isLive = (tx: Tx, type: string, statuses: string[]): boolean =>
    tx
      .select({ id: schema.jobs.id })
      .from(schema.jobs)
      .where(and(eq(schema.jobs.type, type), inArray(schema.jobs.status, statuses as never[])))
      .limit(1)
      .all().length > 0;

  /** auth_paused / quota_exhausted are pauses, not failures: no lastError, no event (R53). */
  const isPause = (e: ClassifiedError) => retryDecision(e.kind) === "defer";

  const recordFailure = (tx: Tx, stream: SyncStream, e: ClassifiedError, status?: "error") => {
    sync.update(tx, stream, {
      lastError: { kind: e.kind, message: e.message },
      ...(status ? { status } : {}),
    });
    events.publish(tx, {
      type: "collection.failed",
      aggregateType: "integration",
      aggregateId: stream,
      correlationId: stream,
      payload: { stream, kind: e.kind },
    });
  };

  /** Records the failure (unless a pause) and rethrows; `terminal` parks the backfill in "error". */
  const fail = (stream: SyncStream, err: unknown, terminal = false): never => {
    if (err instanceof JobError) {
      if (!isPause(err.classified)) {
        db.transaction(
          (tx) => recordFailure(tx, stream, err.classified, terminal ? "error" : undefined),
          {
            behavior: "immediate",
          },
        );
      }
    } else {
      db.transaction(
        (tx) =>
          recordFailure(
            tx,
            stream,
            { kind: "unknown", message: "unexpected collector failure" },
            terminal ? "error" : undefined,
          ),
        { behavior: "immediate" },
      );
    }
    throw err;
  };

  const persistAll = (stream: SyncStream, result: CollectResult) => {
    let inserted = 0;
    let duplicates = 0;
    let rejected = 0;
    for (const page of result.pages) {
      const r = store.persistPage(stream, page);
      inserted += r.inserted;
      duplicates += r.duplicates;
      rejected += page.rejected;
    }
    return { inserted, duplicates, rejected };
  };

  const incremental = async (job: Job, ctx: JobContext) => {
    if (!settings.get("slack.collection.enabled")) return { skipped: true };
    const stream: SyncStream = "slack.messages";
    // R52: don't pile up after deferrals.
    const last = sync.get(stream).lastSuccessAt;
    const halfMs = (settings.get("slack.collection.intervalSeconds") * 1000) / 2;
    if (last && nowMs() - Date.parse(last) < halfMs) return { skipped: "recent" };
    const otherRunning = db
      .select({ id: schema.jobs.id })
      .from(schema.jobs)
      .where(
        and(
          eq(schema.jobs.type, "slack.collect_incremental"),
          eq(schema.jobs.status, "RUNNING"),
          ne(schema.jobs.id, job.id ?? ""),
        ),
      )
      .limit(1)
      .all();
    if (otherRunning.length > 0) return { skipped: "running" };

    const afterTs = db.transaction(
      (tx) => {
        const cur = sync.get(stream, tx).checkpoint;
        if (cur !== null) {
          // R59: overlap by the index lag (dedup absorbs it); the checkpoint itself is unchanged.
          const lag = settings.get("slack.collection.indexLagSeconds");
          return tsFromMs(Math.max(0, Math.floor(Number(cur)) - lag) * 1000);
        }
        // First run: the init floor is used as is, never extended by the lag.
        const init = tsFromMs(nowMs() - DAY_MS);
        sync.update(tx, stream, { checkpoint: init });
        return init;
      },
      { behavior: "immediate" },
    );
    try {
      const result = await source.collect(
        {
          afterTs,
          maxPages: settings.get("slack.collector.pagesPerRun"),
          ...(job.id ? { jobId: job.id } : {}),
        },
        ctx.signal,
      );
      const totals = persistAll(stream, result);
      db.transaction(
        (tx) => {
          sync.countSearches(tx, stream, result.searches);
          sync.update(tx, stream, { lastSuccessAt: isoNow(clock), lastError: null });
          events.publish(tx, {
            type: "collection.completed",
            aggregateType: "integration",
            aggregateId: stream,
            correlationId: stream,
            payload: { stream, pages: result.pages.length, ...totals },
          });
        },
        { behavior: "immediate" },
      );
      return { pages: result.pages.length, ...totals, complete: result.complete };
    } catch (err) {
      return fail(stream, err);
    }
  };

  /**
   * Enqueues the next backfill run in the caller's transaction, unless one is already waiting (R51).
   * Key includes the generation so a resume never collides with an earlier chain.
   */
  const enqueueBackfill = (tx: Tx, state: SyncState, runAfterMs: number) => {
    if (isLive(tx, "slack.backfill", ["PENDING", "RETRY"])) return;
    const runAfter = new Date(runAfterMs).toISOString();
    queue.enqueue(tx, {
      type: "slack.backfill",
      idempotencyKey: `slack.backfill:${state.generation}:${state.checkpoint}:${state.pagesDone}:${runAfter}`,
      priority: 10,
      concurrencyGroup: "slack.backfill",
      runAfter,
    });
  };

  const backfill = async (job: Job, ctx: JobContext) => {
    const stream: SyncStream = "slack.backfill";
    const start = sync.get(stream);
    if (start.status !== "running" || start.checkpoint === null || start.upperBound === null) {
      return { skipped: true };
    }
    const minMinutes = settings.get("slack.backfill.minMinutesBetweenRuns");
    const maxBackoff = settings.get("slack.backfill.maxBackoffMinutes");
    let result: CollectResult;
    try {
      result = await source.collect(
        {
          afterTs: start.checkpoint,
          beforeTs: start.upperBound,
          maxPages: settings.get("slack.collector.pagesPerRun"),
          ...(job.id ? { jobId: job.id } : {}),
        },
        ctx.signal,
      );
    } catch (err) {
      if (!(err instanceof JobError)) return fail(stream, err, job.attempts >= job.maxAttempts);
      const e = err.classified;
      if (e.kind !== "rate_limited") {
        const d = retryDecision(e.kind);
        const terminal =
          d === "needs_attention" ||
          d === "fail" ||
          (d === "retry" && job.attempts >= job.maxAttempts);
        return fail(stream, err, terminal);
      }
      const backoffAt = db.transaction(
        (tx) => {
          const cur = sync.get(stream, tx);
          const backoff = Math.min(maxBackoff, Math.max(minMinutes, cur.backoffMinutes * 2));
          const retryAfterMs = e.retryAfter ? Date.parse(e.retryAfter) : 0;
          const runAfter = Math.max(
            Number.isNaN(retryAfterMs) ? 0 : retryAfterMs,
            nowMs() + backoff * MIN_MS,
          );
          sync.update(tx, stream, {
            backoffMinutes: backoff,
            status: "running",
            nextRunAfter: new Date(runAfter).toISOString(),
            lastError: { kind: e.kind, message: e.message },
          });
          enqueueBackfill(tx, sync.get(stream, tx), runAfter);
          return backoff;
        },
        { behavior: "immediate" },
      );
      return { deferred: true, backoffMinutes: backoffAt };
    }

    const totals = persistAll(stream, result);
    const lastPage = result.pages.at(-1);
    // R50: complete iff the last accepted page has no next cursor.
    const complete = lastPage ? !lastPage.nextCursor : result.complete;
    const outcome = db.transaction(
      (tx) => {
        sync.countSearches(tx, stream, result.searches);
        const cur = sync.get(stream, tx);
        const progressed = cur.checkpoint !== start.checkpoint;
        const stallCount = progressed ? 0 : cur.stallCount + 1;
        const stalled = !complete && stallCount >= MAX_STALLS;
        sync.update(tx, stream, {
          pagesDone: cur.pagesDone + result.pages.length,
          stallCount,
          backoffMinutes: 0,
          lastSuccessAt: isoNow(clock),
          lastError: stalled ? { kind: "unknown", message: "no progress after 3 runs" } : null,
          status: complete ? "complete" : stalled ? "error" : "running",
        });
        events.publish(tx, {
          type: "collection.completed",
          aggregateType: "integration",
          aggregateId: stream,
          correlationId: stream,
          payload: { stream, pages: result.pages.length, ...totals },
        });
        if (stalled) {
          events.publish(tx, {
            type: "collection.failed",
            aggregateType: "integration",
            aggregateId: stream,
            correlationId: stream,
            payload: { stream, kind: "unknown" },
          });
        } else if (!complete) {
          const runAfter = nowMs() + minMinutes * MIN_MS;
          sync.update(tx, stream, { nextRunAfter: new Date(runAfter).toISOString() });
          enqueueBackfill(tx, sync.get(stream, tx), runAfter);
        }
        return complete ? "complete" : stalled ? "stalled" : "continued";
      },
      { behavior: "immediate" },
    );
    return { pages: result.pages.length, ...totals, outcome };
  };

  const fetchThread = async (job: Job, ctx: JobContext) => {
    const parsed = threadInput.safeParse(job.input);
    if (!parsed.success) {
      throw new JobError({ kind: "invalid_input", message: "invalid slack.fetch_thread input" });
    }
    const { conversationId, parentTs } = parsed.data;
    const found = (
      await source.fetchThreads(
        [{ conversationId, parentTs, ...(job.id ? { jobId: job.id } : {}) }],
        ctx.signal,
      )
    ).find((t) => t.conversationId === conversationId && t.parentTs === parentTs);
    if (found) return store.storeThread(conversationId, found.messages);
    db.transaction(
      (tx) => {
        audit.record(tx, {
          actor: "system",
          module: "inbox",
          action: "slack.thread_unavailable",
          result: "missing",
          details: { conversationId, parentTs },
        });
      },
      { behavior: "immediate" },
    );
    return { unavailable: true };
  };

  const retention = async () => ({
    expired: store.expireContent(settings.get("retention.slackContentDays")),
  });

  deps.handlers.set("slack.collect_incremental", {
    handler: incremental,
    timeoutMs: HANDLER_TIMEOUT_MS,
  });
  deps.handlers.set("slack.backfill", { handler: backfill, timeoutMs: HANDLER_TIMEOUT_MS });
  deps.handlers.set("slack.fetch_thread", { handler: fetchThread, timeoutMs: HANDLER_TIMEOUT_MS });
  deps.handlers.set("slack.retention_cleanup", {
    handler: retention,
    timeoutMs: RETENTION_TIMEOUT_MS,
  });

  scheduler.upsert({
    name: "slack.collect_incremental",
    jobType: "slack.collect_incremental",
    intervalSeconds: settings.get("slack.collection.intervalSeconds"),
    coalesce: true, // R58
  });
  scheduler.upsert({
    name: "slack.retention_cleanup",
    jobType: "slack.retention_cleanup",
    intervalSeconds: 86_400,
    coalesce: true, // R58
  });

  const startBackfill = (): { started: boolean; state: SyncState; reason?: string } => {
    return db.transaction(
      (tx) => {
        const cur = sync.get("slack.backfill", tx);
        const live = isLive(tx, "slack.backfill", ["PENDING", "RETRY", "RUNNING"]);
        if (cur.status === "complete") {
          return { started: false, state: cur, reason: "backfill already complete" };
        }
        if (cur.status === "running" && live) {
          return { started: false, state: cur, reason: "backfill already running" };
        }
        if (cur.status === "paused") {
          // Nothing sets "paused" for backfill today; refuse rather than reset so a future pause never wipes the checkpoint.
          return { started: false, state: cur, reason: "backfill is paused" };
        }
        const now = nowMs();
        const generation = new Date(now).toISOString();
        const resumable = cur.status === "error" || cur.status === "running";
        if (resumable && cur.checkpoint !== null && cur.upperBound !== null) {
          // R49: resume from the current checkpoint, never reset.
          sync.update(tx, "slack.backfill", {
            status: "running",
            generation,
            stallCount: 0,
            backoffMinutes: 0,
            lastError: null,
          });
        } else {
          sync.update(tx, "slack.backfill", {
            status: "running",
            checkpoint: tsFromMs(now - settings.get("slack.backfill.days") * DAY_MS),
            // R37
            upperBound: sync.get("slack.messages", tx).checkpoint ?? tsFromMs(now),
            pagesDone: 0,
            backoffMinutes: 0,
            stallCount: 0,
            generation,
            lastError: null,
          });
        }
        const state = sync.get("slack.backfill", tx);
        enqueueBackfill(tx, state, now);
        return { started: true, state };
      },
      { behavior: "immediate" },
    );
  };

  return { startBackfill };
}
