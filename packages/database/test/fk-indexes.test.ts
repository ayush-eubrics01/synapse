import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, runMigrations } from "../src/index.ts";

function migrated() {
  const { db, sqlite } = openDatabase(join(mkdtempSync(join(tmpdir(), "syn-")), "synapse.db"));
  runMigrations(db);
  return sqlite;
}

test("every foreign-key column leads an index or the primary key", () => {
  const sqlite = migrated();
  const tables = sqlite
    .query(
      "select name from sqlite_master where type='table' and name not like 'sqlite_%' and name not like '\\_\\_drizzle%' escape '\\'",
    )
    .all() as { name: string }[];
  const missing: string[] = [];
  for (const { name } of tables) {
    const fks = sqlite.query(`pragma foreign_key_list("${name}")`).all() as { from: string }[];
    if (fks.length === 0) continue;
    const leading = new Set<string>();
    const indexes = sqlite.query(`pragma index_list("${name}")`).all() as { name: string }[];
    for (const ix of indexes) {
      const cols = sqlite.query(`pragma index_info("${ix.name}")`).all() as {
        seqno: number;
        name: string;
      }[];
      const first = cols.find((c) => c.seqno === 0);
      if (first) leading.add(first.name);
    }
    const pk = (
      sqlite.query(`pragma table_info("${name}")`).all() as { name: string; pk: number }[]
    ).find((c) => c.pk === 1);
    if (pk) leading.add(pk.name);
    for (const fk of fks) if (!leading.has(fk.from)) missing.push(`${name}.${fk.from}`);
  }
  expect([...new Set(missing)].sort()).toEqual([]);
});

test("jira_issues.jira_id leads an index", () => {
  const sqlite = migrated();
  const indexes = sqlite.query(`pragma index_list("jira_issues")`).all() as { name: string }[];
  const leads = indexes.some((ix) => {
    const cols = sqlite.query(`pragma index_info("${ix.name}")`).all() as {
      seqno: number;
      name: string;
    }[];
    return cols.some((c) => c.seqno === 0 && c.name === "jira_id");
  });
  expect(leads).toBe(true);
});

test("repositories.inspection_warning is a nullable column", () => {
  const sqlite = migrated();
  const col = (
    sqlite.query(`pragma table_info("repositories")`).all() as { name: string; notnull: number }[]
  ).find((c) => c.name === "inspection_warning");
  expect(col).toBeDefined();
  expect(col?.notnull).toBe(0);
});
