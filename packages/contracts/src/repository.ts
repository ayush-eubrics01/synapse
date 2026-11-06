/**
 * Read-only access to local git repositories (C2, C3). The adapter lives in
 * `apps/api/src/integrations/repository`; modules depend only on this port.
 * Results never carry credentials: remote URLs have their userinfo stripped.
 */

export const PATH_REFUSAL_REASONS = [
  "not_absolute",
  "not_found",
  "not_directory",
  "not_git_root",
  "unsafe_chars",
  "forbidden_location",
  "already_registered",
  "nested",
] as const;
export type PathRefusalReason = (typeof PATH_REFUSAL_REASONS)[number];

export type PathCheckResult =
  | { ok: true; realpath: string }
  | { ok: false; reason: PathRefusalReason };

export interface RepositoryRemote {
  fetch: string;
  push: string;
}

export interface RepositoryInspection {
  topLevel: string;
  /** Null when HEAD is detached. */
  currentBranch: string | null;
  /** Null before the first commit. */
  headSha: string | null;
  remotes: { origin?: RepositoryRemote; upstream?: RepositoryRemote };
  /** True when the upstream push URL is `no_push`, `DISABLED` or empty. */
  upstreamPushDisabled: boolean;
  /** Sorted local branch names. */
  localBranches: string[];
  /** Sorted remote-tracking branches as `<remote>/<branch>`, without `<remote>/HEAD`. */
  remoteBranches: string[];
}

/**
 * `path_missing`: the path is gone or not a directory. `not_a_repository`: it exists but is no
 * longer the top level of a git work tree. `git_failed`: git errored or timed out.
 */
export type RepositoryInspectFailure = "path_missing" | "not_a_repository" | "git_failed";

export type RepositoryInspectResult =
  | { ok: true; inspection: RepositoryInspection }
  | { ok: false; reason: RepositoryInspectFailure };

export interface RepositoryProvider {
  /** C2 path rules against the given registered realpaths. */
  checkPath(path: string, registeredPaths: readonly string[]): Promise<PathCheckResult>;
  /** C3 read-only inspection of a registered (or about to be registered) realpath. */
  inspect(path: string): Promise<RepositoryInspectResult>;
}

/** Local branches plus remote branch names without the remote prefix: sorted, unique. */
export function allBranchNames(
  i: Pick<RepositoryInspection, "localBranches" | "remoteBranches">,
): string[] {
  const names = new Set(i.localBranches);
  for (const r of i.remoteBranches) {
    const slash = r.indexOf("/");
    if (slash > 0 && slash < r.length - 1) names.add(r.slice(slash + 1));
  }
  return [...names].sort();
}

/** C3: branch names that look like deployment environments. A suggestion only (ADR-035). */
const ENVIRONMENT_BRANCH_RE = /^(stage|staging|prod|production|main|master|develop|dev|release)$/;

/** Sorted, unique `{name, branch}` candidates (name equals branch). Pure. */
export function environmentCandidates(
  branches: readonly string[],
): { name: string; branch: string }[] {
  return [...new Set(branches)]
    .filter((b) => ENVIRONMENT_BRANCH_RE.test(b))
    .sort()
    .map((b) => ({ name: b, branch: b }));
}

/*
 * ---------------------------------------------------------------------------------------------
 * Git workflow for engineering tasks (Phase 10, E7, E8, E10–E13, E15, E17; ADR-030, ADR-035).
 * The adapter (`LocalGitWorkflow`) runs every git command through the hardened runner: argv
 * only, `-C <registered realpath>`, hooks and fsmonitor off, no credential prompts, a timeout.
 * It never pushes anywhere but `origin`, never passes `--force` and never resolves a conflict.
 * ---------------------------------------------------------------------------------------------
 */

/** E7 preflight failures (fixed codes; each one sets the task to `needs_attention`). */
export const GIT_PREFLIGHT_REASONS = [
  "not_a_repository",
  "merge_in_progress",
  "dirty_tree",
  "missing_remote",
  "upstream_push_enabled",
  "parent_missing_origin",
  "parent_missing_upstream",
] as const;
export type GitPreflightReason = (typeof GIT_PREFLIGHT_REASONS)[number];

