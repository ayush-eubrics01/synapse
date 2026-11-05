import { beforeEach, expect, test } from "bun:test";
import type { MessagePage, SourceMessage } from "@synapse/contracts";
import { openDatabase, runMigrations, schema } from "@synapse/database";
import { FakeClock } from "@synapse/shared";
import { eq } from "drizzle-orm";
import { EventPublisher } from "../../src/core/events/publisher";
import { JobQueue } from "../../src/core/jobs/queue";
import { InboxStore } from "../../src/modules/inbox/store";
import { SyncStateService } from "../../src/modules/inbox/sync-state";

let db: ReturnType<typeof openDatabase>["db"];
let clock: FakeClock;
let sync: SyncStateService;
let store: InboxStore;

beforeEach(() => {
  db = openDatabase(":memory:").db;
  runMigrations(db);
  clock = new FakeClock("2026-11-05T12:00:00.000Z");
  sync = new SyncStateService(db, clock);
  store = new InboxStore({
    db,
    clock,
    events: new EventPublisher(clock),
    queue: new JobQueue(db, clock),
    sync,
  });
});

function msg(ts: string, over: Partial<SourceMessage> = {}): SourceMessage {
  const conversationId = over.conversationId ?? "C1";
  return {
    externalId: `${conversationId}:${ts}`,
    conversationId,
    conversationType: "channel",
    conversationName: "general",
    ts,
    senderId: "U1",
    senderName: "Ann",
    senderEmail: "ann@example.com",
    text: `secret text ${ts}`,
    permalink: `https://x/${ts}`,
    sentAt: new Date(Number(ts) * 1000).toISOString(),
    ...over,
  };
}
const page = (...messages: SourceMessage[]): MessagePage => ({ messages, rejected: 0 });
const T1 = "1793870000.000100";
const T2 = "1793870100.000200";
const T3 = "1793870200.000300";

const events = () => db.select().from(schema.domainEvents).all();
const jobs = () => db.select().from(schema.jobs).all();

test("same page twice: second time all duplicates, no duplicate events", () => {
  const p = page(msg(T1), msg(T2));
  expect(store.persistPage("slack.messages", p)).toEqual({
    inserted: 2,
    duplicates: 0,
    threadFetches: 0,
  });
  expect(store.persistPage("slack.messages", p).inserted).toBe(0);
  expect(store.persistPage("slack.messages", p).duplicates).toBe(2);
  expect(events().filter((e) => e.type === "message.received")).toHaveLength(2);
});

test("checkpoint advances to max ts and never moves backwards", () => {
  store.persistPage("slack.messages", page(msg(T2), msg(T1)));
  expect(sync.get("slack.messages").checkpoint).toBe(T2);
  store.persistPage("slack.messages", page(msg(T1, { conversationId: "C2" })));
  expect(sync.get("slack.messages").checkpoint).toBe(T2);
  store.persistPage("slack.messages", page(msg(T3)));
  expect(sync.get("slack.messages").checkpoint).toBe(T3);
});

test("checkpoint is capped at now", () => {
  const future = "4102444800.000000";
  store.persistPage("slack.messages", page(msg(future)));
  const expected = (clock.now().getTime() / 1000).toFixed(6);
  expect(sync.get("slack.messages").checkpoint).toBe(expected);
});

test("empty page leaves checkpoint unchanged", () => {
  store.persistPage("slack.messages", page(msg(T1)));
  store.persistPage("slack.messages", page());
  expect(sync.get("slack.messages").checkpoint).toBe(T1);
});

test("reply with unknown parent: stored with thread_ts, exactly one fetch job across polls", () => {
  const reply = msg(T2, { threadTs: T1 });
  expect(store.persistPage("slack.messages", page(reply)).threadFetches).toBe(1);
  expect(store.persistPage("slack.messages", page(reply)).threadFetches).toBe(0);
  const row = db.select().from(schema.slackMessages).get();
  expect(row?.threadTs).toBe(T1);
  const j = jobs();
  expect(j).toHaveLength(1);
  expect(j[0]?.type).toBe("slack.fetch_thread");
  expect(j[0]?.input).toEqual({ conversationId: "C1", parentTs: T1 });
  expect(j[0]?.idempotencyKey).toBe(`slack.thread:C1:${T1}`);
  expect(events().some((e) => e.type === "message.thread_updated")).toBe(false);
});

test("every reply with a missing parent enqueues a job; re-persist adds none", () => {
  const replies = Array.from({ length: 7 }, (_, i) =>
    msg(`17938701${String(i).padStart(2, "0")}.000000`, {
      threadTs: `17938600${String(i).padStart(2, "0")}.000000`,
    }),
  );
  expect(store.persistPage("slack.messages", page(...replies)).threadFetches).toBe(7);
  expect(jobs()).toHaveLength(7);
  expect(store.persistPage("slack.messages", page(...replies)).threadFetches).toBe(0);
  expect(jobs()).toHaveLength(7);
});

test("threadFetches counts only newly created jobs", () => {
  store.persistPage("slack.messages", page(msg(T2, { threadTs: T1 })));
  const r = store.persistPage(
    "slack.messages",
    page(msg(T3, { threadTs: T1 }), msg("1793870300.000000", { threadTs: "1793860000.000000" })),
  );
  expect(r.threadFetches).toBe(1);
  expect(jobs()).toHaveLength(2);
});

