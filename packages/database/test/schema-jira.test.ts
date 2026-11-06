import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, runMigrations } from "../src/index.ts";

test("0015 creates jira_issues with a unique key and indexes", () => {
  const { db, sqlite } = openDatabase(join(mkdtempSync(join(tmpdir(), "syn-")), "synapse.db"));
  runMigrations(db);
  const ins = (key: string) =>
    sqlite.run(
      `insert into jira_issues (key, jira_id, project_key, summary, status_name, status_category, issue_type,
        labels, jira_created_at, jira_updated_at, web_url, in_scope, first_seen_at, last_seen_at)
       values (?, '1', 'DEMO', 's', 'To Do', 'new', 'Task', '[]', 't', 't', 'u', 1, 't', 't')`,
      [key],
    );
  ins("DEMO-1");
  expect(() => ins("DEMO-1")).toThrow();
  const idx = sqlite
    .query("select name from pragma_index_list('jira_issues')")
    .all()
    .map((r) => (r as { name: string }).name);
  expect(idx).toContain("jira_issues_scope_category_idx");
  expect(idx).toContain("jira_issues_updated_idx");
});
