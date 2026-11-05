import { beforeEach, expect, test } from "bun:test";
import {
  type CollectRequest,
  type CollectResult,
  type Job,
  JobError,
  type MessagePage,
  type MessageSource,
  type SourceMessage,
} from "@synapse/contracts";
import { openDatabase, runMigrations, schema } from "@synapse/database";
import { FakeClock } from "@synapse/shared";
import { eq } from "drizzle-orm";
import { AuditLogger } from "../../src/core/audit/audit";
import { SettingsService } from "../../src/core/config/settings";
import { EventPublisher } from "../../src/core/events/publisher";
import { JobQueue } from "../../src/core/jobs/queue";
import type { HandlerRegistration } from "../../src/core/jobs/worker";
import { SchedulerService } from "../../src/core/scheduler/scheduler";
import { InboxStore } from "../../src/modules/inbox/store";
import { SyncStateService } from "../../src/modules/inbox/sync-state";
import { registerSlackJobs } from "../../src/workers/slack";

type Fake = {
  collects: CollectRequest[];
  fetches: unknown[];
  next: (() => Promise<CollectResult>)[];
  threads: Awaited<ReturnType<MessageSource["fetchThreads"]>>;
};

let db: ReturnType<typeof openDatabase>["db"];
let clock: FakeClock;
let sync: SyncStateService;
let settings: SettingsService;
let fake: Fake;
let handlers: Map<string, HandlerRegistration>;
let slack: ReturnType<typeof registerSlackJobs>;
let expired: number[];
let scheduler: SchedulerService;

const T1 = "1793870000.000100";
const msg = (ts: string, over: Partial<SourceMessage> = {}): SourceMessage => ({
  externalId: `C1:${ts}`,
  conversationId: "C1",
  conversationType: "channel",
  conversationName: "general",
  ts,
  senderId: "U1",
  text: "hi",
  sentAt: new Date(Number(ts) * 1000).toISOString(),
  ...over,
});
const ok =
  (pages: MessagePage[], complete: boolean, searches = 1): (() => Promise<CollectResult>) =>
  async () => ({ pages, searches, complete });
const boom = (e: JobError) => async (): Promise<CollectResult> => {
  throw e;
};
const rate = (retryAfter?: string) =>
  new JobError({ kind: "rate_limited", message: "slow down", retryAfter });

beforeEach(() => {
  db = openDatabase(":memory:").db;
  runMigrations(db);
  clock = new FakeClock("2026-11-05T12:00:00.000Z");
  sync = new SyncStateService(db, clock);
  const events = new EventPublisher(clock);
  settings = new SettingsService(db, clock, events.publish.bind(events));
  const queue = new JobQueue(db, clock);
  fake = { collects: [], fetches: [], next: [], threads: [] };
  const source: MessageSource = {
    collect: async (req) => {
      fake.collects.push(req);
      const n = fake.next.shift();
      if (!n) throw new Error("no scripted collect");
      return n();
    },
    fetchThreads: async (reqs) => {
      fake.fetches.push(reqs);
      return fake.threads;
    },
  };
  const store = new InboxStore({ db, clock, events, queue, sync });
  expired = [];
  const realExpire = store.expireContent.bind(store);
  store.expireContent = (d: number) => {
    expired.push(d);
    return realExpire(d);
  };
  handlers = new Map();
  scheduler = new SchedulerService(db, clock, queue);
  slack = registerSlackJobs({
    db,
    clock,
    source,
    store,
    sync,
    queue,
    settings,
    events,
    audit: new AuditLogger(clock),
    scheduler,
    handlers,
  });
});

const ctx = {
  signal: new AbortController().signal,
  checkpoint() {},
  getCheckpoint: () => undefined,
};
const run = (type: string, input: unknown = null, attempts = 1, maxAttempts = 3) => {
  const h = handlers.get(type);
  if (!h) throw new Error(`no handler ${type}`);
  return h.handler({ type, input, attempts, maxAttempts } as unknown as Job, ctx as never);
};
const jobs = (type?: string) =>
  db
    .select()
    .from(schema.jobs)
    .all()
    .filter((j) => !type || j.type === type);
const evts = (type: string) =>
  db
    .select()
    .from(schema.domainEvents)
    .all()
    .filter((e) => e.type === type);