test("checkpoint later than now stays unchanged on a non-empty page", () => {
  store.persistPage("slack.messages", page(msg(T2)));
  clock.set("2026-11-04T00:00:00.000Z");
  store.persistPage("slack.messages", page(msg("1793700000.000000")));
  expect(sync.get("slack.messages").checkpoint).toBe(T2);
});

test("reply whose parent exists emits message.thread_updated", () => {
  store.persistPage("slack.messages", page(msg(T1)));
  store.persistPage("slack.messages", page(msg(T2, { threadTs: T1 })));
  expect(events().filter((e) => e.type === "message.thread_updated")).toHaveLength(1);
  expect(jobs()).toHaveLength(0);
});

test("events carry no text, names or emails", () => {
  store.persistPage("slack.messages", page(msg(T1), msg(T2, { threadTs: T1 })));
  const dump = JSON.stringify(events());
  expect(dump).not.toContain("secret text");
  expect(dump).not.toContain("Ann");
  expect(dump).not.toContain("ann@example.com");
});

test("conversation type is kept; empty name does not overwrite", () => {
  store.persistPage("slack.messages", page(msg(T1)));
  store.persistPage(
    "slack.messages",
    page(msg(T2, { conversationType: "im", conversationName: "" })),
  );
  const c = db.select().from(schema.slackConversations).get();
  expect(c?.type).toBe("channel");
  expect(c?.name).toBe("general");
});

test("storeThread: known conversation dedups, emits, keeps checkpoint; unknown is a no-op", () => {
  store.persistPage("slack.messages", page(msg(T3)));
  const before = sync.get("slack.messages").checkpoint;
  expect(store.storeThread("C1", [msg(T1), msg(T2, { threadTs: T1 })])).toEqual({ inserted: 2 });
  expect(store.storeThread("C1", [msg(T1)])).toEqual({ inserted: 0 });
  expect(sync.get("slack.messages").checkpoint).toBe(before);
  expect(events().filter((e) => e.type === "message.received")).toHaveLength(3);
  expect(store.storeThread("C9", [msg(T1, { conversationId: "C9" })])).toEqual({ inserted: 0 });
  expect(
    db
      .select()
      .from(schema.slackConversations)
      .where(eq(schema.slackConversations.externalId, "C9"))
      .all(),
  ).toHaveLength(0);
});

test("expireContent clears text but keeps ts and permalink", () => {
  const old = msg("1790000000.000000"); // 2026-09-21
  store.persistPage("slack.messages", page(old, msg(T1)));
  expect(store.expireContent(30)).toBe(1);
  expect(store.expireContent(30)).toBe(0);
  const rows = db.select().from(schema.slackMessages).all();
  const exp = rows.find((r) => r.ts === old.ts);
  expect(exp?.text).toBeNull();
  expect(exp?.fullNotes).toBeNull();
  expect(exp?.permalink).toBe(old.permalink as string);
  expect(exp?.contentExpiredAt).toBe(clock.now().toISOString());
  expect(rows.find((r) => r.ts === T1)?.text).toContain("secret");
});

test("listMessages: newest first, filter, limit clamp, shape", () => {
  store.persistPage(
    "slack.messages",
    page(msg(T1), msg(T2), msg(T3, { conversationId: "C2", conversationName: "other" })),
  );
  const all = store.listMessages({ limit: 10 });
  expect(all.map((m) => m.sentAt)).toEqual(
    [T3, T2, T1].map((t) => new Date(Number(t) * 1000).toISOString()),
  );
  expect(all[0]).toMatchObject({
    conversation: { id: "C2", name: "other", type: "channel" },
    sender: { id: "U1", name: "Ann" },
    replyCount: 0,
    threadTs: null,
  });
  expect(store.listMessages({ limit: 10, conversationId: "C1" })).toHaveLength(2);
  expect(store.listMessages({ limit: 0 })).toHaveLength(1);
  expect(store.listMessages({ limit: 10, beforeSentAt: all[1]?.sentAt })).toHaveLength(1);
  store.expireContent(0);
  expect(store.listMessages({ limit: 1 })[0]?.text).toBeNull();
});

test("R61: checkpointLagSeconds caps the checkpoint at now - lag; never moves it back", () => {
  const now = Date.parse("2026-11-05T12:00:00.000Z") / 1000;
  const recent = `${now - 30}.000100`;
  store.persistPage("slack.messages", page(msg(recent)), { checkpointLagSeconds: 300 });
  expect(sync.get("slack.messages").checkpoint).toBe((now - 300).toFixed(6));
  // Already above the cap: unchanged.
  sync.update(db, "slack.messages", { checkpoint: `${now - 10}.000000` });
  store.persistPage("slack.messages", page(msg(`${now - 5}.000100`)), {
    checkpointLagSeconds: 300,
  });
  expect(sync.get("slack.messages").checkpoint).toBe(`${now - 10}.000000`);
  // Without the option (backfill), plain R48: the page max.
  store.persistPage("slack.backfill", page(msg(recent, { conversationId: "C9" })));
  expect(sync.get("slack.backfill").checkpoint).toBe(recent);
});
