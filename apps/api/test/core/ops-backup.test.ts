import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, openDatabase, runMigrations, schema } from "@synapse/database";
import { FakeClock } from "@synapse/shared";
import { AuditLogger } from "../../src/core/audit/audit";
import { BackupService, backupFileName } from "../../src/core/ops/backup";
import { dailyDue } from "../../src/core/ops/daily";

const SENTINEL = "SENTINEL-ROW-7f3a";
const FIXED = () => "synapse-20261107-030000.db";
let root: string;
let dir: string;
let db: Db;
let sqlite: Database;
let clock: FakeClock;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "syn-"));
  dir = join(root, "backups");
  const opened = openDatabase(join(root, "synapse.db"));
  db = opened.db;
  sqlite = opened.sqlite;
  runMigrations(db);
  sqlite.run("create table sentinel (v text)");
  sqlite.run("insert into sentinel values (?)", [SENTINEL]);
  clock = new FakeClock(new Date("2026-11-07T03:00:00.000Z"));
});
afterEach(() => {
  sqlite.close();
  rmSync(root, { recursive: true, force: true });
});

function svc(over: Partial<ConstructorParameters<typeof BackupService>[0]> = {}) {
  return new BackupService({
    db,
    sqlite,
    clock,
    audit: new AuditLogger(clock),
    dir,
    dbPath: join(root, "synapse.db"),
    diskFree: () => 100 * 2 ** 30,
    fileName: FIXED,
    ...over,
  });
}
const audits = (action: string) =>
  db
    .select()
    .from(schema.auditEvents)
    .all()
    .filter((a) => a.action === action);

test("success: 0600 file in 0700 dir, readable copy, audited without row content", () => {
  const s = svc();
  const r = s.run(7);
  expect(r).toMatchObject({ ok: true, name: "synapse-20261107-030000.db", pruned: 0 });
  if (!r.ok) throw new Error("x");
  expect(r.bytes).toBeGreaterThan(0);
  const file = join(dir, r.name);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  const copy = new Database(file, { readonly: true });
  expect(copy.query("select v from sentinel").all()).toEqual([{ v: SENTINEL }]);
  copy.close();
  const a = audits("ops.backup_created");
  expect(a).toHaveLength(1);
  expect(a[0]?.details).toMatchObject({ name: r.name, bytes: r.bytes });
  expect(JSON.stringify(a[0]?.details)).not.toContain(SENTINEL);
  expect(s.lastAttempt()?.ok).toBe(true);
});

test("corrupt output fails integrity, leaves nothing, audits the code", () => {
  const s = svc({ vacuumInto: (t) => writeFileSync(t, Buffer.alloc(4096, 7)) });
  expect(s.run(7)).toEqual({ ok: false, failure: "integrity_failed" });
  expect(readdirSync(dir)).toEqual([]);
  expect(audits("ops.backup_failed")[0]?.details).toEqual({ code: "integrity_failed" });
  expect(s.lastAttempt()?.ok).toBe(false);
});

test("disk full during VACUUM INTO: tmp removed, vacuum_failed, no partial backup", () => {
  const s = svc({
    vacuumInto: (t) => {
      writeFileSync(t, Buffer.alloc(2048, 1));
      throw new Error("SQLITE_FULL: database or disk is full");
    },
  });
  expect(s.run(7)).toEqual({ ok: false, failure: "vacuum_failed" });
  expect(readdirSync(dir)).toEqual([]);
  expect(audits("ops.backup_failed")[0]?.details).toEqual({ code: "vacuum_failed" });
  expect(JSON.stringify(audits("ops.backup_failed"))).not.toContain("SQLITE_FULL");
});

test("insufficient space: no vacuum attempted", () => {
  let called = 0;
  const s = svc({ diskFree: () => 100 * 2 ** 20, vacuumInto: () => void called++ });
  expect(s.run(7)).toEqual({ ok: false, failure: "insufficient_space" });
  expect(called).toBe(0);
});

test("unknown free space does not block", () => {
  expect(svc({ diskFree: () => null }).run(7).ok).toBe(true);
});

