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
