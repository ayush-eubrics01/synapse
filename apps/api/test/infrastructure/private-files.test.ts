import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filePermissionsCheck } from "../../src/core/health/checks";
import {
  defaultBackupDir,
  PRIVATE_FILES_LOG_LINE,
  type PrivateFsOps,
  securePrivateFiles,
} from "../../src/infrastructure/private-files";
import { HEALTH_HINTS, HEALTH_LABELS } from "../../src/modules/dashboard/health-hints";

const mode = (p: string) => statSync(p).mode & 0o777;
const scratch = () => mkdtempSync(join(tmpdir(), "syn-"));

test("real fs: data dir and db files become private, others untouched", () => {
  const dir = join(scratch(), "data");
  mkdirSync(dir);
  chmodSync(dir, 0o755);
  const names = [
    "synapse.db",
    "synapse.db-wal",
    "synapse.db-shm",
    "synapse.db.bak",
    "synapse.db.bak.2",
  ];
  for (const n of names) {
    writeFileSync(join(dir, n), "x");
    chmodSync(join(dir, n), 0o644);
  }
  writeFileSync(join(dir, "notes.txt"), "x");
  chmodSync(join(dir, "notes.txt"), 0o644);
  const r = securePrivateFiles(join(dir, "synapse.db"));
  expect(r).toEqual({ ok: true, changed: 6, failed: 0 });
  expect(mode(dir)).toBe(0o700);
  for (const n of names) expect(mode(join(dir, n))).toBe(0o600);
  expect(mode(join(dir, "notes.txt"))).toBe(0o644);
  expect(securePrivateFiles(join(dir, "synapse.db"))).toEqual({ ok: true, changed: 0, failed: 0 });
});

test("real fs: a missing data dir is created at 0700; symlinks are not followed", () => {
  const root = scratch();
  const dir = join(root, "data");
  expect(securePrivateFiles(join(dir, "synapse.db")).ok).toBe(true);
  expect(mode(dir)).toBe(0o700);
  const target = join(root, "target.txt");
  writeFileSync(target, "x");
  chmodSync(target, 0o644);
  symlinkSync(target, join(dir, "synapse.db.bak"));
  securePrivateFiles(join(dir, "synapse.db"));
  expect(mode(target)).toBe(0o644);
  expect(existsSync(join(dir, "synapse.db.bak"))).toBe(true);
  expect(readFileSync(target, "utf8")).toBe("x");
});

function fake(opts: { uid: number; failChmod?: boolean }) {
  const calls: string[] = [];
  const fs: PrivateFsOps = {
    stat: (p) => {
      calls.push(`stat ${p}`);
      return { uid: opts.uid, mode: 0o644, isDir: p === "/d" };
    },
    chmod: (p) => {
      calls.push(`chmod ${p}`);
      if (opts.failChmod) throw new Error("EPERM");
    },
    mkdir: (p) => void calls.push(`mkdir ${p}`),
    readdir: () => ["synapse.db"],
  };
  return { fs, calls };
}

test("fake fs: entries owned by another uid are skipped", () => {
  const { fs, calls } = fake({ uid: 999 });
  expect(securePrivateFiles("/d/synapse.db", { fs, uid: 1 })).toEqual({
    ok: true,
    changed: 0,
    failed: 0,
  });
  expect(calls.some((c) => c.startsWith("chmod"))).toBe(false);
});

test("fake fs: chmod EPERM is a failure and health is degraded", async () => {
  const { fs } = fake({ uid: 1, failChmod: true });
  const r = securePrivateFiles("/d/synapse.db", { fs, uid: 1 });
  expect(r.ok).toBe(false);
  expect(r.failed).toBeGreaterThan(0);
  const h = await filePermissionsCheck(r)();
  expect(h.status).toBe("degraded");
  expect(h.detail).toBe(`chmod failed for ${r.failed} path(s)`);
  expect((await filePermissionsCheck({ ok: true, changed: 0, failed: 0 })()).status).toBe("ok");
});

test(":memory: makes no fs call", () => {
  const { fs, calls } = fake({ uid: 1 });
  expect(securePrivateFiles(":memory:", { fs, uid: 1 })).toEqual({
    ok: true,
    changed: 0,
    failed: 0,
  });
  expect(calls).toEqual([]);
});

test("hint, label and log line are exact", () => {
  expect(HEALTH_HINTS.file_permissions).toBe(
    "Synapse's data files are readable by other users; run chmod 700 on the data directory",
  );
  expect(HEALTH_LABELS.file_permissions).toBe("Data file permissions");
  expect(PRIVATE_FILES_LOG_LINE).toBe("synapse: could not make the data files private");
});

test("main.ts sets umask and secures files before createContainer", () => {
  const src = readFileSync(join(import.meta.dir, "../../src/main.ts"), "utf8");
  const u = src.indexOf("process.umask(0o077)");
  const s = src.indexOf("securePrivateFiles(");
  const c = src.indexOf("createContainer(config");
  expect(u).toBeGreaterThan(-1);
  expect(s).toBeGreaterThan(u);
  expect(c).toBeGreaterThan(s);
});

