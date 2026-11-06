import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { knownMigrationHashes, openDatabase, runMigrations } from "../src/index.ts";

const repoRoot = join(import.meta.dir, "../../..");

function tmpDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "syn-")), "synapse.db");
}

test("creates missing parent dirs and applies pragmas", () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-"));
  const { sqlite } = openDatabase(join(dir, "a/b/synapse.db"));
  expect(sqlite.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
  expect(sqlite.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  expect(sqlite.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
});

test("migrations create platform tables", () => {
  const { db, sqlite } = openDatabase(tmpDbPath());
  runMigrations(db);
  const names = sqlite
    .query("select name from sqlite_master where type='table'")
    .all()
    .map((r) => (r as { name: string }).name);
  for (const t of [
    "jobs",
    "domain_events",
    "event_consumptions",
    "approvals",
    "leases",
    "scheduled_tasks",
    "audit_events",
    "auth_snapshots",
  ])
    expect(names).toContain(t);
});

test("foreign keys enforced", () => {
  const { db, sqlite } = openDatabase(tmpDbPath());
  runMigrations(db);
  expect(() =>
    sqlite.run(
      "insert into job_attempts (id, job_id, attempt, started_at, status) values ('x','missing',1,'t','RUNNING')",
    ),
  ).toThrow();
});

test("second connection waits instead of SQLITE_BUSY", async () => {
  const p = tmpDbPath();
  const a = openDatabase(p);
  runMigrations(a.db);
  a.sqlite.run("BEGIN IMMEDIATE");
  setTimeout(() => a.sqlite.run("COMMIT"), 200);
  const proc = Bun.spawn(
    [
      "bun",
      "-e",
      `
    const { openDatabase } = await import("@synapse/database");
    openDatabase(${JSON.stringify(p)}).sqlite.run("insert into app_settings (key, value, updated_at) values ('k','1','t')");`,
    ],
    { cwd: repoRoot },
  );
  expect(await proc.exited).toBe(0);
});

test("knownMigrationHashes matches the journal and the stored hashes", () => {
  const { readMigrationFiles } = require("drizzle-orm/migrator");
  const folder = join(import.meta.dir, "../migrations");
  const known = knownMigrationHashes();
  expect(known.size).toBe(readMigrationFiles({ migrationsFolder: folder }).length);
  const { db, sqlite } = openDatabase(tmpDbPath());
  runMigrations(db);
  const stored = sqlite.query("select hash from __drizzle_migrations").all() as { hash: string }[];
  expect(stored.length).toBe(known.size);
  for (const r of stored) expect(known.has(r.hash)).toBe(true);
});
