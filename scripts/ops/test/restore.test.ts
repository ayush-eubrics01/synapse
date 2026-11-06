import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { knownMigrationHashes, openDatabase, runMigrations } from "@synapse/database";
import { RESTORE_USAGE, RESTORED_LINE, type RestoreDeps, restore } from "../restore";

const SENTINEL = "SENTINEL-ROW-7f3a";
const ASIDE = "synapse.db.before-restore-20261107-040506-abcdef";

const dirs: string[] = [];
const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) {
    try {
      d.close();
    } catch {
      // already closed
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "syn-"));
  dirs.push(d);
  return d;
};
const track = (d: Database) => {
  dbs.push(d);
  return d;
};

interface Env {
  dir: string;
  dbPath: string;
  backup: string;
  logs: string[];
  probed: string[];
  deps: RestoreDeps;
  live: Database;
}

/** A live DB with the sentinel row, a VACUUM INTO backup, then one more row. The live connection stays open. */
function setup(): Env {
  const dir = tmp();
  const dbPath = join(dir, "synapse.db");
  const { db, sqlite } = openDatabase(dbPath);
  track(sqlite);
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
    host: "127.0.0.1",
    port: 7400,
    probe: async (u) => {
      probed.push(u);
      return "down";
    },
    knownHashes: knownMigrationHashes(),
    now: () => new Date(2026, 10, 7, 4, 5, 6),
    log: (l) => logs.push(l),
    diskFree: () => 10 * 2 ** 30,
    rand: () => "abcdef",
  };
  return { dir, dbPath, backup, logs, probed, deps, live: sqlite };
}

const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
function rows(p: string): string[] {
  const d = new Database(p, { readonly: true });
  try {
    return d
      .query("select v from t order by v")
      .all()
      .map((r) => (r as { v: string }).v);
  } finally {
    d.close();
  }
}
const names = (dir: string) => readdirSync(dir).sort();

