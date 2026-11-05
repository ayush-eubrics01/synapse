import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, runMigrations } from "../src/index.ts";

function setup() {
  const { db, sqlite } = openDatabase(join(mkdtempSync(join(tmpdir(), "syn-")), "synapse.db"));
  runMigrations(db);
  sqlite.run("insert into people (id, slack_user_id, created_at) values ('p1','U1','t')");
  sqlite.run(
    "insert into people_profile_recommendations (id, person_id, kind, status, created_at) values ('r1','p1','initial','pending','t')",
  );
  sqlite.run(
    "insert into people_profiles (id, person_id, current_version, content, updated_at) values ('pp1','p1',1,'{}','t')",
  );
  return sqlite;
}

test("people_profile_versions is unique per (profile, version)", () => {
  const sqlite = setup();
  const ins = (id: string, version: number) =>
    sqlite.run(
      "insert into people_profile_versions (id, profile_id, version, content, recommendation_id, created_at) values (?,?,?,?,?,?)",
      [id, "pp1", version, "{}", "r1", "t"],
    );
  ins("v1", 1);
  expect(() => ins("v1b", 1)).toThrow();
  ins("v2", 2);
});

test("temporary_contacts.slack_user_id is unique and message_count defaults to 0", () => {
  const sqlite = setup();
  const ins = (id: string) =>
    sqlite.run(
      "insert into temporary_contacts (id, slack_user_id, first_seen_at, last_seen_at, expires_at) values (?,?,?,?,?)",
      [id, "U9", "t", "t", "t"],
    );
  ins("t1");
  expect(() => ins("t2")).toThrow();
  const row = sqlite.query("select message_count as c from temporary_contacts").get() as {
    c: number;
  };
  expect(row.c).toBe(0);
});

test("people_profiles.person_id is unique; people has title and team", () => {
  const sqlite = setup();
  expect(() =>
    sqlite.run(
      "insert into people_profiles (id, person_id, current_version, content, updated_at) values ('pp2','p1',1,'{}','t')",
    ),
  ).toThrow();
  sqlite.run("update people set title='Eng', team='Core' where id='p1'");
});

test("evidence keeps source_external_ref when the message is gone", () => {
  const sqlite = setup();
  sqlite.run(
    "insert into people_profile_evidence (id, recommendation_id, observation_key, source_external_ref, confidence, observed_at) values ('e1','r1','k','C1:1','high','t')",
  );
  expect(() =>
    sqlite.run(
      "insert into people_profile_evidence (id, recommendation_id, observation_key, confidence, observed_at) values ('e2','r1','k','low','t')",
    ),
  ).toThrow();
});
