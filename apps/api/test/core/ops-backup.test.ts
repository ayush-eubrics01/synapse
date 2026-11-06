import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
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
  expect(readdirSync(dir)).toEqual([r.name]);
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
      throw Object.assign(new Error("/secret/path SQLITE_FULL: database or disk is full"), {
        code: "SQLITE_FULL",
      });
    },
  });
  expect(s.run(7)).toEqual({ ok: false, failure: "vacuum_failed", cause: "SQLITE_FULL" });
  expect(readdirSync(dir)).toEqual([]);
  expect(audits("ops.backup_failed")[0]?.details).toEqual({
    code: "vacuum_failed",
    cause: "SQLITE_FULL",
  });
  expect(JSON.stringify(audits("ops.backup_failed"))).not.toContain("secret");
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

test("name conflict: existing file is never overwritten, tmp removed", () => {
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(join(dir, FIXED()), "old");
  expect(svc().run(7)).toEqual({ ok: false, failure: "name_conflict" });
  expect(readdirSync(dir)).toEqual([FIXED()]);
  expect(readFileSync(join(dir, FIXED()), "utf8")).toBe("old");
});

test("a target appearing after the check is not overwritten", () => {
  const s = svc({
    vacuumInto: (t) => {
      sqlite.run("VACUUM INTO ?", [`${t}.x`]);
      renameSync(`${t}.x`, t);
      writeFileSync(join(dir, FIXED()), "racer");
    },
  });
  expect(s.run(7)).toEqual({ ok: false, failure: "name_conflict" });
  expect(readFileSync(join(dir, FIXED()), "utf8")).toBe("racer");
  expect(readdirSync(dir)).toEqual([FIXED()]);
});

test("dir that cannot be created is dir_unavailable", () => {
  writeFileSync(join(root, "afile"), "x");
  expect(svc({ dir: join(root, "afile", "sub") }).run(7)).toEqual({
    ok: false,
    failure: "dir_unavailable",
  });
});

test("an explicitly checked dir inside the repository is refused; the default dir is not", () => {
  const fakeRepo = join(root, "fake-repo");
  mkdirSync(fakeRepo);
  const inside = join(fakeRepo, "backups");
  expect(svc({ dir: inside, repoRoot: fakeRepo }).run(7)).toEqual({
    ok: false,
    failure: "dir_unavailable",
  });
  expect(existsSync(inside)).toBe(false);
  expect(svc({ dir: inside, repoRoot: fakeRepo, checkDir: false }).run(7).ok).toBe(true);
});

test("a symlinked dir that resolves inside the (fake) repository is refused", () => {
  const fakeRepo = join(root, "fake-repo");
  mkdirSync(fakeRepo);
  const link = join(root, "link");
  symlinkSync(fakeRepo, link);
  expect(svc({ dir: link, repoRoot: fakeRepo }).run(7)).toEqual({
    ok: false,
    failure: "dir_unavailable",
  });
  expect(readdirSync(fakeRepo)).toEqual([]);
});

test("unexpected failure records a whitelisted cause only", () => {
  const s = svc({
    diskFree: () => {
      throw Object.assign(new Error("/x/y path"), { code: "EACCES" });
    },
  });
  expect(s.run(7)).toEqual({ ok: false, failure: "unexpected", cause: "EACCES" });
  expect(JSON.stringify(audits("ops.backup_failed"))).not.toContain("/x/y");
});

test("list ignores symlinks named like backups", () => {
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(join(root, "real"), "data");
  symlinkSync(join(root, "real"), join(dir, "synapse-20261101-030000.db"));
  expect(svc().list()).toEqual([]);
});

test("prune never removes the backup just written, even with newer-mtime older files", () => {
  mkdirSync(dir, { mode: 0o700 });
  const future = new Date(Date.now() + 10 * 86_400_000);
  for (const n of ["synapse-20261101-030000.db", "synapse-20261102-030000.db"]) {
    writeFileSync(join(dir, n), "b");
    utimesSync(join(dir, n), future, future);
  }
  const r = svc().run(1);
  expect(r).toMatchObject({ ok: true, pruned: 2 });
  expect(readdirSync(dir)).toEqual([FIXED()]);
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

test("a pre-existing backup dir keeps its mode when chmodDir is false; a created one is 0700", () => {
  mkdirSync(dir, { mode: 0o755 });
  chmodSync(dir, 0o755);
  expect(svc({ chmodDir: false }).run(7).ok).toBe(true);
  expect(statSync(dir).mode & 0o777).toBe(0o755);
  rmSync(dir, { recursive: true, force: true });
  expect(svc({ chmodDir: false }).run(7).ok).toBe(true);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
});