/**
 * Fixed error codes thrown by a `GitWorkflow` as `GitWorkflowError`. Messages carry the code
 * only: never a path, a branch name, a URL or git's stderr.
 */
export const GIT_WORKFLOW_ERROR_CODES = [
  /** A git command failed (non-zero exit) for a reason with no more specific code. */
  "git_failed",
  /** A git command hit its timeout and was killed. */
  "git_timeout",
  /** A fetch from `origin` or `upstream` failed (network, auth, missing ref). */
  "fetch_failed",
  /** `git push origin <parent>` was rejected or failed. */
  "push_failed",
  /** A branch name is not a safe, valid ref name. */
  "invalid_ref",
  /** The task branch already exists locally. */
  "branch_exists",
  /** A branch that must exist (parent, task branch, return branch) does not. */
  "branch_missing",
  /** A required remote (`origin`, `upstream`) is missing. */
  "missing_remote",
  /** The working tree is not clean where a clean tree is required. */
  "dirty_tree",
  /** commitAll: the diff no longer matches the hash shown in the approval. */
  "diff_changed",
  /** commitAll: the diff touches `.git/`, a path outside the repo, or an outward symlink. */
  "unsafe_change",
  /** commitAll: there is nothing to commit. */
  "nothing_to_commit",
  /** pushParent: the parent is a protected branch (ADR-035). */
  "protected_branch",
  /** pushParent: the origin push URL is the upstream repository (hard rule 13). */
  "push_target_is_upstream",
  /** pushParent: no registered upstream URL and no `upstream` remote to compare against. */
  "no_upstream_reference",
  /** The git config (repo, hooks, attributes, global) differs from the expected fingerprint. */
  "config_changed",
  /** A branch no longer points at the commit the approval pinned. */
  "branch_moved",
  /** pushParent: origin's effective push URL is no longer the registered origin (owner/repo). */
  "origin_changed",
] as const;
export type GitWorkflowErrorCode = (typeof GIT_WORKFLOW_ERROR_CODES)[number];

export class GitWorkflowError extends Error {
  constructor(readonly code: GitWorkflowErrorCode) {
    super(code);
    this.name = "GitWorkflowError";
  }
}

export type GitPreflightResult = { ok: true } | { ok: false; reason: GitPreflightReason };

/** I1: the local-only part of preflight (no remote is contacted). */
export type GitLocalStateResult =
  | { ok: true }
  | { ok: false; reason: "not_a_repository" | "merge_in_progress" | "dirty_tree" };

/** Why a diff is unsafe (GitDiffSummary.unsafeReasons). */
export const GIT_UNSAFE_REASONS = [
  /** The git directory or git config differs from `gitDirBaseline` (nothing else was run). */
  "git_dir_changed",
  /** A changed path has a `.git` segment. */
  "git_path",
  /** A changed path is absolute, contains `..`, or its directory resolves outside the repo. */
  "outside_repo",
  /** A symlink whose target resolves outside the repo or into `.git`. */
  "symlink_outside",
  /** A directory entry (submodule, embedded repository) or a special file. */
  "not_a_file",
  /** A changed path could not be read or inspected. */
  "unreadable",
  /** `.gitattributes`, `.gitmodules` or `.lfsconfig` changed (they can name filters/commands). */
  "git_metadata_changed",
] as const;
export type GitUnsafeReason = (typeof GIT_UNSAFE_REASONS)[number];

export interface GitDiffFile {
  /** Repo-relative path, as git reports it. */
  path: string;
  /** Lines added and removed; both 0 for a binary file. */
  added: number;
  removed: number;
}

/** Cap on `GitDiffSummary.diffText`, in bytes (E10). */
export const GIT_DIFF_TEXT_MAX_BYTES = 200 * 1024;

