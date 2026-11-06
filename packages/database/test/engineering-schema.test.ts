import { expect, test } from "bun:test";
import { openDatabase, runMigrations } from "../src/index.ts";

function setup() {
  const { db, sqlite } = openDatabase(":memory:");
  runMigrations(db);
  sqlite.run(
    "insert into repositories (id, name, local_path, upstream_push_disabled, tracked_branch, jira_project_keys, created_at, updated_at) values ('r1','n','/tmp/a/b',0,'main','[]','t','t')",
  );
  return sqlite;
}

test("repositories.test_command is nullable", () => {
  const sqlite = setup();
  const row = sqlite.query("select test_command from repositories where id='r1'").get() as {
    test_command: string | null;
  };
  expect(row.test_command).toBeNull();
});

const insTask = (s: ReturnType<typeof setup>, id: string) =>
  s.run(
    "insert into engineering_tasks (id, repository_id, source, title, draft_description, status, created_at, updated_at) values (?,?,?,?,?,?,?,?)",
    [id, "r1", "manual", "t", "d", "proposed", "t", "t"],
  );

test("engineering task steps are unique per task and cascade", () => {
  const s = setup();
  insTask(s, "t1");
  const step = (id: string, name: string) =>
    s.run(
      "insert into engineering_task_steps (id, task_id, step, status, created_at, updated_at) values (?,?,?,?,?,?)",
      [id, "t1", name, "pending", "t", "t"],
    );
  step("s1", "investigate");
  expect(() => step("s2", "investigate")).toThrow();
  step("s2", "branch");
  s.run("delete from engineering_tasks where id='t1'");
  expect(s.query("select count(*) c from engineering_task_steps").get()).toEqual({ c: 0 });
});

test("engineering task requires an existing repository", () => {
  const s = setup();
  expect(() =>
    s.run(
      "insert into engineering_tasks (id, repository_id, source, title, draft_description, status, created_at, updated_at) values ('t','nope','manual','t','d','proposed','t','t')",
    ),
  ).toThrow();
});