/** Simulates the worker finishing every backfill job (the running one is no longer live). */
const finishBackfill = () =>
  db
    .update(schema.jobs)
    .set({ status: "COMPLETED" })
    .where(eq(schema.jobs.type, "slack.backfill"))
    .run();
const nowTs = () => (clock.now().getTime() / 1000).toFixed(6);

test("registration: timeouts and schedules", () => {
  expect(handlers.get("slack.collect_incremental")?.timeoutMs).toBe(300_000);
  expect(handlers.get("slack.backfill")?.timeoutMs).toBe(300_000);
  expect(handlers.get("slack.fetch_thread")?.timeoutMs).toBe(300_000);
  expect(handlers.get("slack.retention_cleanup")?.timeoutMs).toBe(60_000);
  const tasks = db.select().from(schema.scheduledTasks).all();
  const inc = tasks.find((t) => t.name === "slack.collect_incremental");
  expect(inc?.intervalSeconds).toBe(600);
  expect(tasks.find((t) => t.name === "slack.retention_cleanup")?.intervalSeconds).toBe(86400);
});

test("first incremental run sets now-1day checkpoint, persists, emits completed", async () => {
  fake.next.push(ok([{ messages: [msg(T1)], rejected: 1 }], true));
  await run("slack.collect_incremental");
  expect(fake.collects[0]).toEqual({
    afterTs: (Number(nowTs()) - 86400).toFixed(6),
    maxPages: 5,
  });
  const s = sync.get("slack.messages");
  expect(s.checkpoint).toBe(T1);
  expect(s.searchCount).toBe(1);
  expect(s.lastSuccessAt).toBe("2026-11-05T12:00:00.000Z");
  expect(evts("collection.completed").map((e) => e.payload)).toEqual([
    { stream: "slack.messages", pages: 1, inserted: 1, duplicates: 0, rejected: 1 },
  ]);
});

test("empty collect: completed with inserted 0, no re-enqueue", async () => {
  fake.next.push(ok([], false, 0));
  await run("slack.collect_incremental");
  expect(evts("collection.completed")[0]?.payload).toMatchObject({ inserted: 0, pages: 0 });
  expect(jobs("slack.collect_incremental")).toHaveLength(0);
  expect(jobs()).toHaveLength(0);
});

test("incremental skips without calling the source when disabled", async () => {
  settings.set("slack.collection.enabled", false);
  await run("slack.collect_incremental");
  expect(fake.collects).toHaveLength(0);
});

test("parse_failed: lastError recorded, collection.failed emitted, rethrown", async () => {
  fake.next.push(boom(new JobError({ kind: "parse_failed", message: "bad" })));
  await expect(run("slack.collect_incremental")).rejects.toBeInstanceOf(JobError);
  expect(sync.get("slack.messages").lastError).toEqual({ kind: "parse_failed", message: "bad" });
  expect(evts("collection.failed")[0]?.payload).toEqual({
    stream: "slack.messages",
    kind: "parse_failed",
  });
});

test("backfill start: running, bounds, idempotent", () => {
  const r = slack.startBackfill();
  expect(r.started).toBe(true);
  expect(r.state.status).toBe("running");
  expect(r.state.checkpoint).toBe((Number(nowTs()) - 90 * 86400).toFixed(6));
  expect(r.state.upperBound).toBe(nowTs());
  const [j] = jobs("slack.backfill");
  expect(j?.priority).toBe(10);
  expect(j?.concurrencyGroup).toBe("slack.backfill");
  expect(j?.idempotencyKey).toBe(
    `slack.backfill:${r.state.generation}:${r.state.checkpoint}:0:2026-11-05T12:00:00.000Z`,
  );
  const again = slack.startBackfill();
  expect(again.started).toBe(false);
  expect(jobs("slack.backfill")).toHaveLength(1);
});

test("backfill upper bound uses the incremental checkpoint (R37)", () => {
  sync.update(db, "slack.messages", { checkpoint: T1 });
  expect(slack.startBackfill().state.upperBound).toBe(T1);
});

