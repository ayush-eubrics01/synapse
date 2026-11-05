import { type CollectResult, type Job, JobError, type MessageSource } from "@synapse/contracts";
import type { Db } from "@synapse/database";
import { type Clock, isoNow } from "@synapse/shared";
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

export const tsFromMs = (ms: number): string => (ms / 1000).toFixed(6);

export function registerSlackJobs(deps: SlackJobDeps): {
  startBackfill(): { started: boolean; state: SyncState };
} {
  const { db, clock, source, store, sync, queue, settings, events, audit, scheduler } = deps;
  const nowMs = () => clock.now().getTime();

  const fail = (stream: SyncStream, err: JobError): never => {
    const e = err.classified;
    db.transaction(
      (tx) => {
        sync.update(tx, stream, { lastError: { kind: e.kind, message: e.message } });
        events.publish(tx, {
          type: "collection.failed",
          aggregateType: "integration",
          aggregateId: stream,
          correlationId: stream,
          payload: { stream, kind: e.kind },
        });
      },
      { behavior: "immediate" },
    );
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

  const incremental = async (_job: Job, ctx: JobContext) => {
    if (!settings.get("slack.collection.enabled")) return { skipped: true };
    const stream: SyncStream = "slack.messages";
    let checkpoint = sync.get(stream).checkpoint;
    if (checkpoint === null) {
      checkpoint = tsFromMs(nowMs() - DAY_MS);
      sync.update(db, stream, { checkpoint });
    }
    try {
      const result = await source.collect(
        { afterTs: checkpoint, maxPages: settings.get("slack.collector.pagesPerRun") },
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
      if (err instanceof JobError) fail(stream, err);
      throw err;
    }
  };

  /** Enqueues the next backfill run; a key that would collide with an earlier job gets a suffix. */
  const enqueueBackfill = (
    tx: Parameters<JobQueue["enqueue"]>[0],
    state: SyncState,
    runAfterMs: number | null,
    progressed: boolean,
  ) => {
    const runAfter = runAfterMs === null ? undefined : new Date(runAfterMs).toISOString();
    const base = `slack.backfill:${state.checkpoint}`;
    const idempotencyKey = progressed
      ? base
      : `${base}:${state.pagesDone}${runAfter ? `:${runAfter}` : ""}`;
    queue.enqueue(tx, { type: "slack.backfill", idempotencyKey, priority: 10, runAfter });
  };

  const backfill = async (_job: Job, ctx: JobContext) => {
    const stream: SyncStream = "slack.backfill";
    const start = sync.get(stream);
    if (start.status !== "running" || start.checkpoint === null || start.upperBound === null) {
      return { skipped: true };
    }
    const minMinutes = settings.get("slack.backfill.minMinutesBetweenRuns");
    const maxBackoff = settings.get("slack.backfill.maxBackoffMinutes");
    try {
      const result = await source.collect(
        {
          afterTs: start.checkpoint,
          beforeTs: start.upperBound,
          maxPages: settings.get("slack.collector.pagesPerRun"),
        },
        ctx.signal,
      );
      const totals = persistAll(stream, result);
      db.transaction(
        (tx) => {
          sync.countSearches(tx, stream, result.searches);
          const cur = sync.get(stream, tx);
          const pagesDone = cur.pagesDone + result.pages.length;
          const next = { ...cur, pagesDone };
          sync.update(tx, stream, {
            pagesDone,
            backoffMinutes: 0,
            lastSuccessAt: isoNow(clock),
            lastError: null,
            status: result.complete ? "complete" : "running",
          });
          events.publish(tx, {
            type: "collection.completed",
            aggregateType: "integration",
            aggregateId: stream,
            correlationId: stream,
            payload: { stream, pages: result.pages.length, ...totals },
          });
          if (!result.complete) {
            const runAfter = nowMs() + minMinutes * MIN_MS;
            sync.update(tx, stream, { nextRunAfter: new Date(runAfter).toISOString() });
            enqueueBackfill(tx, next, runAfter, cur.checkpoint !== start.checkpoint);
          }
        },
        { behavior: "immediate" },
      );
      return { pages: result.pages.length, ...totals, complete: result.complete };
    } catch (err) {
      if (!(err instanceof JobError)) throw err;
      if (err.classified.kind !== "rate_limited") return fail(stream, err);
      const cur = sync.get(stream);
      const backoff = Math.min(maxBackoff, Math.max(minMinutes, cur.backoffMinutes * 2));
      const retryAfterMs = err.classified.retryAfter ? Date.parse(err.classified.retryAfter) : 0;
      const runAfter = Math.max(
        Number.isNaN(retryAfterMs) ? 0 : retryAfterMs,
        nowMs() + backoff * MIN_MS,
      );
      db.transaction(
        (tx) => {
          sync.update(tx, stream, {
            backoffMinutes: backoff,
            status: "running",
            nextRunAfter: new Date(runAfter).toISOString(),
            lastError: { kind: err.classified.kind, message: err.classified.message },
          });
          enqueueBackfill(tx, cur, runAfter, false);
        },
        { behavior: "immediate" },
      );
      return { deferred: true, backoffMinutes: backoff };
    }
  };

  const fetchThread = async (job: Job, ctx: JobContext) => {
    const { conversationId, parentTs } = job.input as { conversationId: string; parentTs: string };
    const found = (await source.fetchThreads([{ conversationId, parentTs }], ctx.signal)).find(
      (t) => t.conversationId === conversationId && t.parentTs === parentTs,
    );
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
  });
  scheduler.upsert({
    name: "slack.retention_cleanup",
    jobType: "slack.retention_cleanup",
    intervalSeconds: 86_400,
  });

  const startBackfill = (): { started: boolean; state: SyncState } => {
    return db.transaction(
      (tx) => {
        const cur = sync.get("slack.backfill", tx);
        if (cur.status === "running" || cur.status === "complete") {
          return { started: false, state: cur };
        }
        const now = nowMs();
        const checkpoint = tsFromMs(now - settings.get("slack.backfill.days") * DAY_MS);
        const upperBound = sync.get("slack.messages", tx).checkpoint ?? tsFromMs(now); // R37
        sync.update(tx, "slack.backfill", {
          status: "running",
          checkpoint,
          upperBound,
          pagesDone: 0,
          backoffMinutes: 0,
          lastError: null,
        });
        const state = sync.get("slack.backfill", tx);
        queue.enqueue(tx, {
          type: "slack.backfill",
          idempotencyKey: `slack.backfill:${checkpoint}`,
          priority: 10,
        });
        return { started: true, state };
      },
      { behavior: "immediate" },
    );
  };

  return { startBackfill };
}
