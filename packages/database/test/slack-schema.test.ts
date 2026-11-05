import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, runMigrations } from "../src/index.ts";

function setup() {
  const { db, sqlite } = openDatabase(join(mkdtempSync(join(tmpdir(), "syn-")), "synapse.db"));
  runMigrations(db);
  return sqlite;
}

function seed(sqlite: ReturnType<typeof setup>) {
  sqlite.run(
    "insert into integrations (id, kind, adapter, enabled, created_at) values ('i1','slack','claude-mcp',1,'t')",
  );
  sqlite.run(
    "insert into slack_conversations (id, external_id, type, accessible) values ('c1','C1','im',1)",
  );
  sqlite.run("insert into slack_users (id, external_id) values ('u1','U1')");
}

function insertMessage(sqlite: ReturnType<typeof setup>, id: string, ts: string, sender = "u1") {
  sqlite.run(
    "insert into slack_messages (id, conversation_id, ts, sender_user_id, sent_at, collected_at) values (?,?,?,?,?,?)",
    [id, "c1", ts, sender, "t", "t"],
  );
}

test("migrations create all eight tables", () => {
  const sqlite = setup();
  const names = sqlite
    .query("select name from sqlite_master where type='table'")
    .all()
    .map((r) => (r as { name: string }).name);
  for (const t of [
    "integrations",
    "integration_capabilities",
    "integration_sync_states",
    "slack_conversations",
    "slack_users",
    "slack_messages",
    "slack_attachments",
    "slack_message_references",
  ])
    expect(names).toContain(t);
});

test("duplicate (conversation_id, ts) throws", () => {
  const sqlite = setup();
  seed(sqlite);
  insertMessage(sqlite, "m1", "1.1");
  expect(() => insertMessage(sqlite, "m2", "1.1")).toThrow();
});

test("duplicate (integration_id, stream) throws", () => {
  const sqlite = setup();
  seed(sqlite);
  const ins = (id: string) =>
    sqlite.run(
      "insert into integration_sync_states (id, integration_id, stream, status) values (?,?,?,?)",
      [id, "i1", "slack.messages", "idle"],
    );
  ins("s1");
  expect(() => ins("s2")).toThrow();
});

test("slack_messages.sender_user_id FK is enforced", () => {
  const sqlite = setup();
  seed(sqlite);
  expect(() => insertMessage(sqlite, "m1", "1.1", "nope")).toThrow();
});