test("backfill run: re-enqueues with min gap, then complete stops", async () => {
  const start = slack.startBackfill().state;
  fake.next.push(ok([{ messages: [msg(T1)], rejected: 0, nextCursor: "c" }], false));
  finishBackfill();
  await run("slack.backfill");
  expect(fake.collects[0]).toEqual({
    afterTs: start.checkpoint as string,
    beforeTs: start.upperBound as string,
    maxPages: 5,
  });
  const s = sync.get("slack.backfill");
  expect(s.pagesDone).toBe(1);
  expect(s.checkpoint).toBe(T1);
  expect(s.status).toBe("running");
  const next = jobs("slack.backfill").find((j) => j.status === "PENDING");
  expect(next?.runAfter).toBe("2026-11-05T12:03:00.000Z");

  fake.next.push(ok([], true));
  finishBackfill();
  await run("slack.backfill");
  expect(sync.get("slack.backfill").status).toBe("complete");
  expect(jobs("slack.backfill")).toHaveLength(2);
});

test("backfill no progress: re-enqueue key includes pages_done and is not swallowed", async () => {
  const start = slack.startBackfill().state;
  fake.next.push(ok([], false));
  finishBackfill();
  await run("slack.backfill");
  const keys = jobs("slack.backfill").map((j) => j.idempotencyKey);
  expect(keys).toHaveLength(2);
  expect(keys[1]).toContain(`:${start.checkpoint}:0:`);
});

test("rate_limited backoff 0->3->6->12->24->30, deferred not failed", async () => {
  slack.startBackfill();
  const seen: number[] = [];
  for (let i = 0; i < 6; i++) {
    fake.next.push(boom(rate()));
    finishBackfill();
    const out = await run("slack.backfill");
    expect(out).toMatchObject({ deferred: true });
    const s = sync.get("slack.backfill");
    seen.push(s.backoffMinutes);
    expect(s.status).toBe("running");
    clock.advance(60_000);
  }
  expect(seen).toEqual([3, 6, 12, 24, 30, 30]);
  expect(jobs("slack.backfill")).toHaveLength(7);
});

test("rate_limited honours a later retryAfter", async () => {
  slack.startBackfill();
  fake.next.push(boom(rate("2026-11-05T14:00:00.000Z")));
  finishBackfill();
  await run("slack.backfill");
  const last = jobs("slack.backfill").at(-1);
  expect(last?.runAfter).toBe("2026-11-05T14:00:00.000Z");
});

test("backfill other JobError: lastError, collection.failed, rethrow", async () => {
  slack.startBackfill();
  fake.next.push(boom(new JobError({ kind: "incomplete_ai_output", message: "x" })));
  await expect(run("slack.backfill")).rejects.toBeInstanceOf(JobError);
  expect(evts("collection.failed")[0]?.payload).toEqual({
    stream: "slack.backfill",
    kind: "incomplete_ai_output",
  });
  expect(sync.get("slack.backfill").lastError?.kind).toBe("incomplete_ai_output");
});

test("persistPage enqueues thread fetches in group slack.threads at priority 50", async () => {
  fake.next.push(
    ok([{ messages: [msg("1793870050.000100", { threadTs: T1 })], rejected: 0 }], true),
  );
  await run("slack.collect_incremental");
  const [j] = jobs("slack.fetch_thread");
  expect(j?.concurrencyGroup).toBe("slack.threads");
  expect(j?.priority).toBe(50);
});

test("fetch_thread stores a found thread", async () => {
  fake.next.push(
    ok([{ messages: [msg("1793870050.000100", { threadTs: T1 })], rejected: 0 }], true),
  );
  await run("slack.collect_incremental");
  fake.threads = [
    {
      conversationId: "C1",
      parentTs: T1,
      messages: [msg(T1), msg("1793870050.000100")],
      rejected: 0,
    },
  ];
  await run("slack.fetch_thread", { conversationId: "C1", parentTs: T1 });
  expect(fake.fetches[0]).toEqual([{ conversationId: "C1", parentTs: T1 }]);
  expect(db.select().from(schema.slackMessages).all()).toHaveLength(2);
});

test("fetch_thread missing pair completes and audits thread_unavailable", async () => {
  fake.threads = [];
  await run("slack.fetch_thread", { conversationId: "C1", parentTs: T1 });
  const [a] = db.select().from(schema.auditEvents).all();
  expect(a).toMatchObject({
    actor: "system",
    module: "inbox",
    action: "slack.thread_unavailable",
    result: "missing",
    details: { conversationId: "C1", parentTs: T1 },
  });
});

