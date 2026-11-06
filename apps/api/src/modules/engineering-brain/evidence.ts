import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join, posix, relative } from "node:path";
import {
  INSPECTION_MAX_CONTENT,
  type InspectionOutput,
  type RawToolResult,
} from "@synapse/contracts";
import { contentCheck } from "../../intelligence/auto-reply/content-checks";
import type { RawFact } from "../../intelligence/brain/inspect-prompt";

export type { RawFact };

type Fact = InspectionOutput["facts"][number];

/** Same limits as `evidenceSchema` and C6: checked here, after parsing, so one fact fails alone. */
const MAX_EVIDENCE = 5;
const MAX_PATH = 500;

export type EvidenceDropReason =
  | "unsafe_path"
  | "sensitive_path"
  | "outside_repo"
  | "missing"
  | "not_file"
  | "not_read";
export type DropReason =
  | EvidenceDropReason
  | "too_much_evidence"
  | "content_secret"
  | "content_internal_url"
  | "too_long";

export interface VerifiedFacts {
  kept: Fact[];
  /** Counts per reason; a dropped fact counts once, under its first failing check. */
  dropped: Partial<Record<DropReason, number>>;
}

/**
 * The repo-relative form of a model-supplied path, or null when it is absolute, empty, holds a
 * NUL byte or has any `..` segment (rejected before anything is resolved).
 */
function relativeOrNull(p: string): string | null {
  if (p.length > MAX_PATH) return null;
  if (p === "" || p.includes("\0") || isAbsolute(p) || p.startsWith("~")) return null;
  if (p.split(/[\\/]/).includes("..")) return null;
  const norm = posix.normalize(p).replace(/\/+$/, "");
  if (norm === "" || norm === "." || norm.startsWith("../") || norm.startsWith("/")) return null;
  return norm;
}

type Resolved = { ok: true; real: string } | { ok: false; reason: EvidenceDropReason };

/** Realpath containment: the resolved target must lie strictly under `root`. */
function resolveInside(root: string, rel: string): Resolved {
  let real: string;
  try {
    real = realpathSync(join(root, rel));
  } catch {
    return { ok: false, reason: "missing" };
  }
  if (!real.startsWith(`${root}/`)) return { ok: false, reason: "outside_repo" };
  return { ok: true, real };
}

const SENSITIVE_BASENAMES: RegExp[] = [
  /^\.env(\..*)?$/,
  /\.(pem|key|p12|pfx|kdbx)$/i,
  /^id_(rsa|dsa|ed25519|ecdsa)(\.pub)?$/,
  /^credentials(\.json)?$/,
  /^secrets\..+$/,
  /^\.(npmrc|netrc|pgpass|git-credentials)$/,
];

/** Git internals, env files, keys and credential files are never evidence, whatever they say. */
function isSensitive(rel: string): boolean {
  const segs = rel.split("/");
  if (segs.includes(".git")) return true;
  const base = segs[segs.length - 1] ?? "";
  return SENSITIVE_BASENAMES.some((re) => re.test(base));
}

/** The tools whose successful results count as the run having looked at a file (ADR-026). */
const INSPECT_TOOL_NAMES = new Set(["Read", "Grep", "Glob"]);

/** ADR-026: the run produced at least one successful Read, Grep or Glob result. */
export function hasInspectionToolResult(results: readonly RawToolResult[]): boolean {
  return results.some((r) => !r.isError && INSPECT_TOOL_NAMES.has(r.toolName));
}

/** Which repository-relative paths the run observed through its own tool results. */
export interface ObservedPaths {
  has(rel: string): boolean;
}

