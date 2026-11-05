import { expect, test } from "bun:test";
import {
  type CollectResult,
  JobError,
  type MessagePage,
  type MessageSource,
} from "@synapse/contracts";
import { openDatabase, runMigrations, schema } from "@synapse/database";
import { FakeClock } from "@synapse/shared";
import { AuditLogger } from "../../src/core/audit/audit";
import { SettingsService } from "../../src/core/config/settings";
import { EventPublisher } from "../../src/core/events/publisher";
import { JobQueue } from "../../src/core/jobs/queue";
import { type HandlerRegistration, JobWorker } from "../../src/core/jobs/worker";
import { SchedulerService } from "../../src/core/scheduler/scheduler";
import { InboxStore } from "../../src/modules/inbox/store";
import { SyncStateService } from "../../src/modules/inbox/sync-state";
import { registerSlackJobs } from "../../src/workers/slack";

type Step = () => Promise<CollectResult>;
type StartResult = ReturnType<ReturnType<typeof registerSlackJobs>["startBackfill"]>;

/** Real queue and worker, scripted source: only the Slack backfill handler is registered. */
function setup(script: Step[]) {
  const db = openDatabase(":memory:").db;
  runMigrations(db);
  const clock = new FakeClock("2026-11-05T12:00:00.000Z");
  const sync = new SyncStateService(db, clock);
  const events = new EventPublisher(clock);
  const settings = new SettingsService(db, clock, events.publish.bind(events));
  const queue = new JobQueue(db, clock);
  const during: { run: boolean; result: StartResult | null } = { run: false, result: null };
  let slack: ReturnType<typeof registerSlackJobs> | undefined;
  const source: MessageSource = {
    collect: async () => {
      if (during.run) during.result = slack?.startBackfill() ?? null;
      const next = script.shift();
      if (!next) throw new Error("no scripted collect");
      return next();
    },
    fetchThreads: async () => [],
  };
  const store = new InboxStore({ db, clock, events, queue, sync });
  const handlers = new Map<string, HandlerRegistration>();
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
  const backfill = handlers.get("slack.backfill");
  if (!backfill) throw new Error("slack.backfill not registered");
  const worker = new JobWorker(queue, new Map([["slack.backfill", backfill]]), { workerId: "w" });
  const jobs = () =>
    db
      .select()
      .from(schema.jobs)
      .all()
      .filter((j) => j.type === "slack.backfill");
  return { clock, sync, slack, worker, jobs, during };
}

const page = (ts: string, cursor?: string): MessagePage => ({
  messages: [
    {
      externalId: `C1:${ts}`,
      conversationId: "C1",
      conversationType: "channel",
      conversationName: "general",
      ts,
      senderId: "U1",
      text: "hi",
      sentAt: new Date(Number(ts) * 1000).toISOString(),
    },
  ],
  rejected: 0,
  ...(cursor ? { nextCursor: cursor } : {}),
});
const more =
  (ts: string): Step =>
  async () => ({ pages: [page(ts, "c")], searches: 1, complete: false });
const last =
  (ts: string): Step =>
  async () => ({ pages: [page(ts)], searches: 1, complete: false });
const live = (jobs: { status: string }[]) =>
  jobs.filter((j) => ["PENDING", "RETRY", "RUNNING"].includes(j.status));

test("real queue: chain continues one job at a time, then completes", async () => {
  const t = setup([
    more("1793870000.000100"),
    more("1793870100.000100"),
    last("1793870200.000100"),
  ]);
  t.slack.startBackfill();
  for (let i = 0; i < 3; i++) {
    expect(await t.worker.runOnce()).toBe(true);
    if (i < 2) expect(live(t.jobs())).toHaveLength(1);
    t.clock.advance(4 * 60_000);
  }
  expect(t.sync.get("slack.backfill").status).toBe("complete");
});

test("real queue: terminal on last attempt -> error, then resume", async () => {
  const fail: Step = async () => {
    throw new JobError({ kind: "incomplete_ai_output", message: "x" });
  };
  const t = setup([fail, fail, fail, last("1793870200.000100")]);
  t.slack.startBackfill();
  for (let i = 0; i < 3; i++) {
    await t.worker.runOnce();
    t.clock.advance(3_600_000);
  }
  expect(t.sync.get("slack.backfill").status).toBe("error");
  expect(t.slack.startBackfill().started).toBe(true);
  await t.worker.runOnce();
  expect(t.sync.get("slack.backfill").status).toBe("complete");
});

test("real queue: startBackfill while RUNNING is refused, single chain kept", async () => {
  const t = setup([more("1793870000.000100")]);
  t.slack.startBackfill();
  t.during.run = true;
  await t.worker.runOnce();
  expect(t.during.result?.started).toBe(false);
  expect(t.jobs().filter((j) => j.status === "PENDING")).toHaveLength(1);
});
