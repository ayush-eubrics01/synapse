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
}

export interface CreatePrInput {
  upstream: PrRef;
  headOwner: string;
  branch: string;
  title: string;
  body: string;
}

export interface PullRequestProvider {
  createPr(input: CreatePrInput): Promise<{ url: string; number: number }>;
  prStatus(input: { upstream: PrRef; number: number }): Promise<PrStatus>;
  mergePr(input: { upstream: PrRef; number: number }): Promise<{ merged: boolean; sha?: string }>;
}