/** Characters that may surround a path named in Grep or Glob output. */
const BEFORE = /[\s"'`([]/;
const AFTER = /[\s"'`:,;)\]]/;

/** `path` occurs in `text` as a whole path: not inside a longer name or a deeper path. */
function mentions(text: string, path: string): boolean {
  for (let i = text.indexOf(path); i !== -1; i = text.indexOf(path, i + 1)) {
    const before = i === 0 ? "" : (text[i - 1] as string);
    const after = text[i + path.length] ?? "";
    if ((before === "" || BEFORE.test(before)) && (after === "" || AFTER.test(after))) return true;
  }
  return false;
}

/**
 * ADR-026 for inspection: built only from raw tool results, never the model's reply. A path is
 * observed when it is the `file_path` of a successful Read (absolute under `repoRoot`, or relative
 * to it, after normalisation), or is named as a whole path, absolute or relative, in the content
 * of a successful Grep or Glob result. Nothing here is logged.
 */
export function observedPaths(repoRoot: string, results: readonly RawToolResult[]): ObservedPaths {
  const root = repoRoot.replace(/\/+$/, "");
  const read = new Set<string>();
  const listings: string[] = [];
  for (const r of results) {
    if (r.isError) continue;
    if (r.toolName === "Read") {
      const fp = (r.input as { file_path?: unknown } | null)?.file_path;
      if (typeof fp !== "string") continue;
      const candidate = fp.startsWith(`${root}/`) ? fp.slice(root.length + 1) : fp;
      const rel = relativeOrNull(candidate);
      if (rel !== null) read.add(rel);
    } else if (r.toolName === "Grep" || r.toolName === "Glob") {
      listings.push(r.content);
    }
  }
  return {
    has: (rel) =>
      read.has(rel) ||
      listings.some(
        (t) => mentions(t, `${root}/${rel}`) || mentions(t, rel) || mentions(t, `./${rel}`),
      ),
  };
}

function checkEvidencePath(
  root: string,
  path: string,
): { ok: true; rel: string } | { ok: false; reason: EvidenceDropReason } {
  const rel = relativeOrNull(path);
  if (rel === null) return { ok: false, reason: "unsafe_path" };
  if (isSensitive(rel)) return { ok: false, reason: "sensitive_path" };
  const r = resolveInside(root, rel);
  if (!r.ok) return r;
  // A harmless name may be a symlink to a sensitive file inside the repo.
  if (isSensitive(relative(root, r.real))) return { ok: false, reason: "sensitive_path" };
  try {
    if (!statSync(r.real).isFile()) return { ok: false, reason: "not_file" };
  } catch {
    return { ok: false, reason: "missing" };
  }
  return { ok: true, rel };
}

const TRIM_EDGES = /^[`'"([{<]+|[`'")\]}>,;:.!?]+$/g;
const LINE_SUFFIX = /:\d+(?::\d+)?$/;

/**
 * Replaces each token that names an existing file or directory inside the repository (optionally
 * with a `:line` suffix) by a placeholder, so a long module path or `file.ts:12` is not mistaken
 * for a secret or a host:port. Everything else is checked as written.
 */
function maskRepoPaths(root: string, text: string): string {
  return text
    .split(/(\s+)/)
    .map((tok) => {
      const bare = tok.replace(TRIM_EDGES, "").replace(LINE_SUFFIX, "");
      if (bare === "" || !/[/.]/.test(bare)) return tok;
      const rel = relativeOrNull(bare);
      if (rel === null) return tok;
      return resolveInside(root, rel).ok ? "PATH" : tok;
    })
    .join("");
}

/**
 * C6 evidence verification, on the facts as the model wrote them (nothing is clamped first).
 * A fact is kept only when it cites 1 to 5 evidence entries and every path is relative, at most
 * 500 characters, has no `..`, is not sensitive (`.git`, env files, keys, credentials), and
 * resolves (realpath) to an existing regular file strictly inside `repoRoot`, which the run
 * observed through its own tool results (`not_read` otherwise; ADR-026). Then its whole
 * content must pass the secret and internal-URL checks, and only then is it held to 400
 * characters (`too_long`; never cut). Kept evidence paths are normalised (`./a//b` becomes `a/b`).
 * Never logs or returns fact text beyond the kept facts.
 */
export function verifyFacts(
  repoRoot: string,
  facts: readonly RawFact[],
  observed: ObservedPaths,
): VerifiedFacts {
  const root = realpathSync(repoRoot).replace(/\/+$/, "");
  const kept: Fact[] = [];
  const dropped: Partial<Record<DropReason, number>> = {};
  const drop = (r: DropReason) => {
    dropped[r] = (dropped[r] ?? 0) + 1;
  };
  for (const f of facts) {
    if (f.evidence.length > MAX_EVIDENCE) {
      drop("too_much_evidence");
      continue;
    }
    const evidence: Fact["evidence"] = [];
    let bad: EvidenceDropReason | null = null;
    for (const e of f.evidence) {
      const r = checkEvidencePath(root, e.path);
      if (!r.ok) {
        bad = r.reason;
        break;
      }
      if (!observed.has(r.rel)) {
        bad = "not_read";
        break;
      }
      evidence.push({ ...e, path: r.rel });
    }
    if (bad) {
      drop(bad);
      continue;
    }
    const issue = contentCheck(maskRepoPaths(root, f.content));
    if (issue === "content_secret" || issue === "content_internal_url") {
      drop(issue);
      continue;
    }
    if ([...f.content].length > INSPECTION_MAX_CONTENT) {
      drop("too_long");
      continue;
    }
    kept.push({ kind: f.kind, content: f.content, evidence });
  }
  return { kept, dropped };
}

/** C9 dedupe key: lowercase, punctuation stripped, whitespace collapsed. */
export function normaliseFactContent(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Code-answer citations (C3): a cited path is kept only when it is safe, not sensitive, resolves
 * (realpath) to an existing regular file strictly inside `repoRoot` and was observed through the
 * run's own tool results (ADR-026). Kept paths are repository-relative and normalised; the line
 * is carried over. Nothing is logged.
 */
export function verifyCitations(
  repoRoot: string,
  evidence: readonly { path: string; line?: number }[],
  observed: ObservedPaths,
): { kept: { path: string; line?: number }[]; dropped: number } {
  const root = realpathSync(repoRoot).replace(/\/+$/, "");
  const kept: { path: string; line?: number }[] = [];
  let dropped = 0;
  for (const e of evidence) {
    const r = checkEvidencePath(root, e.path);
    if (!r.ok || !observed.has(r.rel)) {
      dropped++;
      continue;
    }
    kept.push(e.line === undefined ? { path: r.rel } : { path: r.rel, line: e.line });
  }
  return { kept, dropped };
}
