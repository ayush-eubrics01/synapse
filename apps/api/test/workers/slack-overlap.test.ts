/**
 * R61 (supersedes R59's query offset): every incremental run reads from floor(checkpoint), and the
 * incremental stream's stored checkpoint is capped at now - slack.collection.indexLagSeconds, so
 * messages in the last `lag` seconds are re-read on the next poll (late indexing) without the
 * re-read window ever stalling collection. The fake source simulates Slack search: ascending,
 * strictly after `after`, only messages already indexed, at most pagesPerRun x 20 results.
 */
import { beforeEach, expect, test } from "bun:test";
import type {
  CollectRequest,
  CollectResult,
  Job,
  MessagePage,
  MessageSource,
  SourceMessage,
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

const NOW0 = 1793880000; // 2026-11-05T12:00:00Z
const LAG = 300;
const ts = (sec: number) => `${sec}.000100`;

let db: ReturnType<typeof openDatabase>["db"];
let clock: FakeClock;
let sync: SyncStateService;
let store: InboxStore;
let handlers: Map<string, HandlerRegistration>;
let slack: ReturnType<typeof registerSlackJobs>;
/** Slack's view: message ts -> the time (seconds) from which search returns it. */
let indexed: Map<string, number>;
let requests: CollectRequest[];

const msg = (t: string): SourceMessage => ({
  externalId: `C0LAG:${t}`,
  conversationId: "C0LAG",
  conversationType: "channel",
  ts: t,
  senderId: "U0LAG",
  text: "hi",
  sentAt: new Date(Number(t) * 1000).toISOString(),
});

const nowSec = () => clock.now().getTime() / 1000;

beforeEach(() => {
  db = openDatabase(":memory:").db;
  runMigrations(db);
  clock = new FakeClock(new Date(NOW0 * 1000));
  sync = new SyncStateService(db, clock);
  const events = new EventPublisher(clock);
  const settings = new SettingsService(db, clock, events.publish.bind(events));
  const queue = new JobQueue(db, clock);
  store = new InboxStore({ db, clock, events, queue, sync });
  indexed = new Map();
  requests = [];
  const source: MessageSource = {
    collect: async (req): Promise<CollectResult> => {
      requests.push(req);
      const after = Number(req.afterTs);
      const upper = req.beforeTs ? Number(req.beforeTs) : nowSec();
      const hits = [...indexed.entries()]
        .filter(([t, from]) => Number(t) > after && Number(t) <= upper && from <= nowSec())
        .map(([t]) => t)
        .sort((a, b) => Number(a) - Number(b))
        .slice(0, req.maxPages * 20);
      const pages: MessagePage[] = [];
      for (let i = 0; i < hits.length; i += 20) {
        pages.push({ messages: hits.slice(i, i + 20).map(msg), rejected: 0, nextCursor: "c" });
      }
      const last = pages.at(-1);
      const complete = hits.length < req.maxPages * 20;
      if (last && complete) delete last.nextCursor;
      return { pages, searches: Math.max(1, pages.length), complete };
    },
    fetchThreads: async () => [],
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

const run = (type = "slack.collect_incremental") =>
  handlers.get(type)?.handler(
    { type, input: null, attempts: 1, maxAttempts: 3 } as unknown as Job,
    {
      signal: new AbortController().signal,
      checkpoint() {},
      getCheckpoint: () => undefined,
    } as never,
  ) as Promise<{ inserted?: number }>;

const storedCount = () => db.select().from(schema.slackMessages).all().length;
const checkpoint = () => Number(sync.get("slack.messages").checkpoint);

test("R61 (a): 120 stored messages in the last 300 s never stall collection", async () => {
  // 120 messages already stored, all inside the lag window of the newest one; the checkpoint is
  // at the newest stored message (what the R59 offset left behind).
  const old = Array.from({ length: 120 }, (_, i) => ts(NOW0 - 300 + i * 2));
  for (const t of old) indexed.set(t, NOW0 - 400);
  store.persistPage("slack.messages", { messages: old.map(msg), rejected: 0 });
  // 150 newer messages arrive over the next ~8 minutes.
  const newer = Array.from({ length: 150 }, (_, i) => ts(NOW0 + 10 + i * 3));
  for (const t of newer) indexed.set(t, Number(t));

  let prev = checkpoint();
  let runs = 0;
  while (storedCount() < 270 && runs < 5) {
    clock.advance(600_000);
    const out = await run();
    runs++;
    const cp = checkpoint();
    if ((out.inserted ?? 0) > 0) expect(cp).toBeGreaterThan(prev); // advances on every run with results
    expect(cp).toBeGreaterThanOrEqual(prev); // never backwards
    expect(cp).toBeLessThanOrEqual(nowSec() - LAG); // (c) capped at now - lag
    // R61: no query offset: `afterTs` is the checkpoint itself (the source floors it).
    expect(Number(requests.at(-1)?.afterTs)).toBe(prev);
    prev = cp;
  }
  expect(storedCount()).toBe(270);
  expect(runs).toBeLessThanOrEqual(3);
});

test("R61 (b): a message indexed late inside the lag window is collected on the next poll", async () => {
  clock.advance(600_000);
  const t0 = nowSec();
  sync.update(db, "slack.messages", { checkpoint: ts(t0 - 900) });
  const early = ts(t0 - 100); // indexed at once
  const late = ts(t0 - 200); // posted earlier, but search only returns it after this poll
  indexed.set(early, t0 - 100);
  indexed.set(late, t0 + 60);
  await run();
  expect(storedCount()).toBe(1);
  expect(checkpoint()).toBe(t0 - LAG); // capped below `late`, so the next poll re-reads it
  clock.advance(600_000);
  const out = await run();
  expect(out.inserted).toBe(1);
  expect(storedCount()).toBe(2);
});

test("R61 (c): a checkpoint already above now - lag is never moved backwards", async () => {
  clock.advance(600_000);
  const t0 = nowSec();
  sync.update(db, "slack.messages", { checkpoint: ts(t0 - 10) });
  indexed.set(ts(t0 - 5), t0 - 5);
  await run();
  expect(sync.get("slack.messages").checkpoint).toBe(ts(t0 - 10));
});

test("R61 (d): backfill keeps plain R48 (checkpoint = page max, inside the lag window)", async () => {
  const t0 = nowSec();
  slack.startBackfill();
  const recent = ts(t0 - 30);
  indexed.set(recent, t0 - 30);
  sync.update(db, "slack.backfill", { upperBound: ts(t0) });
  await run("slack.backfill");
  expect(sync.get("slack.backfill").checkpoint).toBe(recent);
});