test("retention calls expireContent with 180", async () => {
  await run("slack.retention_cleanup");
  expect(expired).toEqual([180]);
});

test("R49: parse_failed backfill -> status error; startBackfill resumes from the same checkpoint", async () => {
  slack.startBackfill();
  fake.next.push(ok([{ messages: [msg(T1)], rejected: 0, nextCursor: "c" }], false));
  finishBackfill();
  await run("slack.backfill");
  const cp = sync.get("slack.backfill").checkpoint;
  fake.next.push(boom(new JobError({ kind: "parse_failed", message: "bad" })));
  finishBackfill();
  await expect(run("slack.backfill")).rejects.toBeInstanceOf(JobError);
  expect(sync.get("slack.backfill").status).toBe("error");
  clock.advance(1000);
  finishBackfill();
  const r = slack.startBackfill();
  expect(r.started).toBe(true);
  expect(r.state.status).toBe("running");
  expect(r.state.checkpoint).toBe(cp);
  expect(r.state.pagesDone).toBe(1);
  expect(r.state.generation).toBe("2026-11-05T12:00:01.000Z");
  expect(jobs("slack.backfill").at(-1)?.idempotencyKey).toStartWith(
    "slack.backfill:2026-11-05T12:00:01.000Z:",
  );
});

test("R49: retryable error is not terminal until attempts are exhausted", async () => {
  slack.startBackfill();
  fake.next.push(boom(new JobError({ kind: "incomplete_ai_output", message: "x" })));
  const h = handlers.get("slack.backfill")?.handler;
  await expect(
    h?.({ type: "slack.backfill", attempts: 1, maxAttempts: 3 } as unknown as Job, ctx as never),
  ).rejects.toBeInstanceOf(JobError);
  expect(sync.get("slack.backfill").status).toBe("running");
  fake.next.push(boom(new JobError({ kind: "incomplete_ai_output", message: "x" })));
  await expect(
    h?.({ type: "slack.backfill", attempts: 3, maxAttempts: 3 } as unknown as Job, ctx as never),
  ).rejects.toBeInstanceOf(JobError);
  expect(sync.get("slack.backfill").status).toBe("error");
});

test("R49: running with no live job resumes; with a live job does not", () => {
  const first = slack.startBackfill();
  expect(slack.startBackfill().started).toBe(false);
  finishBackfill();
  clock.advance(1000);
  const r = slack.startBackfill();
  expect(r.started).toBe(true);
  expect(r.state.checkpoint).toBe(first.state.checkpoint);
  expect(r.state.generation).not.toBe(first.state.generation);
});

test("R50: last page without nextCursor completes even when complete=false", async () => {
  slack.startBackfill();
  fake.next.push(ok([{ messages: [msg(T1)], rejected: 0 }], false));
  finishBackfill();
  await run("slack.backfill");
  expect(sync.get("slack.backfill").status).toBe("complete");
  expect(jobs("slack.backfill")).toHaveLength(1);
});

test("R50: three stalled runs -> error, collection.failed unknown, no further job", async () => {
  slack.startBackfill();
  for (let i = 0; i < 3; i++) {
    fake.next.push(ok([], false));
    finishBackfill();
    await run("slack.backfill");
    clock.advance(1000);
  }
  const s = sync.get("slack.backfill");
  expect(s.status).toBe("error");
  expect(s.stallCount).toBe(3);
  expect(s.lastError).toEqual({ kind: "unknown", message: "no progress after 3 runs" });
  expect(jobs("slack.backfill")).toHaveLength(3);
  expect(evts("collection.failed")[0]?.payload).toEqual({
    stream: "slack.backfill",
    kind: "unknown",
  });
});

test("R51: enqueue is skipped while a PENDING backfill job exists", async () => {
  slack.startBackfill();
  fake.next.push(ok([], false));
  await run("slack.backfill"); // first job still PENDING in the table
  expect(jobs("slack.backfill")).toHaveLength(1);
});

