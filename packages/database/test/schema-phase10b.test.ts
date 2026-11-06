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
    "insert into repositories (id, name, local_path, upstream_push_disabled, tracked_branch, jira_project_keys, created_at, updated_at) values ('r1','demo-app','/tmp/demo-app',0,'main','[]','t','t')",
  );
}

const session = (id: string, file: string) =>
  [
    `insert into claude_sessions (session_id, repository_id, cwd, first_at, last_at, file_path, file_offset, file_size, file_mtime_ms, updated_at) values ('${id}','r1','/tmp/demo-app','t','t','${file}',0,0,0,'t')`,
  ][0] as string;

function message(sqlite: ReturnType<typeof setup>) {
  const cols = (
    sqlite.query("pragma table_info(slack_messages)").all() as {
      name: string;
      notnull: number;
      dflt_value: unknown;
      pk: number;
    }[]
  ).filter((c) => c.notnull && c.dflt_value === null);
  return cols;
}

function insertMessage(sqlite: ReturnType<typeof setup>, id: string) {
  const cols = message(sqlite);
  const names = cols.map((c) => c.name);
  const vals = cols.map((c) => (c.name === "id" ? id : "x"));
  // The message's own Slack parents are irrelevant here; only code_answers' FKs are under test.
  sqlite.run("PRAGMA foreign_keys = OFF");
  sqlite.run(
    `insert into slack_messages (${names.join(",")}) values (${names.map(() => "?").join(",")})`,
    vals,
  );
  sqlite.run("PRAGMA foreign_keys = ON");
}

const answer = (id: string, status: string) =>
  `insert into code_answers (id, message_id, repository_id, trigger, status, evidence, dropped_evidence_count, created_at, updated_at) values ('${id}','m1','r1','user','${status}','[]',0,'t','t')`;

test("migration applies; live code_answers are unique, failed ones coexist", () => {
  const sqlite = setup();
  seed(sqlite);
  insertMessage(sqlite, "m1");
  sqlite.run(answer("a1", "failed"));
  sqlite.run(answer("a2", "queued"));
  expect(() => sqlite.run(answer("a3", "ready"))).toThrow();
  sqlite.run(answer("a4", "dismissed"));
});

test("deleting a repository cascades sessions and PRs, and nulls code_answers.repository_id", () => {
  const sqlite = setup();
  seed(sqlite);
  insertMessage(sqlite, "m1");
  sqlite.run(session("s1", "/f1"));
  sqlite.run(
    "insert into claude_session_prs (id, session_id, repository_id, pr_url, pr_number, pr_repository, first_seen_at) values ('p1','s1','r1','https://github.com/demo-org/demo-app/pull/7',7,'demo-org/demo-app','t')",
  );
  sqlite.run(answer("a1", "queued"));
  sqlite.run("delete from repositories where id = 'r1'");
  expect(sqlite.query("select count(*) c from claude_sessions").get()).toEqual({ c: 0 });
  expect(sqlite.query("select count(*) c from claude_session_prs").get()).toEqual({ c: 0 });
  expect(sqlite.query("select repository_id r from code_answers").get()).toEqual({ r: null });
});

test("claude_session_prs.pr_url is unique", () => {
  const sqlite = setup();
  seed(sqlite);
  sqlite.run(session("s1", "/f1"));
  const pr = (id: string) =>
    `insert into claude_session_prs (id, session_id, repository_id, pr_url, pr_number, pr_repository, first_seen_at) values ('${id}','s1','r1','https://github.com/demo-org/demo-app/pull/7',7,'demo-org/demo-app','t')`;
  sqlite.run(pr("p1"));
  expect(() => sqlite.run(pr("p2"))).toThrow();
});
