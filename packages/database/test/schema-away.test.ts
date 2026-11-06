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

test("only one open away session; a closed one does not block", () => {
  const sqlite = setup();
  const ins = (id: string, ended: string | null) =>
    sqlite.run("insert into away_sessions (id, started_at, ended_at) values (?,?,?)", [
      id,
      "t",
      ended,
    ]);
  ins("a1", null);
  expect(() => ins("a2", null)).toThrow();
  sqlite.run("update away_sessions set ended_at = 't2' where id = 'a1'");
  ins("a2", null);
  ins("a3", "t3");
});

test("auto_replies and approvals.decided_by exist", () => {
  const sqlite = setup();
  sqlite.run("insert into away_sessions (id, started_at) values ('s1','t')");
  sqlite.run(
    "insert into auto_replies (id, session_id, kind, recipient_slack_user_id, conversation_external_id, decision, created_at) values ('r1','s1','acknowledgement','U1','C1','held','t')",
  );
  const cols = (sqlite.query("pragma table_info(auto_replies)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  for (const c of [
    "thread_ts",
    "source_message_id",
    "followup_id",
    "reason",
    "text",
    "outgoing_id",
    "approval_id",
  ])
    expect(cols).toContain(c);
  const idx = (sqlite.query("pragma index_list(auto_replies)").all() as { name: string }[]).map(
    (i) => i.name,
  );
  expect(idx.length).toBeGreaterThanOrEqual(2);
  const ac = (sqlite.query("pragma table_info(approvals)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  expect(ac).toContain("decided_by");
  expect(() =>
    sqlite.run(
      "insert into auto_replies (id, session_id, kind, recipient_slack_user_id, conversation_external_id, decision, created_at) values ('r2','nope','acknowledgement','U1','C1','held','t')",
    ),
  ).toThrow();
});
