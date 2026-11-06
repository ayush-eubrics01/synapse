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
