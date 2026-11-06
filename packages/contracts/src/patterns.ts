/**
 * Plain patterns with no runtime dependency, so client code can import them through
 * `@synapse/contracts/patterns` without bundling zod. Re-exported from the package root.
 */

/** A Jira project key (`DEMO`, `OPS_2`): the one rule for the API schemas and the web forms. */
export const JIRA_PROJECT_KEY_RE = /^[A-Z][A-Z0-9_]+$/;

const TEST_COMMAND_RE = /^[A-Za-z0-9 ._:/=@+-]{1,120}$/;
const TEST_COMMAND_RUNNERS = [
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "npx",
  "uv",
  "pytest",
  "python",
  "python3",
  "make",
  "go",
  "cargo",
  "deno",
];

const SINGLE_WORD_RUNNERS = ["pytest", "make"];

/**
 * E5: a test command safe to grant as `Bash(<cmd>:*)`. Safe characters only (no `;`, `&`, `|`, `>`,
 * `<`, backquote, `$` or newline), at most 120 characters, and the first word is a known runner.
 */
export function isSafeTestCommand(cmd: string): boolean {
  if (!TEST_COMMAND_RE.test(cmd)) return false;
  const words = cmd.split(" ").filter((w) => w !== "");
  const first = words[0] ?? "";
  if (!TEST_COMMAND_RUNNERS.includes(first)) return false;
  // Interpreters and package runners alone would run arbitrary code or a REPL (amended: final T1 review).
  return words.length >= 2 || SINGLE_WORD_RUNNERS.includes(first);
}

/** E-branch: `synapse/<first 8 of id>-<slug of title, at most 32>`. */
export function taskBranchName(id: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return `synapse/${id.slice(0, 8)}-${slug === "" ? "task" : slug}`;
}

/**
 * Phase 10: the fixed reason codes an engineering task can carry in `failure` or a step output, or
 * an engineering route can answer with, beyond the git, pull request and error-kind lists
 * (`GIT_PREFLIGHT_REASONS`, `GIT_WORKFLOW_ERROR_CODES`, `GIT_UNSAFE_REASONS`, `PR_ERROR_CODES`,
 * `errorKindSchema`). Client code labels every one of them (`reasonLabel`); a test keeps the two in step.
 */
export const ENGINEERING_REASON_CODES = [
  // Route refusals (E19).
  "not_found",
  "invalid_input",
  "invalid_state",
  "ambiguous_repository",
  "repository_required",
  "no_content",
  "unknown_branch",
  "unknown_environment",
  "protected_branch",
  "unsafe_test_command",
  "path_unavailable",
  // Step outcomes.
  "unsafe_change",
  "no_changes",
  "config_changed",
  "parent_conflict",
  "merge_conflict",
  "pr_head_moved",
  "branch_kept",
  "pushed_not_pr",
  "resume_unsafe",
  "branch_changed",
  "revalidate_failed",
  "invalid_payload",
  "unsupported_remote",
  "state_changed",
  "lock_held",
  "max_turns",
  "timeout",
] as const;
export type EngineeringReasonCode = (typeof ENGINEERING_REASON_CODES)[number];
