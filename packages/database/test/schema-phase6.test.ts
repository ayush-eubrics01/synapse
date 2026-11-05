import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, runMigrations } from "../src/index.ts";

function setup() {
  const { db, sqlite } = openDatabase(join(mkdtempSync(join(tmpdir(), "syn-")), "synapse.db"));
  runMigrations(db);
  sqlite.run(
    "insert into slack_conversations (id, external_id, type) values ('cv1','C1','channel')",
  );
  sqlite.run("insert into slack_users (id, external_id) values ('u1','U1')");
  sqlite.run(
    "insert into slack_messages (id, conversation_id, ts, sender_user_id, sent_at, collected_at) values ('m1','cv1','1.1','u1','t','t')",
  );
  return sqlite;
}

const insCommitment = (sqlite: ReturnType<typeof setup>, id: string, dedup: string) =>
  sqlite.run(
    "insert into commitments (id, description, owner_slack_user_id, direction, status, review_status, dedup_key, created_at, updated_at) values (?,?,?,?,?,?,?,?,?)",
    [id, "d", "U1", "mine", "open", "pending_review", dedup, "t", "t"],
  );

test("commitments.dedup_key is unique", () => {
  const sqlite = setup();
  insCommitment(sqlite, "c1", "k");
  expect(() => insCommitment(sqlite, "c2", "k")).toThrow();
  insCommitment(sqlite, "c2", "k2");
});

test("commitment_sources unique per (commitment, ref) and message delete sets null", () => {
  const sqlite = setup();
  insCommitment(sqlite, "c1", "k");
  const ins = (id: string, ref: string) =>
    sqlite.run(
      "insert into commitment_sources (id, commitment_id, message_id, source_external_ref, conversation_id, created_at) values (?,?,?,?,?,?)",
      [id, "c1", "m1", ref, "C1", "t"],
    );
  ins("s1", "C1:1.1");
  expect(() => ins("s2", "C1:1.1")).toThrow();
  sqlite.run("delete from slack_messages where id = 'm1'");
  const row = sqlite
    .query("select message_id, source_external_ref from commitment_sources")
    .get() as {
    message_id: string | null;
    source_external_ref: string;
  };
  expect(row.message_id).toBeNull();
  expect(row.source_external_ref).toBe("C1:1.1");
});

test("outgoing_messages.approval_id is unique; verify_attempts defaults to 0", () => {
  const sqlite = setup();
  sqlite.run(
    "insert into approvals (id, action, payload, risk_level, status, idempotency_key, created_at) values ('a1','slack.send','{}','high','pending','k','t')",
  );
  const ins = (id: string) =>
    sqlite.run(
      "insert into outgoing_messages (id, approval_id, conversation_external_id, text, status, created_at, updated_at) values (?,?,?,?,?,?,?)",
      [id, "a1", "C1", "hi", "pending", "t", "t"],
    );
  ins("o1");
  expect(() => ins("o2")).toThrow();
  const row = sqlite.query("select verify_attempts as n from outgoing_messages").get() as {
    n: number;
  };
  expect(row.n).toBe(0);
});

test("followups and followup_history accept rows; commitment_id is nullable", () => {
  const sqlite = setup();
  sqlite.run(
    "insert into followups (id, origin, conversation_id, status, created_at, updated_at) values ('f1','manual','C1','draft','t','t')",
  );
  sqlite.run(
    "insert into followup_history (id, followup_id, event, detail, created_at) values ('h1','f1','created','','t')",
  );
  insCommitment(sqlite, "c1", "k");
  sqlite.run(
    "insert into commitment_updates (id, commitment_id, actor, field, created_at) values ('u1','c1','user','status','t')",
  );
});

test("slack_messages.commitments_extracted_at is nullable", () => {
  const sqlite = setup();
  const row = sqlite.query("select commitments_extracted_at as v from slack_messages").get() as {
    v: string | null;
  };
  expect(row.v).toBeNull();
});

test("0012 rewrites urgent_reply followups from the external to the internal conversation id", () => {
  const sqlite = setup();
  const ins = (id: string, origin: string, conversation: string) =>
    sqlite.run(
      "insert into followups (id, origin, conversation_id, status, created_at, updated_at) values (?,?,?,'draft','t','t')",
      [id, origin, conversation],
    );
  ins("f-ext", "urgent_reply", "C1");
  ins("f-int", "urgent_reply", "cv1");
  ins("f-unknown", "urgent_reply", "C-gone");
  ins("f-stalled", "stalled", "cv1");
  const sql = readFileSync(
    join(import.meta.dir, "../migrations/0012_followups_conversation_internal.sql"),
    "utf8",
  );
  sqlite.run(sql);
  sqlite.run(sql); // idempotent
  const conv = (id: string) =>
    (
      sqlite.query("select conversation_id as c from followups where id = ?").get(id) as {
        c: string;
      }
    ).c;
  expect(conv("f-ext")).toBe("cv1");
  expect(conv("f-int")).toBe("cv1");
  expect(conv("f-unknown")).toBe("C-gone");
  expect(conv("f-stalled")).toBe("cv1");
});