function plainDir(mode: number) {
  const dir = join(scratch(), "data");
  mkdirSync(dir);
  chmodSync(dir, mode);
  writeFileSync(join(dir, "synapse.db"), "x");
  chmodSync(join(dir, "synapse.db"), 0o644);
  return dir;
}

test("dir guard: home, an ancestor of home, and cwd keep their mode; files are still chmodded", () => {
  const dir = plainDir(0o755);
  const db = join(dir, "synapse.db");
  const sub = join(dir, "home", "u");
  mkdirSync(sub, { recursive: true });
  // dir is home
  expect(securePrivateFiles(db, { home: dir, cwd: tmpdir() }).ok).toBe(true);
  expect(mode(dir)).toBe(0o755);
  expect(mode(db)).toBe(0o600);
  // dir is an ancestor of home
  expect(securePrivateFiles(db, { home: sub, cwd: tmpdir() }).ok).toBe(true);
  expect(mode(dir)).toBe(0o755);
  // dir is the cwd
  expect(securePrivateFiles(db, { home: tmpdir(), cwd: dir }).ok).toBe(true);
  expect(mode(dir)).toBe(0o755);
  // dedicated dir is tightened
  securePrivateFiles(db, { home: tmpdir(), cwd: tmpdir() });
  expect(mode(dir)).toBe(0o700);
});

test("dir guard: a relative db path never chmods the dir; '/' is never chmodded", () => {
  const { fs, calls } = fake({ uid: 1 });
  expect(securePrivateFiles("synapse.db", { fs, uid: 1, home: "/h/u", cwd: "/w" }).ok).toBe(true);
  expect(calls.filter((c) => c === "chmod .")).toEqual([]);
  const root = fake({ uid: 1 });
  securePrivateFiles("/synapse.db", { fs: root.fs, uid: 1, home: "/h/u", cwd: "/w" });
  expect(root.calls.filter((c) => c === "chmod /")).toEqual([]);
});

test("a symlinked data dir is resolved and the real dir is tightened", () => {
  const real = plainDir(0o755);
  const link = join(scratch(), "link");
  symlinkSync(real, link);
  const r = securePrivateFiles(join(link, "synapse.db"), { home: tmpdir(), cwd: tmpdir() });
  expect(r).toEqual({ ok: true, changed: 2, failed: 0 });
  expect(mode(real)).toBe(0o700);
  expect(mode(join(real, "synapse.db"))).toBe(0o600);
});

test("only .db.bak names (optionally -x or .x) are manual backups", () => {
  const dir = plainDir(0o700);
  for (const n of ["x.db.bakery.txt", "synapse.db.bak-1", "synapse.db.bak.old"]) {
    writeFileSync(join(dir, n), "x");
    chmodSync(join(dir, n), 0o644);
  }
  securePrivateFiles(join(dir, "synapse.db"), { home: tmpdir(), cwd: tmpdir() });
  expect(mode(join(dir, "x.db.bakery.txt"))).toBe(0o644);
  expect(mode(join(dir, "synapse.db.bak-1"))).toBe(0o600);
  expect(mode(join(dir, "synapse.db.bak.old"))).toBe(0o600);
});

test("dir chmod failure counts as failed; a dir owned by another uid is skipped", () => {
  const mk = (uid: number, failChmod: boolean) => {
    const calls: string[] = [];
    const fs: PrivateFsOps = {
      stat: (p) => ({ uid, mode: 0o755, isDir: p === "/d" }),
      chmod: (p) => {
        calls.push(p);
        if (failChmod && p === "/d") throw new Error("EPERM");
      },
      mkdir: () => {},
      readdir: () => [],
    };
    return { fs, calls };
  };
  const o = { uid: 1, home: "/h/u", cwd: "/w" };
  const bad = mk(1, true);
  expect(securePrivateFiles("/d/synapse.db", { ...o, fs: bad.fs })).toEqual({
    ok: false,
    changed: 3,
    failed: 1,
  });
  const foreign = mk(2, false);
  expect(securePrivateFiles("/d/synapse.db", { ...o, fs: foreign.fs })).toEqual({
    ok: true,
    changed: 0,
    failed: 0,
  });
  expect(foreign.calls).toEqual([]);
});

test("default backup dir is <dataDir>/backups only for a dedicated data dir (injected home)", () => {
  const root = scratch();
  const home = join(root, "home");
  const dedicated = join(home, ".synapse");
  mkdirSync(dedicated, { recursive: true });
  expect(defaultBackupDir(join(dedicated, "s.db"), { home, cwd: root })).toBe(
    join(dedicated, "backups"),
  );
  // db directly in home, in an ancestor of home, in the cwd, or a relative path: not dedicated
  expect(defaultBackupDir(join(home, "s.db"), { home, cwd: root })).toBe(
    join(home, "synapse-backups"),
  );
  expect(defaultBackupDir(join(root, "s.db"), { home, cwd: dedicated })).toBe(
    join(root, "synapse-backups"),
  );
  expect(defaultBackupDir(join(dedicated, "s.db"), { home, cwd: dedicated })).toBe(
    join(dedicated, "synapse-backups"),
  );
  expect(defaultBackupDir("s.db", { home, cwd: root })).toBe("synapse-backups");
});
