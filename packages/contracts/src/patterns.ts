/**
 * Plain patterns with no runtime dependency, so client code can import them through
 * `@synapse/contracts/patterns` without bundling zod. Re-exported from the package root.
 */

/** A Jira project key (`DEMO`, `OPS_2`): the one rule for the API schemas and the web forms. */
export const JIRA_PROJECT_KEY_RE = /^[A-Z][A-Z0-9_]+$/;

const TEST_COMMAND_RE = /^[A-Za-z0-9 ._:/=@+-]{1,120}$/;

/** Words that evaluate code, launch arbitrary packages or install anything (amended: final review). */
const REFUSED_WORDS = new Set(["-c", "-e", "--eval", "exec", "x", "dlx", "pip", "install", "add"]);
/** A package script that runs tests: `test`, `test:unit`, `test-e2e`. */
const TEST_SCRIPT_RE = /^test([:\w-]*)$/;
/** A make target that runs tests or checks. */
const MAKE_TARGET_RE = /^(test|check)[\w:.-]*$/;
/** The only make flags allowed: parallelism, keep going, silent. */
const MAKE_FLAG_RE = /^(-j\d*|-k|-s|--keep-going|--silent|--jobs=\d+)$/;
const NPX_RUNNERS = new Set(["vitest", "jest", "mocha", "playwright", "ava"]);
const PY_TEST_MODULES = new Set(["pytest", "unittest"]);

/** `<pm> test …` or `<pm> run <test script> …`. */
const packageManagerTest = (rest: string[]) =>
  rest[0] === "test" || (rest[0] === "run" && TEST_SCRIPT_RE.test(rest[1] ?? ""));
/** `-m pytest|unittest …` after a Python interpreter. */
const pythonModuleTest = (rest: string[]) => rest[0] === "-m" && PY_TEST_MODULES.has(rest[1] ?? "");

/** Per runner: does the rest of the command (after the runner) run tests and nothing else? */
const RUNNER_RULES: Record<string, (rest: string[]) => boolean> = {
  bun: packageManagerTest,
  npm: packageManagerTest,
  pnpm: packageManagerTest,
  yarn: packageManagerTest,
  npx: (rest) => NPX_RUNNERS.has(rest[0] ?? ""),
  pytest: () => true,
  python: pythonModuleTest,
  python3: pythonModuleTest,
  uv: (rest) =>
    rest[0] === "run" &&
    (rest[1] === "pytest" ||
      ((rest[1] === "python" || rest[1] === "python3") && pythonModuleTest(rest.slice(2)))),
  make: (rest) =>
    rest.some((w) => MAKE_TARGET_RE.test(w)) &&
    rest.every((w) => MAKE_TARGET_RE.test(w) || MAKE_FLAG_RE.test(w)),
  go: (rest) => rest[0] === "test",
  cargo: (rest) => rest[0] === "test",
  deno: (rest) => rest[0] === "test",
};

/**
 * E5: a test command safe to grant as `Bash(<cmd>:*)`. Safe characters only (no `;`, `&`, `|`, `>`,
 * `<`, backquote, `$` or newline), at most 120 characters, a known runner as the first word, and
 * that runner's test form (amended: final review): `bun|npm|pnpm|yarn test …` or `… run test[:x]`,
 * `npx vitest|jest|mocha|playwright|ava …`, `pytest …`, `python|python3 -m pytest|unittest …`,
 * `uv run pytest …` or `uv run python -m pytest|unittest …`, `make` with only `test*`/`check*`
 * targets and `-j`/`-k`/`-s` flags, `go|cargo|deno test …`. Any `-c`, `-e`, `--eval`, `exec`, `x`,
 * `dlx`, `pip`, `install` or `add` word is refused. These rules constrain the user-confirmed
 * prefix only: the `Bash(<cmd>:*)` grant still lets the model append arguments at run time. That
 * is accepted (security-model §3.1) because the model can already edit the test code, which is
 * repository code.
 */
export function isSafeTestCommand(cmd: string): boolean {
  if (!TEST_COMMAND_RE.test(cmd)) return false;
  const words = cmd.split(" ").filter((w) => w !== "");
  const [first = "", ...rest] = words;
  const rule = Object.hasOwn(RUNNER_RULES, first) ? RUNNER_RULES[first] : undefined;
  if (!rule) return false;
  if (rest.some((w) => REFUSED_WORDS.has(w))) return false;
  return rule(rest);
}

/** M1: how closely the last test run matched the confirmed command. */
export type TestRun = "exact" | "partial" | "none";
export const TEST_RUNS: readonly TestRun[] = ["exact", "partial", "none"];

/**
 * M1: the one wording for a develop run's test result, on the commit card and in the PR body.
 * `exact`: the confirmed command ran as is; `partial`: it ran with extra arguments (a subset of
 * the suite, perhaps); `none`: it never ran.
 */
export function testResultLabel(testsPassed: boolean, testRun: TestRun): string {
  if (testRun === "none") return "Tests not run";
  const outcome = testsPassed ? "passed" : "failed";
  return testRun === "partial" ? `Partial test run (${outcome})` : `Tests ${outcome}`;
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
  // Final review: step-result and cleanup reasons, guards and PR outcomes.
  "lock_lost",
  "lock_held_by_other",
  "step_running",
  "not_terminal",
  "repo_has_active_task",
  "checks_failing",
  "merged_after_cancel",
  "cleanup_incomplete",
] as const;
export type EngineeringReasonCode = (typeof ENGINEERING_REASON_CODES)[number];
