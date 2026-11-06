import { chmodSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface PrivateFsOps {
  stat(p: string): { uid: number; mode: number; isDir: boolean } | null;
  chmod(p: string, mode: number): void;
  mkdir(p: string, mode: number): void;
  readdir(dir: string): string[];
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

/** R1: data dir 0700, db + wal + shm + manual `*.db.bak*` copies 0600, own files only. */
export function securePrivateFiles(
  dbPath: string,
  opts: { fs?: PrivateFsOps; uid?: number } = {},
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

  const dir = dirname(dbPath);
  if (fs.stat(dir) === null) {
    try {
      fs.mkdir(dir, 0o700);
      changed++;
    } catch {
      failed++;
    }
  } else {
    fix(dir, 0o700);
  }
  const name = basename(dbPath);
  const targets = new Set([name, `${name}-wal`, `${name}-shm`]);
  for (const f of fs.readdir(dir)) if (/\.db\.bak/.test(f)) targets.add(f);
  for (const f of targets) fix(join(dir, f), 0o600);
  return { ok: failed === 0, changed, failed };
}
