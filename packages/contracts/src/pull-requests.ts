/** Port for the pull request provider (Phase 10, E13/E14). Adapters live in integrations/github. */

export interface PrRef {
  owner: string;
  repo: string;
}

export const PR_ERROR_CODES = [
  "gh_not_found",
  "gh_auth",
  "pr_create_failed",
  "pr_status_failed",
  "pr_merge_failed",
  "unsupported_remote",
] as const;
export type PrErrorCode = (typeof PR_ERROR_CODES)[number];

/** Carries a fixed code only: never the title, body or the tool's output. */
export class PullRequestError extends Error {
  readonly code: PrErrorCode;
  constructor(code: PrErrorCode) {
    super(code);
    this.name = "PullRequestError";
    this.code = code;
  }
}

export type PrChecks = "passing" | "failing" | "pending" | "none";

export interface PrStatus {
  state: string;
  mergeable: string;
  checks: PrChecks;
  /** The PR head commit (`headRefOid`), or null when gh did not report a valid sha. */
  headSha: string | null;
}

/** A full git object id (sha1 or sha256), lowercase hex. */
export const COMMIT_SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export interface CreatePrInput {
  upstream: PrRef;
  headOwner: string;
  branch: string;
  title: string;
  body: string;
}

export interface PullRequestProvider {
  /** Owner and repo of a stored (credential-stripped) remote URL on a supported host, else null. */
  repoRef(url: string): PrRef | null;
  createPr(input: CreatePrInput): Promise<{ url: string; number: number }>;
  prStatus(input: { upstream: PrRef; number: number }): Promise<PrStatus>;
  /** Merges only while the PR head is still `headSha` (the commit the user approved pushing). */
  mergePr(input: {
    upstream: PrRef;
    number: number;
    headSha: string;
  }): Promise<{ merged: boolean; sha?: string }>;
}
