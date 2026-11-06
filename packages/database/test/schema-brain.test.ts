import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, runMigrations } from "../src/index.ts";

function fresh() {
  const { db, sqlite } = openDatabase(join(mkdtempSync(join(tmpdir(), "syn-")), "synapse.db"));
  runMigrations(db);
  return sqlite;
}

const repo = (id: string, name: string, path: string) =>
  [
    `insert into repositories (id, name, local_path, upstream_push_disabled, tracked_branch,
      jira_project_keys, created_at, updated_at) values (?, ?, ?, 0, 'main', '[]', 't', 't')`,
    [id, name, path],
  ] as const;

test("0016 creates the brain tables with their uniqueness rules", () => {
  const sqlite = fresh();
  sqlite.run(...repo("r1", "api", "/a"));
  expect(() => sqlite.run(...repo("r2", "api", "/b"))).toThrow();
  expect(() => sqlite.run(...repo("r3", "web", "/a"))).toThrow();
  const cols = sqlite
    .query("select name from pragma_table_info('repositories')")
    .all()
    .map((r) => (r as { name: string }).name);
  expect(cols).toContain("drift");
  expect(cols).toContain("inspected_head_sha");

  sqlite.run(
    `insert into repository_environments (id, repository_id, name, branch, protected, auto_deploys_on_merge)
     values ('e1', 'r1', 'prod', 'main', 1, 0)`,
  );
  expect(() =>
    sqlite.run(
      `insert into repository_environments (id, repository_id, name, branch, protected, auto_deploys_on_merge)
       values ('e2', 'r1', 'prod', 'x', 0, 0)`,
    ),
  ).toThrow();

  sqlite.run(
    `insert into projects (id, name, created_at, updated_at) values ('p1', 'api', 't', 't')`,
  );
  expect(() =>
    sqlite.run(
      `insert into projects (id, name, created_at, updated_at) values ('p2', 'api', 't', 't')`,
    ),
  ).toThrow();
  sqlite.run(`insert into project_repositories (project_id, repository_id) values ('p1', 'r1')`);
  expect(() =>
    sqlite.run(`insert into project_repositories (project_id, repository_id) values ('p1', 'r1')`),
  ).toThrow();

  sqlite.run(
    `insert into project_facts (id, project_id, kind, content, evidence, status, source, created_at)
     values ('f1', 'p1', 'stack', 'Bun', '[{"path":"a"}]', 'needs_review', 'inspection', 't')`,
  );
  expect(() =>
    sqlite.run(
      `insert into project_facts (id, project_id, kind, content, evidence, status, source, created_at)
       values ('f2', 'nope', 'stack', 'x', '[]', 'needs_review', 'user', 't')`,
    ),
  ).toThrow();
  sqlite.run(
    `insert into project_milestones (id, project_id, name, target_date, status, created_at, updated_at)
     values ('m1', 'p1', 'v1', '2026-12-01', 'planned', 't', 't')`,
  );
});
