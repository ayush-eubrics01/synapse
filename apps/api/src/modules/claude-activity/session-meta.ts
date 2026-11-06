/**
 * Pure session-meta extraction (ADR-036). Only whitelisted metadata is ever copied out of a
 * Claude Code session line; no other key is read, so nothing else can leak.
 */

export const MAX_LINE_BYTES = 1 << 20;
export const MAX_CHUNK_BYTES = 4 << 20;

const FUTURE_SKEW_MS = 5 * 60_000;

export interface SessionMetaDelta {
  cwd?: string;
  gitBranch?: string;
  timestamp?: string;
  version?: string;
  entrypoint?: string;
  aiTitle?: string;
  pr?: { url: string; number: number; repository: string };
}

function str(v: unknown, max: number): string | undefined {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined;
}

export function extractSessionMeta(line: unknown): SessionMetaDelta | null {
  if (typeof line !== "object" || line === null || Array.isArray(line)) return null;
  const src = line as Record<string, unknown>;
  const out: SessionMetaDelta = {};

  const cwd = str(src.cwd, 4096);
  if (cwd?.startsWith("/")) out.cwd = cwd;
  const gitBranch = str(src.gitBranch, 255);
  if (gitBranch) out.gitBranch = gitBranch;
  const version = str(src.version, 50);
  if (version) out.version = version;
  const entrypoint = str(src.entrypoint, 50);
  if (entrypoint) out.entrypoint = entrypoint;
  const ts = str(src.timestamp, 64);
  if (ts && !Number.isNaN(Date.parse(ts))) out.timestamp = ts;

  if (src.type === "ai-title" && typeof src.aiTitle === "string" && src.aiTitle.length > 0) {
    out.aiTitle = src.aiTitle.slice(0, 200);
  }
  if (src.type === "pr-link") {
    const url = str(src.prUrl, 500);
    const repository = str(src.prRepository, 200);
    const n = src.prNumber;
    if (
      url?.startsWith("https://") &&
      repository &&
      typeof n === "number" &&
      Number.isInteger(n) &&
      n > 0
    ) {
      out.pr = { url, number: n, repository };
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Claude Code's project-folder encoding: every character outside [A-Za-z0-9] becomes "-". */
export function encodeProjectDir(absPath: string): string {
  return absPath.replace(/[^A-Za-z0-9]/g, "-");
}

export function isCandidateDir(dirName: string, encodedRepoPaths: string[]): boolean {
  return encodedRepoPaths.some((e) => dirName === e || dirName.startsWith(`${e}-`));
}

const NL = 0x0a;

/** Complete lines only. A partial tail is not consumed; oversized lines are consumed unparsed. */
export function splitCompleteLines(
  chunk: Uint8Array,
  maxLineBytes: number,
): { lines: string[]; consumed: number; oversized: number } {
  const lines: string[] = [];
  const decoder = new TextDecoder();
  let oversized = 0;
  let start = 0;
  for (;;) {
    const nl = chunk.indexOf(NL, start);
    if (nl === -1) break;
    const len = nl - start;
    if (len > maxLineBytes) oversized++;
    else if (len > 0) lines.push(decoder.decode(chunk.subarray(start, nl)));
    start = nl + 1;
  }
  if (chunk.length - start > maxLineBytes) {
    oversized++;
    return { lines, consumed: chunk.length, oversized };
  }
  return { lines, consumed: start, oversized };
}

export interface SessionAccum {
  cwd: string | null;
  gitBranch: string | null;
  title: string | null;
  firstAt: string | null;
  lastAt: string | null;
  version: string | null;
  entrypoint: string | null;
  prs: {
    url: string;
    number: number;
    repository: string;
    seenAt: string | null;
    branch: string | null;
  }[];
}

export function foldMeta(
  prev: SessionAccum | null,
  deltas: SessionMetaDelta[],
  nowMs: number,
): SessionAccum {
  const acc: SessionAccum = prev
    ? { ...prev, prs: prev.prs.map((p) => ({ ...p })) }
    : {
        cwd: null,
        gitBranch: null,
        title: null,
        firstAt: null,
        lastAt: null,
        version: null,
        entrypoint: null,
        prs: [],
      };
  const limit = nowMs + FUTURE_SKEW_MS;
  let first = acc.firstAt ? Date.parse(acc.firstAt) : Number.NaN;
  let last = acc.lastAt ? Date.parse(acc.lastAt) : Number.NaN;
  for (const d of deltas) {
    if (d.cwd && acc.cwd === null) acc.cwd = d.cwd;
    if (d.gitBranch) acc.gitBranch = d.gitBranch;
    if (d.aiTitle) acc.title = d.aiTitle;
    if (d.version) acc.version = d.version;
    if (d.entrypoint) acc.entrypoint = d.entrypoint;
    let seenAt: string | null = null;
    if (d.timestamp) {
      const t = Date.parse(d.timestamp);
      if (t <= limit) {
        seenAt = d.timestamp;
        if (Number.isNaN(first) || t < first) {
          first = t;
          acc.firstAt = d.timestamp;
        }
        if (Number.isNaN(last) || t > last) {
          last = t;
          acc.lastAt = d.timestamp;
        }
      }
    }
    if (d.pr) {
      const entry = { ...d.pr, seenAt, branch: acc.gitBranch };
      const i = acc.prs.findIndex((p) => p.url === d.pr?.url);
      if (i >= 0) acc.prs[i] = entry;
      else acc.prs.push(entry);
    }
  }
  return acc;
}
