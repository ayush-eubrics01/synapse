/**
 * PullRequestProvider over the `gh` CLI (E13, E14, E17). Argv only (never a shell), no prompts,
 * a hard timeout. Errors carry fixed codes: stdout and stderr (which can echo the title, body or
 * tokens) are discarded and nothing here logs. Auth is whatever `gh` is configured with (HOME and
 * PATH are kept); tokens are never read.
 */
import {
  type CreatePrInput,
  type PrChecks,
  type PrErrorCode,
  type PrRef,
  type PrStatus,
  PullRequestError,
  type PullRequestProvider,
} from "@synapse/contracts";

export const GH_TIMEOUT_MS = 60_000;

const NAME = /^[A-Za-z0-9_.-]+$/;

function ref(owner: string | undefined, repo: string | undefined): PrRef | null {
  if (!owner || !repo) return null;
  const r = repo.replace(/\.git$/, "");
  if (!NAME.test(owner) || !NAME.test(r)) return null;
  return { owner, repo: r };
}

/** github.com only; any other host (or a malformed path) is null. */
export function parseGithubRemote(url: string): PrRef | null {
  const u = url.trim();
  let m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(u);
  if (!m) m = /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+)$/.exec(u);
  if (!m) m = /^git@github\.com:([^/]+)\/([^/]+)$/.exec(u);
  return m ? ref(m[1], m[2]) : null;
}

interface GhResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitHubCliOptions {
  /** The gh executable; defaults to `gh` on PATH. */
  binary?: string;
  timeoutMs?: number;
}

const FAIL = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT"]);
const OK = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

interface Check {
  status?: string;
  conclusion?: string;
  state?: string;
}

function mapChecks(rollup: unknown): PrChecks {
  if (!Array.isArray(rollup) || rollup.length === 0) return "none";
  let pending = false;
  for (const c of rollup as Check[]) {
    const outcome = (c.conclusion || c.state || "").toUpperCase();
    const status = (c.status || "").toUpperCase();
    if (FAIL.has(outcome)) return "failing";
    if ((status && status !== "COMPLETED") || !OK.has(outcome)) pending = true;
  }
  return pending ? "pending" : "passing";
}

export class GitHubCliProvider implements PullRequestProvider {
  private readonly binary: string;
  private readonly timeoutMs: number;

  constructor(opts: GitHubCliOptions = {}) {
    this.binary = opts.binary ?? "gh";
    this.timeoutMs = opts.timeoutMs ?? GH_TIMEOUT_MS;
  }

  private async run(args: string[], failure: PrErrorCode): Promise<GhResult> {
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn([this.binary, ...args], {
        cwd: "/",
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: process.env.HOME ?? "",
          GH_PROMPT_DISABLED: "1",
          NO_COLOR: "1",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch {
      throw new PullRequestError("gh_not_found");
    }
    const timer = setTimeout(() => proc.kill(), this.timeoutMs);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout as ReadableStream).text(),
        new Response(proc.stderr as ReadableStream).text(),
        proc.exited,
      ]);
      if (code !== 0) {
        throw new PullRequestError(/auth|logged in|GH_TOKEN/i.test(stderr) ? "gh_auth" : failure);
      }
      return { code, stdout, stderr: "" };
    } finally {
      clearTimeout(timer);
    }
  }

  async createPr(input: CreatePrInput): Promise<{ url: string; number: number }> {
    const { upstream, headOwner, branch, title, body } = input;
    const res = await this.run(
      [
        "pr",
        "create",
        "--repo",
        `${upstream.owner}/${upstream.repo}`,
        "--head",
        `${headOwner}:${branch}`,
        "--base",
        branch,
        "--title",
        title,
        "--body",
        body,
      ],
      "pr_create_failed",
    );
    const url = res.stdout
      .split("\n")
      .map((l) => l.trim())
      .find((l) => /^https:\/\/github\.com\/.+\/pull\/\d+$/.test(l));
    const n = url ? /\/pull\/(\d+)$/.exec(url)?.[1] : undefined;
    if (!url || !n) throw new PullRequestError("pr_create_failed");
    return { url, number: Number(n) };
  }

  async prStatus(input: { upstream: PrRef; number: number }): Promise<PrStatus> {
    const res = await this.run(
      [
        "pr",
        "view",
        String(input.number),
        "--repo",
        `${input.upstream.owner}/${input.upstream.repo}`,
        "--json",
        "number,url,state,mergeable,statusCheckRollup",
      ],
      "pr_status_failed",
    );
    let j: { state?: unknown; mergeable?: unknown; statusCheckRollup?: unknown };
    try {
      j = JSON.parse(res.stdout);
    } catch {
      throw new PullRequestError("pr_status_failed");
    }
    if (typeof j.state !== "string") throw new PullRequestError("pr_status_failed");
    return {
      state: j.state,
      mergeable: typeof j.mergeable === "string" ? j.mergeable : "UNKNOWN",
      checks: mapChecks(j.statusCheckRollup),
    };
  }

  async mergePr(input: {
    upstream: PrRef;
    number: number;
  }): Promise<{ merged: boolean; sha?: string }> {
    await this.run(
      [
        "pr",
        "merge",
        String(input.number),
        "--repo",
        `${input.upstream.owner}/${input.upstream.repo}`,
        "--merge",
      ],
      "pr_merge_failed",
    );
    return { merged: true };
  }
}
