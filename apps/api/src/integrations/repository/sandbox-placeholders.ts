import { lstatSync, readdirSync, rmdirSync, type Stats, unlinkSync } from "node:fs";
import { join } from "node:path";

/**
 * ADR-040, Task 4b. The Claude Code sandbox (CLI 2.1.319, bubblewrap) protects `.git` by mounting
 * over fixed paths, and creates an empty placeholder for each mount target that does not exist.
 * They persist after the run and would change the git-dir fingerprint (`git_dir_changed`). These
 * helpers find the known placeholder paths and remove the ones a run created, only while empty.
 */

/** Placeholder directories under `.git`, as observed on the real CLI. */
const GIT_DIRS = ["branches", "remotes", "objects/info/commit-graphs"] as const;
/** Placeholder files under `.git` (zero bytes when created by the sandbox). */
const GIT_FILES = ["config.worktree", "objects/info/alternates"] as const;
/** The sandbox's no-replace marker directory; it can appear in any protected `.git` dir. */
const NOREPLACE = ".claude-sandbox-noreplace";
/** The sandbox's write-tracking dir at the repository top, inside a `.claude` it may create. */
const TOP_DIRS = [".claude/.cc-writes", ".claude"] as const;

/** Bounds of the `.claude-sandbox-noreplace` walk under `.git`. */
const WALK_MAX_DEPTH = 6;
const WALK_MAX_ENTRIES = 20_000;
/** Bounds of the emptiness check inside one placeholder directory. */
const EMPTY_MAX_DEPTH = 8;
const EMPTY_MAX_ENTRIES = 1_000;

interface Candidate {
  rel: string;
  kind: "dir" | "file";
}

/**
 * lstat of `<repo>/<rel>` without following any symlink on the way: every component before the
 * last must be a real directory. Null when missing, unreadable or reached through a symlink.
 */
function lstatInside(repo: string, rel: string): Stats | null {
  const parts = rel.split("/");
  let cur = repo;
  for (let i = 0; i < parts.length; i++) {
    cur = join(cur, parts[i] as string);
    let st: Stats;
    try {
      st = lstatSync(cur);
    } catch {
      return null;
    }
    if (i === parts.length - 1) return st;
    if (st.isSymbolicLink() || !st.isDirectory()) return null;
  }
  return null;
}

/** `.git` is a real directory (not a worktree pointer file or a symlink). */
function hasGitDir(repo: string): boolean {
  try {
    const st = lstatSync(join(repo, ".git"));
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Every `.claude-sandbox-noreplace` directory under `.git`, repo-relative. Symlinks are never
 * entered; loose-object and pack dirs are skipped; depth and entry count are bounded.
 */
function noreplaceDirs(repo: string): string[] {
  const found: string[] = [];
  let budget = WALK_MAX_ENTRIES;
  const walk = (rel: string, depth: number): void => {
    if (depth > WALK_MAX_DEPTH || budget <= 0) return;
    let names: string[];
    try {
      names = readdirSync(join(repo, rel));
    } catch {
      return;
    }
    for (const name of names) {
      if (--budget < 0) return;
      const r = `${rel}/${name}`;
      let st: Stats;
      try {
        st = lstatSync(join(repo, r));
      } catch {
        continue;
      }
      if (st.isSymbolicLink() || !st.isDirectory()) continue;
      if (name === NOREPLACE) {
        found.push(r);
        continue;
      }
      if (rel === ".git/objects" && (name === "pack" || /^[0-9a-f]{2}$/.test(name))) continue;
      walk(r, depth + 1);
    }
  };
  walk(".git", 1);
  return found;
}

function candidates(repo: string): Candidate[] {
  const out: Candidate[] = [];
  if (hasGitDir(repo)) {
    for (const d of GIT_DIRS) out.push({ rel: `.git/${d}`, kind: "dir" });
    for (const f of GIT_FILES) out.push({ rel: `.git/${f}`, kind: "file" });
    for (const r of noreplaceDirs(repo)) out.push({ rel: r, kind: "dir" });
  }
  for (const d of TOP_DIRS) out.push({ rel: d, kind: "dir" });
  return out;
}

/** The known placeholder paths that exist now (any type), repo-relative, sorted. */
export function existingSandboxPlaceholders(repo: string): string[] {
  const seen = new Set<string>();
  for (const c of candidates(repo)) if (lstatInside(repo, c.rel)) seen.add(c.rel);
  return [...seen].sort();
}

/**
 * The directories of a tree that holds only directories (no file, symlink or other entry),
 * deepest first; null when anything else is found or a bound is hit.
 */
function emptyTree(abs: string): string[] | null {
  const dirs: string[] = [];
  let budget = EMPTY_MAX_ENTRIES;
  const visit = (dir: string, depth: number): boolean => {
    if (depth > EMPTY_MAX_DEPTH) return false;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return false;
    }
    for (const name of names) {
      if (--budget < 0) return false;
      const p = join(dir, name);
      let st: Stats;
      try {
        st = lstatSync(p);
      } catch {
        return false;
      }
      if (st.isSymbolicLink() || !st.isDirectory()) return false;
      if (!visit(p, depth + 1)) return false;
    }
    dirs.push(dir); // after its children: deepest first
    return true;
  };
  return visit(abs, 0) ? dirs : null;
}

/**
 * Removes each known placeholder path not in `before` that is empty (see the GitWorkflow port).
 * Deepest first. `rmdir` never removes a directory that gained an entry meanwhile. Returns the
 * number of entries removed.
 */
export function removeNewSandboxPlaceholders(repo: string, before: readonly string[]): number {
  const existed = new Set(before);
  const depth = (rel: string) => rel.split("/").length;
  const list = candidates(repo)
    .filter((c) => !existed.has(c.rel))
    .sort((a, b) => depth(b.rel) - depth(a.rel));
  let removed = 0;
  const done = new Set<string>();
  for (const c of list) {
    if (done.has(c.rel)) continue;
    done.add(c.rel);
    const st = lstatInside(repo, c.rel);
    if (!st || st.isSymbolicLink()) continue;
    const abs = join(repo, c.rel);
    try {
      if (c.kind === "file") {
        if (st.isFile() && st.size === 0) {
          unlinkSync(abs);
          removed++;
        }
      } else if (st.isDirectory()) {
        const dirs = emptyTree(abs);
        if (!dirs) continue;
        for (const d of dirs) {
          rmdirSync(d);
          removed++;
        }
      }
    } catch {
      // Left in place: the git-dir fingerprint flags whatever remains.
    }
  }
  return removed;
}
