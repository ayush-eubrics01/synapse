import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { knownMigrationHashes, openDatabase, runMigrations } from "@synapse/database";
import { RESTORE_USAGE, RESTORED_LINE, type RestoreDeps, restore } from "../restore";

const SENTINEL = "SENTINEL-ROW-7f3a";

interface Env {
  dir: string;
  dbPath: string;
  backup: string;
  logs: string[];
  probed: string[];
  deps: RestoreDeps;
  live: Database;
}

function setup(): Env {
  const dir = mkdtempSync(join(tmpdir(), "syn-"));
  const dbPath = join(dir, "synapse.db");
  const { db, sqlite } = openDatabase(dbPath);
  runMigrations(db);
  sqlite.run("create table t (v text)");
  sqlite.run("insert into t values (?)", [SENTINEL]);
  const backup = join(dir, "synapse-20261107-030000.db");
  sqlite.run(`VACUUM INTO '${backup}'`);
  sqlite.run("insert into t values ('post-backup')");
  const logs: string[] = [];
  const probed: string[] = [];
  const deps: RestoreDeps = {
    dbPath,
    port: 7400,
    probe: async (u) => {
      probed.push(u);
      return false;
    },
    knownHashes: knownMigrationHashes(),
    now: () => new Date(2026, 10, 7, 4, 5, 6),
    log: (l) => logs.push(l),
  };
  return { dir, dbPath, backup, logs, probed, deps, live: sqlite };
}

const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const rows = (p: string) =>
  new Database(p, { readonly: true })
    .query("select v from t order by v")
    .all()
    .map((r) => (r as { v: string }).v);

test("no args is usage; no --yes is no_confirm and leaves the live file alone", async () => {
  const e = setup();
  expect(await restore([], e.deps)).toEqual({ ok: false, refusal: "usage" });
  expect(e.logs[0]).toBe(RESTORE_USAGE);
  e.live.close();
  const before = sha(e.dbPath);
  expect(await restore([e.backup], e.deps)).toEqual({ ok: false, refusal: "no_confirm" });
  expect(sha(e.dbPath)).toBe(before);
  expect(e.logs).toContain("restore refused: no_confirm");
});

test("missing backup file", async () => {
  const e = setup();
  expect(await restore([join(e.dir, "nope.db"), "--yes"], e.deps)).toEqual({
    ok: false,
    refusal: "backup_missing",
  });
});

test("api answering refuses, probing /health/live", async () => {
  const e = setup();
  e.deps.probe = async (u) => {
    e.probed.push(u);
    return true;
  };
  expect(await restore([e.backup, "--yes"], e.deps)).toEqual({ ok: false, refusal: "api_running" });
  expect(e.probed).toEqual(["http://127.0.0.1:7400/health/live"]);
});

test("busy live database refuses", async () => {
  const e = setup();
  e.live.run("BEGIN IMMEDIATE");
  expect(await restore([e.backup, "--yes"], e.deps)).toEqual({
    ok: false,
    refusal: "database_busy",
  });
  e.live.run("ROLLBACK");
});

test("garbage backup fails integrity", async () => {
  const e = setup();
  e.live.close();
  const bad = join(e.dir, "bad.db");
  writeFileSync(bad, "this is not a database".repeat(200));
  expect(await restore([bad, "--yes"], e.deps)).toEqual({ ok: false, refusal: "integrity_failed" });
});

test("unknown migration hash refuses", async () => {
  const e = setup();
  e.live.close();
  const b = new Database(e.backup);
  b.run("PRAGMA journal_mode = DELETE");
  b.run("insert into __drizzle_migrations (hash, created_at) values (?, 1)", ["f".repeat(64)]);
  b.close();
  expect(await restore([e.backup, "--yes"], e.deps)).toEqual({
    ok: false,
    refusal: "unknown_migration",
  });
});

test("backup without the migrations table is not a synapse backup", async () => {
  const e = setup();
  e.live.close();
  const other = join(e.dir, "other.db");
  const o = new Database(other);
  o.run("create table x (a)");
  o.close();
  expect(await restore([other, "--yes"], e.deps)).toEqual({
    ok: false,
    refusal: "not_a_synapse_backup",
  });
});

test("restores over a live db with uncheckpointed WAL rows, moving everything aside", async () => {
  const e = setup();
  e.live.run("PRAGMA wal_autocheckpoint = 0");
  e.live.run("insert into t values ('only-in-wal')");
  expect(existsSync(`${e.dbPath}-wal`)).toBe(true);

  const res = await restore([e.backup, "--yes"], e.deps);
  expect(res).toEqual({ ok: true });
  e.live.close();

  const aside = readdirSync(e.dir).filter((f) => f.startsWith("synapse.db.before-restore-"));
  expect(aside).toContain("synapse.db.before-restore-20261107-040506");
  expect(rows(join(e.dir, "synapse.db.before-restore-20261107-040506"))).toEqual([
    SENTINEL,
    "only-in-wal",
    "post-backup",
  ]);
  expect(rows(e.dbPath)).toEqual([SENTINEL]);
  expect(existsSync(`${e.dbPath}-wal`) && statSync(`${e.dbPath}-wal`).size > 0).toBe(false);
  expect(existsSync(`${e.dbPath}.restore-tmp`)).toBe(false);
  for (const f of [e.dbPath, ...aside.map((a) => join(e.dir, a))]) {
    expect(statSync(f).mode & 0o777).toBe(0o600);
  }
  expect(e.logs.at(-1)).toBe(RESTORED_LINE);
  expect(RESTORED_LINE).toBe("restored; start the API to apply any newer migrations");
  expect(e.logs.join("\n")).not.toContain(SENTINEL);
  expect(
    e.logs.some((l) => /^moved aside: synapse\.db\.before-restore-\S+ \(\d+ bytes\)$/.test(l)),
  ).toBe(true);
  expect(e.logs.some((l) => /^restored: synapse\.db \(\d+ bytes\)$/.test(l))).toBe(true);
});