export interface GitDiffSummary {
  /** Every changed path (tracked and untracked) against HEAD, sorted by path. */
  files: GitDiffFile[];
  /**
   * sha256 over HEAD and the content and mode of every changed path. Any edit, addition,
   * deletion or mode change gives a different hash; staging does not. commitAll re-checks it.
   */
  hash: string;
  /**
   * True when a path is under `.git/` (any `.git` segment), contains `..`, resolves outside the
   * repo realpath, is a symlink whose target resolves outside the repo (or into `.git`), is an
   * embedded repository or special file, is unreadable, or is a `.gitattributes`, `.gitmodules`
   * or `.lfsconfig`; or when the git directory differs from `gitDirBaseline`. See unsafeReasons.
   */
  unsafe: boolean;
  /** Sorted, unique reasons; empty exactly when `unsafe` is false. */
  unsafeReasons: GitUnsafeReason[];
  /** The plain-text diff (tracked plus new files), cut at GIT_DIFF_TEXT_MAX_BYTES. */
  diffText: string;
  truncated: boolean;
}

export interface GitDiffOptions {
  /**
   * A `gitDirFingerprint` taken before the develop run. git status never reports files inside
   * `.git/`, so a write there (hooks, config) is caught only by comparing fingerprints. It is
   * compared before any git command runs: on a mismatch nothing else runs (`git_dir_changed`).
   */
  gitDirBaseline?: string;
}

export interface GitConfigGuard {
  /**
   * A `configFingerprint` taken earlier (e.g. at pickup). When given and different, the call is
   * refused with `config_changed` before any git command runs.
   */
  expectedConfigFingerprint?: string;
}

export interface GitCommitOptions extends GitConfigGuard {
  /** Re-checked before any git command; a mismatch is `unsafe_change`. */
  gitDirBaseline?: string;
}

export interface GitMergeOptions extends GitConfigGuard {
  /**
   * The approved task-branch tip. When given, the task branch must still point at it
   * (`branch_moved` otherwise) and exactly this commit is merged.
   */
  commit?: string;
}

export interface GitPushOptions extends GitConfigGuard {
  /**
   * The approved parent tip. When given, `refs/heads/<parent>` must still point at it
   * (`branch_moved` otherwise) and exactly `<expectedSha>:refs/heads/<parent>` is pushed.
   */
  expectedSha?: string;
  /** Branches of protected environments: never pushed (ADR-035). */
  protectedBranches: readonly string[];
  /** The registered (credential-stripped) upstream fetch URL. */
  upstreamUrl: string | null;
  /**
   * M10: the registered (credential-stripped) origin URL. When given, every effective push URL of
   * `origin` (`git remote get-url --push --all origin`, insteadOf rules expanded) must be it, by
   * normalised URL or `owner/repo`; otherwise `origin_changed` and nothing is pushed. Null (no
   * registered origin) always refuses.
   */
  expectedOriginUrl?: string | null;
}

export interface GitCommitSummary {
  sha: string;
  subject: string;
}

