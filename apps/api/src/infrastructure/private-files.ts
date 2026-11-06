import { chmodSync, lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

export interface PrivateFsOps {
  stat(p: string): { uid: number; mode: number; isDir: boolean } | null;
  chmod(p: string, mode: number): void;
  mkdir(p: string, mode: number): void;
  readdir(dir: string): string[];
  /** Resolves symlinks; throws when the path does not exist. Defaults to the path itself. */
  realpath?(p: string): string;
}

export const defaultPrivateFsOps: PrivateFsOps = {
  stat(p) {
    try {
      const s = lstatSync(p);
      // Symlinks are never followed: report them as absent so they are skipped.
      if (s.isSymbolicLink()) return null;
      return { uid: s.uid, mode: s.mode & 0o777, isDir: s.isDirectory() };
    } catch {
      return null;
    }
  },
  chmod: (p, mode) => chmodSync(p, mode),
  realpath: (p) => realpathSync(p),
  mkdir: (p, mode) => void mkdirSync(p, { recursive: true, mode }),
  readdir(dir) {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
};

export interface PrivateFilesResult {
  ok: boolean;
  changed: number;
  failed: number;
}

export const PRIVATE_FILES_LOG_LINE = "synapse: could not make the data files private";

/** A manual backup copy: `*.db.bak`, optionally followed by `-…` or `.…`. */
const MANUAL_BACKUP = /\.db\.bak([-.][^/]*)?$/;

/**
 * R1: data dir 0700 (only when it is a dedicated directory), db + wal + shm + manual
 * `*.db.bak*` copies 0600, own files only. The directory chmod is skipped, without error,
 * for a relative db path or a dir that is "/", home, an ancestor of home, or the cwd.
 */
export function securePrivateFiles(
  dbPath: string,
  opts: { fs?: PrivateFsOps; uid?: number; home?: string; cwd?: string } = {},
): PrivateFilesResult {
  if (dbPath === ":memory:") return { ok: true, changed: 0, failed: 0 };
  const fs = opts.fs ?? defaultPrivateFsOps;
  const uid = opts.uid ?? process.getuid?.() ?? -1;
  let changed = 0;
  let failed = 0;
  const fix = (p: string, want: number) => {
    const s = fs.stat(p);
    if (!s || s.uid !== uid || s.mode === want) return;
    try {
      fs.chmod(p, want);
      changed++;
    } catch {
      failed++;
    }
  };
  const resolve = (p: string): string => {
    try {
      return fs.realpath ? fs.realpath(p) : p;
    } catch {
      return p;
    }
  };

  const dir = dirname(dbPath);
  let realDir: string | null;
  try {
    realDir = fs.realpath ? fs.realpath(dir) : fs.stat(dir) ? dir : null;
  } catch {
    realDir = null;
  }
  if (realDir === null) {
    try {
      fs.mkdir(dir, 0o700);
      changed++;
    } catch {
      failed++;
    }
    realDir = dir;
  } else {
    const home = resolve(opts.home ?? homedir());
    const cwd = resolve(opts.cwd ?? process.cwd());
    const dedicated =
      isAbsolute(dbPath) &&
      realDir !== "/" &&
      realDir !== home &&
      !home.startsWith(`${realDir}/`) &&
      realDir !== cwd;
    if (dedicated) fix(realDir, 0o700);
  }
  const name = basename(dbPath);
  const targets = new Set([name, `${name}-wal`, `${name}-shm`]);
  for (const f of fs.readdir(realDir)) if (MANUAL_BACKUP.test(f)) targets.add(f);
  for (const f of targets) fix(join(realDir, f), 0o600);
  return { ok: failed === 0, changed, failed };
}