test("no args or unknown flags is usage; no --yes is no_confirm and leaves the live file alone", async () => {
  const e = setup();
  expect(await restore([], e.deps)).toEqual({ ok: false, refusal: "usage" });
  expect(e.logs[0]).toBe(RESTORE_USAGE);
  expect(await restore([e.backup, "--yes", "--force"], e.deps)).toEqual({
    ok: false,
    refusal: "usage",
  });
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

test("a backup with a sibling -wal is refused", async () => {
  const e = setup();
  writeFileSync(`${e.backup}-wal`, "x");
  expect(await restore([e.backup, "--yes"], e.deps)).toEqual({
    ok: false,
    refusal: "backup_has_wal",
  });
});

test("api answering refuses, probing /health/live", async () => {
  const e = setup();
  e.deps.probe = async (u) => {
    e.probed.push(u);
    return "up";
  };
  expect(await restore([e.backup, "--yes"], e.deps)).toEqual({ ok: false, refusal: "api_running" });
  expect(e.probed).toEqual(["http://127.0.0.1:7400/health/live"]);
});

test("an unknown API state refuses (fail closed) and the configured host is probed", async () => {
  const e = setup();
  e.deps.host = "::1";
  e.deps.probe = async (u) => {
    e.probed.push(u);
    return "unknown";
  };
  expect(await restore([e.backup, "--yes"], e.deps)).toEqual({
    ok: false,
    refusal: "api_state_unknown",
  });
  expect(e.probed).toEqual(["http://[::1]:7400/health/live"]);
});

test("a connection holding BEGIN IMMEDIATE refuses with database_busy", async () => {
  const e = setup();
  e.live.run("BEGIN IMMEDIATE");
  expect(await restore([e.backup, "--yes"], e.deps)).toEqual({
    ok: false,
    refusal: "database_busy",
  });
  e.live.run("ROLLBACK");
  expect(names(e.dir).filter((n) => n.includes("before-restore"))).toEqual([]);
});

test("an active reader that blocks the checkpoint refuses with database_busy", async () => {
  const e = setup();
  const reader = track(new Database(e.dbPath, { readonly: true }));
  reader.run("BEGIN");
  reader.query("select count(*) from t").get();
  expect(await restore([e.backup, "--yes"], e.deps)).toEqual({
    ok: false,
    refusal: "database_busy",
  });
  reader.run("ROLLBACK");
  expect(rows(e.dbPath)).toEqual([SENTINEL, "post-backup"]);
});

test("garbage backup fails integrity and the live rows are unchanged", async () => {
  const e = setup();
  const bad = join(e.dir, "bad.db");
  writeFileSync(bad, "this is not a database".repeat(200));
  expect(await restore([bad, "--yes"], e.deps)).toEqual({ ok: false, refusal: "integrity_failed" });
  e.live.close();
  expect(rows(e.dbPath)).toEqual([SENTINEL, "post-backup"]);
  expect(
    names(e.dir).filter((n) => n.includes("before-restore") || n.includes(".restore-tmp")),
  ).toEqual([]);
});

test("unknown migration hash refuses", async () => {
  const e = setup();
  e.live.close();
  const b = track(new Database(e.backup));
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
  const o = track(new Database(other));
  o.run("create table x (a)");
  o.close();
  expect(await restore([other, "--yes"], e.deps)).toEqual({
    ok: false,
    refusal: "not_a_synapse_backup",
  });
});

test("not enough free space refuses before anything changes", async () => {
  const e = setup();
  e.live.close();
  e.deps.diskFree = () => 1000;
  expect(await restore([e.backup, "--yes"], e.deps)).toEqual({
    ok: false,
    refusal: "insufficient_space",
  });
  expect(rows(e.dbPath)).toEqual([SENTINEL, "post-backup"]);
});

test("restores over a hot WAL (no connection open); the set-aside main file holds the WAL rows", async () => {
  const e = setup();
  // Snapshot the live db plus its uncheckpointed -wal into a fresh dir, then close the writer.
  e.live.run("PRAGMA wal_autocheckpoint = 0");
  e.live.run("insert into t values ('only-in-wal')");
  const dir = tmp();
  const dbPath = join(dir, "synapse.db");
  copyFileSync(e.dbPath, dbPath);
  copyFileSync(`${e.dbPath}-wal`, `${dbPath}-wal`);
  const backup = join(dir, "synapse-20261107-030000.db");
  copyFileSync(e.backup, backup);
  e.live.close();
  expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);
  const logs: string[] = [];
  const deps = { ...e.deps, dbPath, log: (l: string) => logs.push(l) };

  expect(await restore([backup, "--yes"], deps)).toEqual({ ok: true });

  const aside = names(dir).filter((f) => f.startsWith("synapse.db.before-restore-"));
  expect(aside).toContain(ASIDE);
  // Only the main file: proves the checkpoint ran before the move.
  const solo = join(tmp(), "solo.db");
  copyFileSync(join(dir, ASIDE), solo);
  expect(rows(solo)).toEqual([SENTINEL, "only-in-wal", "post-backup"]);
  // The restored db has exactly the backup's rows, with no foreign WAL.
  expect(rows(dbPath)).toEqual([SENTINEL]);
  expect(existsSync(`${dbPath}-wal`) && statSync(`${dbPath}-wal`).size > 0).toBe(false);
  expect(names(dir).filter((n) => n.startsWith(".restore-tmp"))).toEqual([]);
  for (const f of [dbPath, ...aside.map((a) => join(dir, a))]) {
    expect(statSync(f).mode & 0o777).toBe(0o600);
  }
  expect(logs.at(-1)).toBe(RESTORED_LINE);
  expect(RESTORED_LINE).toBe("restored; start the API to apply any newer migrations");
  expect(logs.join("\n")).not.toContain(SENTINEL);
  expect(
    logs.some((l) => /^moved aside: synapse\.db\.before-restore-\S+ \(\d+ bytes\)$/.test(l)),
  ).toBe(true);
  expect(logs.some((l) => /^restored: synapse\.db \(\d+ bytes\)$/.test(l))).toBe(true);
});

test("no live database: the backup is copied in", async () => {
  const e = setup();
  e.live.close();
  rmSync(e.dbPath);
  rmSync(`${e.dbPath}-wal`, { force: true });
  rmSync(`${e.dbPath}-shm`, { force: true });
  expect(await restore([e.backup, "--yes"], e.deps)).toEqual({ ok: true });
  expect(rows(e.dbPath)).toEqual([SENTINEL]);
  expect(names(e.dir).filter((n) => n.includes("before-restore"))).toEqual([]);
});

test("a stray -wal with no db is moved aside, never replayed", async () => {
  const e = setup();
  e.live.run("PRAGMA wal_autocheckpoint = 0");
  e.live.run("insert into t values ('stray')");
  const dir = tmp();
  const dbPath = join(dir, "synapse.db");
  copyFileSync(`${e.dbPath}-wal`, `${dbPath}-wal`);
  const backup = join(dir, "synapse-20261107-030000.db");
  copyFileSync(e.backup, backup);
  e.live.close();
  const deps = { ...e.deps, dbPath };
  expect(await restore([backup, "--yes"], deps)).toEqual({ ok: true });
  expect(names(dir)).toContain(`${ASIDE}-wal`);
  expect(rows(dbPath)).toEqual([SENTINEL]);
});

test("an existing aside name is never overwritten", async () => {
  const e = setup();
  e.live.close();
  writeFileSync(join(e.dir, ASIDE), "precious");
  expect(await restore([e.backup, "--yes"], e.deps)).toEqual({
    ok: false,
    refusal: "aside_exists",
  });
  expect(readFileSync(join(e.dir, ASIDE), "utf8")).toBe("precious");
  expect(rows(e.dbPath)).toEqual([SENTINEL, "post-backup"]);
});

test("a copy failure leaves the live set in place and no tmp file", async () => {
  const e = setup();
  e.live.close();
  e.deps.copy = (_from, to) => {
    writeFileSync(to, "partial");
    throw new Error("ENOSPC");
  };
  expect(await restore([e.backup, "--yes"], e.deps)).toEqual({
    ok: false,
    refusal: "restore_failed",
  });
  expect(rows(e.dbPath)).toEqual([SENTINEL, "post-backup"]);
  expect(
    names(e.dir).filter((n) => n.includes(".restore-tmp") || n.includes("before-restore")),
  ).toEqual([]);
  expect(e.logs.join("\n")).not.toContain("ENOSPC");
});