export interface GitWorkflow {
  /** E7: deterministic checks before a task starts. `parent` must exist on origin and upstream. */
  preflight(
    repo: string,
    parent: string,
    opts?: { allowUpstreamPush?: boolean },
  ): Promise<GitPreflightResult>;
  /**
   * I1: the local checks of preflight only: the registered path is git's top level (realpath), no
   * merge, rebase, cherry-pick or revert is in progress, and the tree is clean. No remote is
   * contacted, so startup recovery never depends on the network.
   */
  localState(repo: string): Promise<GitLocalStateResult>;
  /** The checked-out branch, or null when HEAD is detached. */
  currentBranch(repo: string): Promise<string | null>;
  /**
   * E8: fetch the parent from origin and upstream, fast-forward the local parent to
   * `origin/<parent>` only when that is a fast-forward, then `git switch -c <taskBranch> <parent>`.
   */
  createTaskBranch(repo: string, parent: string, taskBranch: string): Promise<{ baseSha: string }>;
  /**
   * A hash of the git directory (config, hooks, info, refs, HEAD, index; not objects or reflogs)
   * plus `configFingerprint`. Filesystem reads only: no git command runs.
   */
  gitDirFingerprint(repo: string): Promise<string>;
  /**
   * A hash of everything that can make git run a command or change how content is filtered or
   * merged: `.git/config` (and `config.worktree`), `.git/info/attributes`, `.git/hooks/**`, and the
   * global `~/.gitconfig`, `$XDG_CONFIG_HOME/git/{config,attributes}` and `/etc/gitconfig`.
   * Unaffected by refs and commits. Filesystem reads only.
   */
  configFingerprint(repo: string): Promise<string>;
  /**
   * ADR-040, Task 4b: the known Claude Code sandbox placeholder paths that exist now, relative to
   * the repository top with `/` separators, sorted: `.git/{branches,remotes,config.worktree,
   * objects/info/alternates,objects/info/commit-graphs}`, every `.claude-sandbox-noreplace` dir
   * under `.git` (bounded walk, symlinks not entered), `.claude/.cc-writes` and `.claude`. Taken
   * right before a develop run. Filesystem reads only: no git command runs.
   */
  sandboxPlaceholders(repo: string): Promise<string[]>;
  /**
   * ADR-040, Task 4b: after a sandboxed run, removes each known placeholder path that is not in
   * `before` and is empty: a zero-byte regular file where a file is expected, or a directory that
   * holds only empty directories. Deepest first, so `.claude` goes only when it was absent before
   * and is empty once `.claude/.cc-writes` is gone. Never removes anything non-empty, pre-existing,
   * a symlink, or reached through a symlink. Best effort: a path that cannot be removed is left
   * for the git-dir fingerprint to flag. Returns the number of entries removed. No git command.
   */
  removeSandboxPlaceholders(repo: string, before: readonly string[]): Promise<number>;
  /** E10: the working tree's changes against HEAD. Read-only. */
  diffSummary(repo: string, opts?: GitDiffOptions): Promise<GitDiffSummary>;
  /** E10: `git add -A` and `git commit -m <message>`, only when the hash still matches. */
  commitAll(
    repo: string,
    message: string,
    expectedHash: string,
    opts?: GitCommitOptions,
  ): Promise<{ sha: string }>;
  /**
   * E11: switch to the parent and merge `origin/<parent>` then `upstream/<parent>`, fast-forward
   * when possible, otherwise a merge commit. Any conflict is aborted and reported.
   */
  updateParent(
    repo: string,
    parent: string,
    opts?: GitConfigGuard,
  ): Promise<{ ok: true } | { ok: false; conflict: true }>;
  /** E12: `git merge --no-ff <taskBranch>` into the parent; a conflict is aborted and reported. */
  mergeLocal(
    repo: string,
    parent: string,
    taskBranch: string,
    opts?: GitMergeOptions,
  ): Promise<{ ok: true; sha: string } | { ok: false; conflict: true }>;
  /**
   * E13: `git push origin <parent>` (never upstream, never forced). Refused when the parent is
   * protected, when an origin push URL is the upstream repository (same normalised URL or same
   * `owner/repo`), or when there is nothing to compare against.
   */
  pushParent(repo: string, parent: string, opts: GitPushOptions): Promise<{ ok: true }>;
  /**
   * E16: throws away the uncommitted develop changes of a rejected or cancelled task, only when the
   * working tree's diff hash still equals `expectedHash` (the state the user saw in the commit
   * approval) and the diff is safe: `git reset --hard HEAD` plus `git clean` of exactly the
   * untracked paths of that diff. Ignored files are left alone. A clean tree is a no-op.
   * Throws `diff_changed`, `unsafe_change`, `dirty_tree` (a merge in progress) or `config_changed`.
   */
  discardChanges(repo: string, expectedHash: string, opts?: GitConfigGuard): Promise<{ ok: true }>;
  /** Whether the local branch `refs/heads/<name>` exists. */
  branchExists(repo: string, name: string): Promise<boolean>;
  /** The commit `refs/heads/<name>` points at, or null when the branch does not exist. */
  branchTip(repo: string, name: string): Promise<string | null>;
  /** Commits on the local parent that `origin/<parent>` lacks, newest first. */
  commitsAhead(repo: string, parent: string): Promise<GitCommitSummary[]>;
  /**
   * E15: with a clean tree, switch to `returnTo` (null: stay on the current branch) and delete the
   * task branch (only when merged into another local branch, unless `force`). The task branch is
   * never deleted while it is checked out (`deleted: false`). A dirty tree is left exactly as it is.
   */
  cleanup(
    repo: string,
    taskBranch: string,
    returnTo: string | null,
    opts: { force: boolean },
  ): Promise<{ ok: true; deleted: boolean } | { ok: false; dirty: true }>;
}
