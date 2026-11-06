import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join, posix } from "node:path";
import type { InspectionOutput } from "@synapse/contracts";
import { contentCheck } from "../../intelligence/auto-reply/content-checks";

type Fact = InspectionOutput["facts"][number];

export type EvidenceDropReason = "unsafe_path" | "outside_repo" | "missing" | "not_file";
export type DropReason = EvidenceDropReason | "content_secret" | "content_internal_url";

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

function checkEvidencePath(
  root: string,
  path: string,
): { ok: true; rel: string } | { ok: false; reason: EvidenceDropReason } {
  const rel = relativeOrNull(path);
  if (rel === null) return { ok: false, reason: "unsafe_path" };
  const r = resolveInside(root, rel);
  if (!r.ok) return r;
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
 * C6 evidence verification. A fact is kept only when every evidence path is relative, has no
 * `..`, and resolves (realpath) to an existing regular file strictly inside `repoRoot`. Facts whose
 * content fails the secret or internal-URL content check are dropped too. Kept evidence paths are
 * normalised (`./a//b` becomes `a/b`). Never logs or returns fact text beyond the kept facts.
 */
export function verifyFacts(repoRoot: string, facts: readonly Fact[]): VerifiedFacts {
  const root = realpathSync(repoRoot).replace(/\/+$/, "");
  const kept: Fact[] = [];
  const dropped: Partial<Record<DropReason, number>> = {};
  const drop = (r: DropReason) => {
    dropped[r] = (dropped[r] ?? 0) + 1;
  };
  for (const f of facts) {
    const evidence: Fact["evidence"] = [];
    let bad: EvidenceDropReason | null = null;
    for (const e of f.evidence) {
      const r = checkEvidencePath(root, e.path);
      if (!r.ok) {
        bad = r.reason;
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
    kept.push({ ...f, evidence });
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
