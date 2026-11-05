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
