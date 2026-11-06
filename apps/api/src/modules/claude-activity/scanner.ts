/**
 * Read-only scanner over the Claude Code projects dir (ADR-036). Looks only at top-level
 * `*.jsonl` files in directories that encode a registered repository path, never follows
 * symlinks, and never logs or throws file content or paths.
 */
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import {
  encodeProjectDir,
  extractSessionMeta,
  isCandidateDir,
  MAX_CHUNK_BYTES,
  MAX_LINE_BYTES,
  type SessionMetaDelta,
  splitCompleteLines,
} from "./session-meta";

export interface FsStat {
  isSymbolicLink: boolean;
  isDirectory: boolean;
  isFile: boolean;
  size: number;
  mtimeMs: number;
}

export interface FsOps {
  readdir(path: string): Promise<string[]>;
  lstat(path: string): Promise<FsStat>;
  realpath(path: string): Promise<string>;
  /** Reads up to `length` bytes starting at `offset` (fewer at end of file). */
  readRange(path: string, offset: number, length: number): Promise<Uint8Array>;
}

export const defaultFsOps: FsOps = {
  readdir: (p) => readdir(p),
  async lstat(p) {
    const s = await lstat(p);
    return {
      isSymbolicLink: s.isSymbolicLink(),
      isDirectory: s.isDirectory(),
      isFile: s.isFile(),
      size: s.size,
      mtimeMs: s.mtimeMs,
    };
  },
  realpath: (p) => realpath(p),
  async readRange(p, offset, length) {
    const fh = await open(p, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, offset);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  },
};

export class ProjectsDirUnreadable extends Error {
  constructor() {
    super("Claude projects directory is not readable");
    this.name = "ProjectsDirUnreadable";
  }
}

/** A session file could not be read; carries only an fs error code, never a path. */
export class SessionFileUnreadable extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`Session file could not be read (${code})`);
    this.name = "SessionFileUnreadable";
    this.code = code;
  }
}

export interface CandidateFile {
  path: string;
  sessionId: string;
  size: number;
  mtimeMs: number;
}

const SESSION_ID = /^[A-Za-z0-9-]{1,100}$/;

function errCode(e: unknown): string | undefined {
  return (e as { code?: string } | null)?.code;
}

export async function listCandidateFiles(
  projectsDir: string,
  repoPaths: string[],
  fs: FsOps = defaultFsOps,
): Promise<CandidateFile[]> {
  let root: string;
  let names: string[];
  try {
    root = await fs.realpath(projectsDir);
    names = await fs.readdir(projectsDir);
  } catch (e) {
    if (errCode(e) === "ENOENT") return [];
    throw new ProjectsDirUnreadable();
  }
  const encoded = repoPaths.map(encodeProjectDir);
  const out: CandidateFile[] = [];
  for (const name of names) {
    if (!isCandidateDir(name, encoded)) continue;
    const dir = join(projectsDir, name);
    let entries: string[];
    try {
      const st = await fs.lstat(dir);
      if (st.isSymbolicLink || !st.isDirectory) continue;
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const sessionId = entry.slice(0, -".jsonl".length);
      if (!SESSION_ID.test(sessionId)) continue;
      const path = join(dir, entry);
      try {
        const st = await fs.lstat(path);
        if (st.isSymbolicLink || !st.isFile) continue;
        const real = await fs.realpath(path);
        if (!real.startsWith(root + sep)) continue;
        out.push({ path, sessionId, size: st.size, mtimeMs: st.mtimeMs });
      } catch {}
    }
  }
  return out;
}

export async function readNewLines(
  file: CandidateFile,
  fromOffset: number,
  fs: FsOps = defaultFsOps,
): Promise<{
  deltas: SessionMetaDelta[];
  consumedTo: number;
  lines: number;
  known: number;
  parseErrors: number;
  oversized: number;
}> {
  const want = Math.min(MAX_CHUNK_BYTES, Math.max(0, file.size - fromOffset));
  // Read one byte before the offset: if it is not a newline, the offset is inside a line
  // whose head was consumed as oversized, so skip to the next line start.
  const back = fromOffset > 0 ? 1 : 0;
  let chunk: Uint8Array = new Uint8Array(0);
  if (want > 0) {
    try {
      chunk = await fs.readRange(file.path, fromOffset - back, want + back);
    } catch (e) {
      throw new SessionFileUnreadable(
        typeof errCode(e) === "string" ? (errCode(e) as string) : "UNKNOWN",
      );
    }
  }
  let startRel = 0;
  let skipAll = false;
  if (back === 1 && chunk.length > 0 && chunk[0] !== 0x0a) {
    const nl = chunk.indexOf(0x0a, 1);
    if (nl === -1) skipAll = true;
    else startRel = nl + 1;
  } else if (back === 1) {
    startRel = 1;
  }
  const base = fromOffset - back;
  const split = skipAll
    ? { lines: [] as string[], consumed: chunk.length - startRel, oversized: 0 }
    : splitCompleteLines(chunk.subarray(startRel), MAX_LINE_BYTES);
  const consumedTo = skipAll ? base + chunk.length : base + startRel + split.consumed;
  const deltas: SessionMetaDelta[] = [];
  let known = 0;
  let parseErrors = 0;
  for (const text of split.lines) {
    let delta: SessionMetaDelta | null;
    try {
      delta = extractSessionMeta(JSON.parse(text));
    } catch {
      parseErrors++;
      continue;
    }
    if (delta) {
      known++;
      deltas.push(delta);
    }
  }
  return {
    deltas,
    consumedTo,
    lines: split.lines.length,
    known,
    parseErrors,
    oversized: split.oversized,
  };
}