test("target exists: tmp removed, existing kept", () => {
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(join(dir, FIXED()), "old");
  expect(svc().run(7)).toEqual({ ok: false, failure: "target_exists" });
  expect(readdirSync(dir)).toEqual([FIXED()]);
});

test("dir that cannot be created is dir_unavailable", () => {
  writeFileSync(join(root, "afile"), "x");
  expect(svc({ dir: join(root, "afile", "sub") }).run(7)).toEqual({
    ok: false,
    failure: "dir_unavailable",
  });
});

test("a dir inside the repository is refused", () => {
  const inRepo = join(import.meta.dir, "..", "..", "..", "..", "tmp-backup-test-never-created");
  expect(svc({ dir: inRepo }).run(7)).toEqual({ ok: false, failure: "dir_unavailable" });
  expect(existsSync(inRepo)).toBe(false);
});

test("a symlinked dir that resolves inside the repository is refused", () => {
  const { symlinkSync } = require("node:fs") as typeof import("node:fs");
  const link = join(root, "link");
  symlinkSync(join(import.meta.dir, ".."), link);
  expect(svc({ dir: link }).run(7)).toEqual({ ok: false, failure: "dir_unavailable" });
});

test("prune touches only synapse-YYYYMMDD-HHMMSS.db files", () => {
  mkdirSync(dir, { mode: 0o700 });
  const others = [
    "synapse.db",
    "synapse.db.before-restore-20261101-000000",
    "synapse-notes.db",
    "other.db",
  ];
  for (const o of others) writeFileSync(join(dir, o), "keep");
  const old = ["20261101", "20261102", "20261103", "20261104"].map((d) => `synapse-${d}-030000.db`);
  old.forEach((n, i) => {
    writeFileSync(join(dir, n), "b");
    const t = new Date(Date.UTC(2026, 10, 1 + i));
    utimesSync(join(dir, n), t, t);
  });
  const r = svc().run(2);
  expect(r).toMatchObject({ ok: true, pruned: 3 });
  const left = readdirSync(dir).sort();
  expect(left).toEqual([...others, "synapse-20261104-030000.db", FIXED()].sort());
});

test("leftover tmp files are deleted", () => {
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(join(dir, ".synapse-old.tmp"), "junk");
  svc().run(7);
  expect(existsSync(join(dir, ".synapse-old.tmp"))).toBe(false);
});

test("list is newest first and ignores other names", () => {
  mkdirSync(dir, { mode: 0o700 });
  for (const [n, day] of [
    ["synapse-20261101-030000.db", 1],
    ["synapse-20261103-030000.db", 3],
    ["synapse-20261102-030000.db", 2],
    ["other.db", 9],
  ] as const) {
    writeFileSync(join(dir, n), "xx");
    const t = new Date(Date.UTC(2026, 10, day));
    utimesSync(join(dir, n), t, t);
  }
  const l = svc().list();
  expect(l.map((e) => e.name)).toEqual([
    "synapse-20261103-030000.db",
    "synapse-20261102-030000.db",
    "synapse-20261101-030000.db",
  ]);
  expect(l[0]).toEqual({
    name: "synapse-20261103-030000.db",
    bytes: 2,
    createdAt: "2026-11-03T00:00:00.000Z",
  });
  expect(svc({ dir: join(root, "missing") }).list()).toEqual([]);
});

test("backupFileName uses local time", () => {
  const d = new Date(2026, 10, 7, 3, 4, 5);
  expect(backupFileName(d)).toBe("synapse-20261107-030405.db");
});

test("dailyDue", () => {
  const lt = (date: string, hour: number) => () => ({ date, hour });
  const now = new Date();
  expect(dailyDue(now, 3, null, lt("2026-11-07", 2))).toEqual({
    due: false,
    date: "2026-11-07",
    reason: "not_due",
  });
  expect(dailyDue(now, 3, null, lt("2026-11-07", 3))).toEqual({ due: true, date: "2026-11-07" });
  expect(dailyDue(now, 3, "2026-11-07", lt("2026-11-07", 4))).toMatchObject({
    due: false,
    reason: "done_today",
  });
  expect(dailyDue(now, 3, "2026-11-06", lt("2026-11-07", 4)).due).toBe(true);
});
