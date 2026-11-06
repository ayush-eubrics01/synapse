import { beforeEach, expect, test } from "bun:test";
import { openDatabase, runMigrations, schema } from "@synapse/database";
import { FakeClock } from "@synapse/shared";
import { SyncStateService } from "../../src/modules/inbox/sync-state";

let db: ReturnType<typeof openDatabase>["db"];
let clock: FakeClock;
let sync: SyncStateService;

beforeEach(() => {
  db = openDatabase(":memory:").db;
  runMigrations(db);
  clock = new FakeClock("2026-11-05T23:59:00.000Z");
  sync = new SyncStateService(db, clock);
});

test("ensureIntegration is idempotent", () => {
  const a = sync.ensureIntegration("slack", "claude-connector");
  expect(sync.ensureIntegration("slack", "claude-connector")).toBe(a);
  expect(db.select().from(schema.integrations).all()).toHaveLength(1);
});

test("get creates an idle row per stream; update patches it", () => {
  const s = sync.get("slack.messages");
  expect(s).toMatchObject({ status: "idle", checkpoint: null, pagesDone: 0, searchCount: 0 });
  db.transaction((tx) => sync.update(tx, "slack.messages", { status: "running", pagesDone: 2 }));
  expect(sync.get("slack.messages")).toMatchObject({ status: "running", pagesDone: 2 });
  expect(sync.get("slack.backfill").status).toBe("idle");
  expect(db.select().from(schema.integrationSyncStates).all()).toHaveLength(2);
});

test("countSearches accumulates and resets on a new UTC day", () => {
  expect(db.transaction((tx) => sync.countSearches(tx, "slack.messages", 2))).toBe(2);
  expect(db.transaction((tx) => sync.countSearches(tx, "slack.messages", 3))).toBe(5);
  clock.advance(2 * 60_000);
  expect(db.transaction((tx) => sync.countSearches(tx, "slack.messages", 1))).toBe(1);
  expect(sync.get("slack.messages").searchCountDate).toBe("2026-11-06");
});

test("jira streams live under their own integration row", () => {
  db.transaction((tx) =>
    sync.update(tx, "jira.issues", { checkpoint: "2026-11-05T00:00:00.000Z" }),
  );
  sync.get("slack.messages");
  sync.get("jira.reconcile");
  const kinds = db
    .select()
    .from(schema.integrations)
    .all()
    .map((i) => i.kind)
    .sort();
  expect(kinds).toEqual(["jira", "slack"]);
  expect(sync.get("jira.issues").checkpoint).toBe("2026-11-05T00:00:00.000Z");
  expect(sync.get("slack.messages").checkpoint).toBeNull();
  const rows = db.select().from(schema.integrationSyncStates).all();
  const byStream = new Map(rows.map((r) => [r.stream, r.integrationId]));
  expect(byStream.get("jira.issues")).toBe(byStream.get("jira.reconcile"));
  expect(byStream.get("jira.issues")).not.toBe(byStream.get("slack.messages"));
});

test("backward compatible: a Slack integration row and slack.messages state written before Jira resolve to the same row", () => {
  // Seeded the way the pre-Phase-8 service wrote them: one slack integration, one state row.
  db.insert(schema.integrations)
    .values({
      id: "slack-int-legacy",
      kind: "slack",
      adapter: "claude-connector",
      createdAt: "2026-10-01T00:00:00.000Z",
    })
    .run();
  db.insert(schema.integrationSyncStates)
    .values({
      id: "state-legacy",
      integrationId: "slack-int-legacy",
      stream: "slack.messages",
      status: "idle",
      checkpoint: "1730000000.000100",
      generation: "gen-legacy",
    })
    .run();

  const fresh = new SyncStateService(db, clock);
  const s = fresh.get("slack.messages");
  expect(s.checkpoint).toBe("1730000000.000100");
  expect(s.generation).toBe("gen-legacy");
  db.transaction((tx) => fresh.update(tx, "slack.messages", { pagesDone: 4 }));
  // Jira gets its own integration row; the legacy rows are reused, never duplicated.
  fresh.get("jira.issues");
  const rows = db.select().from(schema.integrationSyncStates).all();
  const slackRows = rows.filter((r) => r.stream === "slack.messages");
  expect(slackRows).toHaveLength(1);
  expect(slackRows[0]).toMatchObject({
    id: "state-legacy",
    integrationId: "slack-int-legacy",
    pagesDone: 4,
  });
  const ints = db.select().from(schema.integrations).all();
  expect(ints.filter((i) => i.kind === "slack").map((i) => i.id)).toEqual(["slack-int-legacy"]);
  expect(ints.filter((i) => i.kind === "jira")).toHaveLength(1);
});
