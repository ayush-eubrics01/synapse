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
    scheduler: new SchedulerService(db, clock, queue),
    handlers,
  });
});

const ctx = {
  signal: new AbortController().signal,
  checkpoint() {},
  getCheckpoint: () => undefined,
};
const run = (type: string, input: unknown = null) => {
  const h = handlers.get(type);
  if (!h) throw new Error(`no handler ${type}`);
  return h.handler({ type, input } as unknown as Job, ctx as never);
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
  expect(j?.idempotencyKey).toBe(`slack.backfill:${r.state.checkpoint}`);
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
  fake.next.push(ok([{ messages: [msg(T1)], rejected: 0 }], false));
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
  const next = jobs("slack.backfill").find((j) => j.idempotencyKey === `slack.backfill:${T1}`);
  expect(next?.runAfter).toBe("2026-11-05T12:03:00.000Z");

  fake.next.push(ok([], true));
  await run("slack.backfill");
  expect(sync.get("slack.backfill").status).toBe("complete");
  expect(jobs("slack.backfill")).toHaveLength(2);
});

test("backfill no progress: re-enqueue key includes pages_done and is not swallowed", async () => {
  const start = slack.startBackfill().state;
  fake.next.push(ok([], false));
  await run("slack.backfill");
  const keys = jobs("slack.backfill").map((j) => j.idempotencyKey);
  expect(keys).toHaveLength(2);
  expect(keys[1]).toStartWith(`slack.backfill:${start.checkpoint}:0`);
});

test("rate_limited backoff 0->3->6->12->24->30, deferred not failed", async () => {
  slack.startBackfill();
  const seen: number[] = [];
  for (let i = 0; i < 6; i++) {
    fake.next.push(boom(rate()));
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
