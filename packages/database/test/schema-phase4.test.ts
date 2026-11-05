import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, runMigrations } from "../src/index.ts";

function setup() {
  const { db, sqlite } = openDatabase(join(mkdtempSync(join(tmpdir(), "syn-")), "synapse.db"));
  runMigrations(db);
  sqlite.run(
    "insert into slack_conversations (id, external_id, type, accessible) values ('c1','C1','im',1)",
  );
  sqlite.run("insert into slack_users (id, external_id) values ('u1','U1')");
  sqlite.run(
    "insert into slack_messages (id, conversation_id, ts, sender_user_id, sent_at, collected_at) values ('m1','c1','1','u1','t','t')",
  );
  return sqlite;
}

function flag(sqlite: ReturnType<typeof setup>, id: string, detector: string, ruleId: string) {
  sqlite.run(
    "insert into security_flags (id, message_id, source_external_ref, slack_user_id, detector, rule_id, severity, excerpt, reason, status, created_at, updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?)",
    [id, "m1", "C1:1", "U1", detector, ruleId, "high", "x", "r", "open", "t", "t"],
  );
}

test("security_flags is unique per (message, detector, rule_id)", () => {
  const sqlite = setup();
  flag(sqlite, "f1", "rules", "r1");
  expect(() => flag(sqlite, "f2", "rules", "r1")).toThrow();
  flag(sqlite, "f3", "rules", "r2");
  flag(sqlite, "f4", "ai", "ai");
});

test("people.slack_user_id is unique and priority is unique per person", () => {
  const sqlite = setup();
  sqlite.run("insert into people (id, slack_user_id, created_at) values ('p1','U1','t')");
  expect(() =>
    sqlite.run("insert into people (id, slack_user_id, created_at) values ('p2','U1','t')"),
  ).toThrow();
  const ins = (id: string) =>
    sqlite.run(
      "insert into people_priority_settings (id, person_id, priority, updated_at) values (?,?,?,?)",
      [id, "p1", "high", "t"],
    );
  ins("s1");
  expect(() => ins("s2")).toThrow();
});

test("message_drafts is unique per (message, kind)", () => {
  const sqlite = setup();
  const ins = (id: string) =>
    sqlite.run(
      "insert into message_drafts (id, message_id, kind, confidence, status, created_at) values (?,?,?,?,?,?)",
      [id, "m1", "suggested_response", 0.5, "proposed", "t"],
    );
  ins("d1");
  expect(() => ins("d2")).toThrow();
});

test("security_flag_rules.version is unique", () => {
  const sqlite = setup();
  const ins = (id: string) =>
    sqlite.run(
      "insert into security_flag_rules (id, version, rules, active, created_at) values (?,?,?,?,?)",
      [id, 1, "[]", 1, "t"],
    );
  ins("a");
  expect(() => ins("b")).toThrow();
});