test("R52: incremental skips when recently successful or another is RUNNING", async () => {
  sync.update(db, "slack.messages", { lastSuccessAt: "2026-11-05T11:57:00.000Z" });
  await run("slack.collect_incremental");
  expect(fake.collects).toHaveLength(0);
  sync.update(db, "slack.messages", { lastSuccessAt: "2026-11-05T11:00:00.000Z" });
  db.insert(schema.jobs)
    .values({
      id: "other",
      type: "slack.collect_incremental",
      status: "RUNNING",
      idempotencyKey: "k-other",
      priority: 100,
      runAfter: "2026-11-05T12:00:00.000Z",
      createdAt: "2026-11-05T12:00:00.000Z",
    } as never)
    .run();
  await run("slack.collect_incremental");
  expect(fake.collects).toHaveLength(0);
});

test("R53: auth_paused writes no lastError; non-JobError writes unknown", async () => {
  fake.next.push(boom(new JobError({ kind: "auth_paused", message: "paused" })));
  await expect(run("slack.collect_incremental")).rejects.toBeInstanceOf(JobError);
  expect(sync.get("slack.messages").lastError).toBeNull();
  expect(evts("collection.failed")).toHaveLength(0);
  fake.next.push(async () => {
    throw new Error("secret detail");
  });
  await expect(run("slack.collect_incremental")).rejects.toThrow("secret detail");
  expect(sync.get("slack.messages").lastError?.kind).toBe("unknown");
  expect(sync.get("slack.messages").lastError?.message).not.toContain("secret");
  expect(evts("collection.failed")).toHaveLength(1);
});

test("R53: fetch_thread rejects invalid input", async () => {
  await expect(run("slack.fetch_thread", { nope: 1 })).rejects.toMatchObject({
    classified: { kind: "invalid_input" },
  });
});

test("startBackfill refuses when paused, with a reason, and leaves state untouched", () => {
  slack.startBackfill();
  sync.update(db, "slack.backfill", { status: "paused" });
  finishBackfill();
  const before = sync.get("slack.backfill");
  const r = slack.startBackfill();
  expect(r.started).toBe(false);
  expect(r.reason).toBeTruthy();
  expect(sync.get("slack.backfill")).toEqual(before);
  expect(jobs("slack.backfill")).toHaveLength(1);
});

test("R58: Slack schedules coalesce while a job of their type is waiting", () => {
  expect(scheduler.tick()).toBe(2);
  // Both jobs deferred (e.g. auth pause): later ticks add nothing.
  db.update(schema.jobs).set({ runAfter: "2026-11-07T00:00:00.000Z" }).run();
  clock.advance(86_400_000);
  expect(scheduler.tick()).toBe(0);
  expect(jobs("slack.collect_incremental")).toHaveLength(1);
  expect(jobs("slack.retention_cleanup")).toHaveLength(1);
});

test("R60 M5: backfill auth_failed rethrows (job parks) but keeps status running, resumable", async () => {
  slack.startBackfill();
  fake.next.push(boom(new JobError({ kind: "auth_failed", message: "login" })));
  finishBackfill();
  await expect(run("slack.backfill")).rejects.toBeInstanceOf(JobError);
  const s = sync.get("slack.backfill");
  expect(s.status).toBe("running");
  expect(s.lastError).toEqual({ kind: "auth_failed", message: "login" });
  expect(slack.backfillResumable()).toBe(true);
  clock.advance(1000);
  const r = slack.startBackfill();
  expect(r.started).toBe(true);
  expect(r.state.checkpoint).toBe(s.checkpoint);
  expect(slack.backfillResumable()).toBe(false);
});

test("Q2: a failed run counts the searches it spent; a successful run's count is unchanged", async () => {
  fake.next.push(
    boom(
      new JobError({
        kind: "rate_limited",
        message: "slow down",
        details: { searches: 2 },
      }),
    ),
  );
  await expect(run("slack.collect_incremental")).rejects.toBeInstanceOf(JobError);
  expect(sync.get("slack.messages").searchCount).toBe(2);
  fake.next.push(ok([{ messages: [msg(T1)], rejected: 0 }], true, 1));
  await run("slack.collect_incremental");
  expect(sync.get("slack.messages").searchCount).toBe(3);
});

test("Q2: a backfill rate_limited run counts details.searches once", async () => {
  slack.startBackfill();
  fake.next.push(
    boom(new JobError({ kind: "rate_limited", message: "slow", details: { searches: 2 } })),
  );
  finishBackfill();
  await run("slack.backfill");
  expect(sync.get("slack.backfill").searchCount).toBe(2);
});
