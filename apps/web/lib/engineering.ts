import type {
  Approval,
  EngineeringCleanupView,
  EngineeringStep,
  EngineeringTaskDetail,
  EngineeringTaskStatus,
  EngineeringTaskView,
  EnvironmentView,
  RepositoryView,
} from "@synapse/contracts";
import {
  type ApprovalTextEdit,
  type ApprovalTextField,
  isValidApprovalText,
} from "@synapse/contracts";
import {
  isSafeTestCommand,
  type TestRun,
  taskBranchName,
  testResultLabel,
} from "@synapse/contracts/patterns";

/** Step labels for the timeline (spec E8-E18). */
const STEP_LABELS: Record<EngineeringStep, string> = {
  investigate: "Investigate",
  branch: "Create branch",
  develop: "Develop",
  commit: "Commit",
  update_parent: "Update parent branch",
  merge_local: "Merge locally",
  push_pr: "Push and open PR",
  merge_pr: "Merge PR",
  cleanup: "Clean up",
};

export function stepLabel(step: EngineeringStep): string {
  return STEP_LABELS[step];
}

export const STEP_ORDER = Object.keys(STEP_LABELS) as EngineeringStep[];

/**
 * Plain-English labels for every fixed reason code: task failures, step outputs, preflight and git
 * errors, pull request errors, run error kinds and route refusals. The model's words and raw
 * codes never reach the screen. `reasonLabel.test` keeps this in step with the contracts lists.
 */
const REASONS: Record<string, string> = {
  // Preflight (E7)
  not_a_repository: "The registered folder is no longer a git repository.",
  merge_in_progress:
    "A merge or rebase is already in progress in the repository. Finish or abort it first.",
  dirty_tree: "The repository has uncommitted changes. Commit or stash them, then try again.",
  missing_remote: "The repository is missing its origin or upstream remote.",
  upstream_push_enabled:
    "Pushing to upstream is not disabled in this clone. Synapse never pushes to upstream.",
  parent_missing_origin: "The parent branch does not exist on origin.",
  parent_missing_upstream: "The parent branch does not exist on upstream.",
  // Git workflow
  git_failed: "A git command failed.",
  git_timeout: "A git command took too long and was stopped.",
  fetch_failed: "Fetching from the remote failed. Check the network and your git access.",
  push_failed: "Pushing the parent branch to origin was rejected or failed.",
  invalid_ref: "A branch name is not valid.",
  branch_exists: "The task branch already exists.",
  branch_missing: "A branch the task needs no longer exists.",
  branch_moved:
    "A branch moved after you approved, so the step was stopped. Nothing was pushed or merged.",
  diff_changed: "The changes differ from what you approved.",
  unsafe_change:
    "The changes touch .git, a path outside the repository or an unsafe link, so they were not committed.",
  nothing_to_commit: "There is nothing to commit.",
  push_target_is_upstream:
    "The origin remote points at the upstream repository. Synapse never pushes there.",
  no_upstream_reference: "No upstream repository is registered to compare the push target against.",
  config_changed: "The git configuration changed while the task was running, so it was stopped.",
  origin_changed:
    "The origin remote no longer points at the registered fork, so nothing was pushed. Accept the current remotes in the repository settings or fix origin, then cancel the task.",
  // Unsafe diff reasons
  git_dir_changed: "The .git directory or git configuration changed during the run.",
  git_path: "A changed file is inside .git.",
  outside_repo: "A changed file is outside the repository.",
  symlink_outside: "A link points outside the repository or into .git.",
  not_a_file: "A changed entry is a submodule, an embedded repository or a special file.",
  unreadable: "A changed file could not be read.",
  git_metadata_changed: "A .gitattributes, .gitmodules or .lfsconfig file changed.",
  // Pull requests
  gh_not_found: "The GitHub CLI (gh) is not installed.",
  gh_auth: "The GitHub CLI is not signed in. Run gh auth login.",
  pr_create_failed: "Opening the pull request failed.",
  pr_status_failed: "Reading the pull request status failed.",
  pr_merge_failed: "Merging the pull request failed.",
  unsupported_remote:
    "The origin remote is not a GitHub repository, so no pull request can be made.",
  // Step outcomes
  no_changes: "The run made no changes, so there is nothing to commit.",
  parent_conflict:
    "Updating the parent branch caused a conflict. Resolve it by hand, then cancel the task.",
  merge_conflict:
    "Merging the task branch caused a conflict. Resolve it by hand, then cancel the task.",
  pr_head_moved: "The pull request's branch moved after it was approved, so it was not merged.",
  branch_kept: "The task branch was kept because it still has work that was not merged.",
  pushed_not_pr: "The parent branch was pushed but the pull request was not opened.",
  resume_unsafe:
    "The task was interrupted and its repository is no longer in a state that is safe to resume.",
  branch_changed: "The repository is on a different branch than the task expects.",
  revalidate_failed: "The approval no longer matched the repository, so it was withdrawn.",
  invalid_payload: "The approval could not be read, so it was withdrawn.",
  state_changed: "The task changed while this was in progress.",
  lock_held: "Another engineering task holds the lock.",
  max_turns: "Claude ran out of turns before finishing.",
  timeout: "The run took too long and was stopped.",
  lock_lost: "The task no longer holds the engineering lock, so the step was stopped.",
  lock_held_by_other:
    "Another engineering task holds the lock, so this task's cleanup did not touch the repository.",
  step_running: "Another step of this task is still running. Cleanup runs when it ends.",
  not_terminal: "The task is still running, so it was not cleaned up.",
  repo_has_active_task:
    "This repository has an engineering task that is not finished. Cancel or finish it first.",
  checks_failing:
    "The pull request's checks are failing, so it was not merged. Fix the checks, then use Check again, or cancel the task.",
  sandbox_unavailable:
    "The test sandbox could not start. Install bubblewrap and socat (sudo apt install bubblewrap socat), then cancel this task and propose it again.",
  sandbox_path_too_long:
    "The sandbox temp path is too long. Set XDG_CACHE_HOME to a shorter path and restart Synapse.",
  sandbox_root_masked:
    "Set XDG_CACHE_HOME to a directory outside ~/.config and the other protected folders, then restart Synapse and try again.",
  repo_in_masked_path:
    "This repository is inside a folder the test sandbox hides (for example /tmp or ~/.config), so develop runs are refused.",
  sandbox_disabled: "Develop runs are disabled because the test sandbox is turned off.",
  not_pending: "This approval was already decided or replaced.",
  invalid_text: "The text is empty, too long or has characters that can't be used.",
  merged_after_cancel:
    "The pull request was merged while the task was being cancelled, so the task is completed.",
  cleanup_incomplete:
    "The task's local cleanup stopped part way. Check the repository, then cancel the task to clean up again.",
  // Route refusals
  not_found: "That task or item no longer exists.",
  invalid_input: "Some of the input is not valid.",
  invalid_state: "The task is not in a state that allows this.",
  ambiguous_repository:
    "More than one repository could apply. Create the task from the Engineering section and choose one.",
  repository_required: "Choose a repository for the task.",
  no_content: "There is no text to make a task from.",
  unknown_branch: "That branch does not exist in the repository.",
  unknown_environment: "That environment is not registered for the repository.",
  protected_branch: "That is a protected branch. Choose another parent branch.",
  unsafe_test_command: "That test command is not allowed.",
  path_unavailable: "The repository folder is no longer available at its registered path.",
  // Run error kinds
  transient_network: "A network problem interrupted the run.",
  connector_not_ready: "A Claude connector was not ready.",
  rate_limited: "Claude was rate limited.",
  quota_exhausted: "The Claude quota is used up for now.",
  user_active: "Waiting while you work in Claude Code.",
  auth_failed: "Claude is not signed in.",
  auth_paused: "Claude sign-in needs attention.",
  permission_denied: "Claude was refused a permission it needed.",
  incomplete_ai_output: "Claude's answer was incomplete.",
  parse_failed: "Claude's answer could not be read.",
  needs_attention: "The run needs your attention.",
  provider_error: "Claude reported an error.",
  cancelled_before_spawn: "The run was cancelled before it started.",
  output_too_large: "A tool result was too large for Claude to read.",
  unknown: "The run failed for an unknown reason.",
};

const UNKNOWN_REASON = "Something unexpected stopped the task.";

/** A plain-English label for a fixed reason code; empty for none. Unknown codes are never echoed. */
export function reasonLabel(code: string | null | undefined): string {
  if (code === null || code === undefined || code === "") return "";
  if (code.startsWith("registry_error:")) return "The repository registry refused this.";
  return Object.hasOwn(REASONS, code) ? (REASONS[code] as string) : UNKNOWN_REASON;
}

/** The sidebar footer and Running panel text for the engineering lock. */
export function lockText(lock: { held: boolean; taskTitle?: string } | null | undefined): string {
  if (!lock) return "unknown";
  if (!lock.held) return "free";
  return lock.taskTitle ? `busy · ${lock.taskTitle}` : "busy";
}

export const STATUS_LABELS: Record<EngineeringTaskStatus, string> = {
  proposed: "Proposed",
  investigating: "Investigating",
  planned: "Plan ready",
  approved: "Approved",
  queued: "Queued",
  in_progress: "In progress",
  awaiting_approval: "Waiting for you",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  needs_attention: "Needs attention",
};

export function isTerminal(status: EngineeringTaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/** H2: the badges for what a finished task's cleanup left behind, in a fixed order. */
export function cleanupBadges(c: EngineeringCleanupView | null): string[] {
  if (!c) return [];
  const out: string[] = [];
  if (c.branchKept) out.push("Branch kept");
  if (c.pushedNotPr) out.push("Pushed, no PR");
  if (c.dirtyTree) out.push("Uncommitted changes left");
  if (c.priorStatus) out.push(`Cancelled from ${STATUS_LABELS[c.priorStatus]}`);
  return out;
}

export interface TaskGroups {
  active: EngineeringTaskView[];
  planned: EngineeringTaskView[];
  proposed: EngineeringTaskView[];
  queue: EngineeringTaskView[];
  history: EngineeringTaskView[];
}

export function groupTasks(tasks: EngineeringTaskView[]): TaskGroups {
  const g: TaskGroups = { active: [], planned: [], proposed: [], queue: [], history: [] };
  for (const t of tasks) {
    if (isTerminal(t.status)) g.history.push(t);
    else if (t.status === "proposed") g.proposed.push(t);
    else if (t.status === "planned") g.planned.push(t);
    else if (t.status === "approved" || t.status === "queued") g.queue.push(t);
    else g.active.push(t);
  }
  return g;
}

// ---------------------------------------------------------------- plan approval form (E4)

export function testCommandError(cmd: string): string | null {
  if (cmd.trim() === "") return "A test command is required.";
  if (!isSafeTestCommand(cmd)) {
    return "Not allowed. Use a test command such as bun test, npm test, npm run test:unit, npx vitest, pytest, python -m pytest, make test, go test ./... or cargo test, with plain arguments and no ; & | > < $ or quotes.";
  }
  return null;
}

const BRANCH_RE = /^[A-Za-z0-9._/-]+$/;

export function parentBranchError(branch: string, repo: RepositoryView | null): string | null {
  if (branch === "") return "A parent branch is required.";
  if (
    branch.length > 100 ||
    !BRANCH_RE.test(branch) ||
    branch.startsWith("-") ||
    branch.includes("..") ||
    branch.includes("//") ||
    branch.endsWith("/") ||
    branch.endsWith(".lock")
  ) {
    return "That is not a safe branch name.";
  }
  const protectedEnv = repo?.environments.find((e) => e.protected && e.branch === branch);
  if (protectedEnv)
    return `${branch} is a protected branch (${protectedEnv.name}). Choose another.`;
  return null;
}

export interface PlanFormValues {
  environmentId: string;
  parentBranch: string;
  testCommand: string;
  remember: boolean;
}

/** Prefill: the environment the tracked branch belongs to, its branch, and the plan's test command. */
export function defaultPlanForm(
  task: Pick<EngineeringTaskDetail, "plan">,
  repo: RepositoryView | null,
): PlanFormValues {
  const tracked = repo?.trackedBranch ?? "";
  const env = repo?.environments.find((e) => !e.protected && e.branch === tracked);
  return {
    environmentId: env?.id ?? "",
    parentBranch: env?.branch ?? tracked,
    testCommand: task.plan?.testCommand ?? "",
    remember: false,
  };
}

/** The auto-deploy environment a merge to this parent would trigger: the chosen one, else by branch. */
export function deployEnvironment(
  repo: RepositoryView | null,
  environmentId: string,
  parentBranch: string,
): EnvironmentView | null {
  if (!repo) return null;
  const chosen = environmentId ? repo.environments.find((e) => e.id === environmentId) : undefined;
  const env = chosen ?? repo.environments.find((e) => e.branch === parentBranch);
  return env?.autoDeploysOnMerge ? env : null;
}

export function taskBranchOf(
  task: Pick<EngineeringTaskView, "id" | "title" | "taskBranch">,
): string {
  return task.taskBranch ?? taskBranchName(task.id, task.title);
}

// ---------------------------------------------------------------- diff (E10)

export type DiffLineKind = "meta" | "hunk" | "add" | "del" | "ctx";
export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}
export interface DiffFileView {
  path: string;
  added: number;
  removed: number;
  lines: DiffLine[];
}

/** Splits a unified diff into files with classified lines. Text only: nothing here is HTML. */
export function parseDiff(diffText: string): DiffFileView[] {
  if (diffText.trim() === "") return [];
  const files: DiffFileView[] = [];
  let cur: DiffFileView | null = null;
  let inHunk = false;
  const open = (path: string): DiffFileView => {
    const f: DiffFileView = { path, added: 0, removed: 0, lines: [] };
    files.push(f);
    inHunk = false;
    return f;
  };
  for (const line of diffText.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      cur = open(m?.[2] ?? line.slice("diff --git ".length));
      cur.lines.push({ kind: "meta", text: line });
      continue;
    }
    cur ??= open("(diff)");
    if (line.startsWith("@@")) {
      inHunk = true;
      cur.lines.push({ kind: "hunk", text: line });
    } else if (!inHunk) {
      cur.lines.push({ kind: "meta", text: line });
    } else if (line.startsWith("+")) {
      cur.added += 1;
      cur.lines.push({ kind: "add", text: line });
    } else if (line.startsWith("-")) {
      cur.removed += 1;
      cur.lines.push({ kind: "del", text: line });
    } else {
      cur.lines.push({ kind: "ctx", text: line });
    }
  }
  return files;
}

export interface DevelopOutputView {
  diffText: string;
  truncated: boolean;
  files: Array<{ path: string; added: number; removed: number }>;
  testsPassed: boolean | null;
  testOutputTail: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The develop step's output on a task detail, read defensively (it is stored JSON). */
export function developOutput(
  task: EngineeringTaskDetail | null | undefined,
): DevelopOutputView | null {
  const out = task?.steps.find((s) => s.step === "develop")?.output;
  if (!isRecord(out)) return null;
  return {
    diffText: typeof out.diffText === "string" ? out.diffText : "",
    truncated: out.truncated === true,
    files: fileList(out.files),
    testsPassed: typeof out.testsPassed === "boolean" ? out.testsPassed : null,
    testOutputTail: typeof out.testOutputTail === "string" ? out.testOutputTail : "",
  };
}

function fileList(v: unknown): Array<{ path: string; added: number; removed: number }> {
  if (!Array.isArray(v)) return [];
  return v.flatMap((f) =>
    isRecord(f) && typeof f.path === "string"
      ? [
          {
            path: f.path,
            added: typeof f.added === "number" ? f.added : 0,
            removed: typeof f.removed === "number" ? f.removed : 0,
          },
        ]
      : [],
  );
}

// ---------------------------------------------------------------- approvals (E20)

export interface CommitRef {
  sha: string;
  subject: string;
}

export type EngineeringApproval =
  | {
      kind: "commit";
      taskId: string;
      message: string;
      files: Array<{ path: string; added: number; removed: number }>;
      filesTotal: number;
      testsPassed: boolean | null;
      /** M1: how the confirmed test command ran; null on a payload from before it existed. */
      testRun: TestRun | null;
    }
  | {
      kind: "merge_local";
      taskId: string;
      parentBranch: string;
      taskBranch: string;
      commitSha: string;
      commits: CommitRef[];
    }
  | {
      kind: "push_pr";
      taskId: string;
      parentBranch: string;
      commits: CommitRef[];
      commitsTotal: number;
      mergeSha: string;
      title: string;
      body: string;
      autoDeploys: boolean;
      environmentName: string | null;
    }
  | {
      kind: "merge_pr";
      taskId: string;
      parentBranch: string;
      prNumber: number | null;
      prUrl: string | null;
      state: string;
      mergeable: string;
      checks: string;
      /** M6: when the checks were read (ISO), or null. */
      checkedAt: string | null;
      autoDeploys: boolean;
      environmentName: string | null;
      pushedSha: string;
    };

export type EngineeringApprovalKind = EngineeringApproval["kind"];

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const commitRefs = (v: unknown): CommitRef[] =>
  Array.isArray(v)
    ? v.flatMap((c) => (isRecord(c) ? [{ sha: str(c.sha), subject: str(c.subject) }] : []))
    : [];

const ACTION_KIND: Record<string, EngineeringApprovalKind> = {
  "engineering.commit": "commit",
  "engineering.merge_local": "merge_local",
  "engineering.push_pr": "push_pr",
  "engineering.merge_pr": "merge_pr",
};

export function isEngineeringApproval(a: Pick<Approval, "action">): boolean {
  return Object.hasOwn(ACTION_KIND, a.action);
}

/** An engineering approval's payload, read defensively; null for any other approval. */
export function engineeringApproval(a: Approval): EngineeringApproval | null {
  const kind = ACTION_KIND[a.action];
  if (!kind) return null;
  const p = isRecord(a.payload) ? a.payload : {};
  const taskId = str(p.taskId);
  switch (kind) {
    case "commit":
      return {
        kind,
        taskId,
        message: str(p.message),
        files: fileList(p.files),
        filesTotal: typeof p.filesTotal === "number" ? p.filesTotal : fileList(p.files).length,
        testsPassed: typeof p.testsPassed === "boolean" ? p.testsPassed : null,
        testRun:
          p.testRun === "exact" || p.testRun === "partial" || p.testRun === "none"
            ? p.testRun
            : null,
      };
    case "merge_local": {
      const commits = commitRefs(p.commits);
      return {
        kind,
        taskId,
        parentBranch: str(p.parentBranch),
        taskBranch: str(p.taskBranch),
        commitSha: str(p.commitSha),
        commits,
      };
    }
    case "push_pr": {
      const commits = commitRefs(p.commits);
      return {
        kind,
        taskId,
        parentBranch: str(p.parentBranch),
        commits,
        commitsTotal: typeof p.commitsTotal === "number" ? p.commitsTotal : commits.length,
        mergeSha: str(p.mergeSha),
        title: str(p.prTitle) || str(p.title),
        body: str(p.prBody) || str(p.body),
        autoDeploys: p.autoDeploys === true,
        environmentName: str(p.environmentName) || null,
      };
    }
    case "merge_pr": {
      const s = isRecord(p.status) ? p.status : {};
      return {
        kind,
        taskId,
        parentBranch: str(p.parentBranch),
        prNumber: typeof p.prNumber === "number" ? p.prNumber : null,
        prUrl: str(p.prUrl) || null,
        state: str(s.state),
        mergeable: str(s.mergeable),
        checks: str(s.checks),
        checkedAt: str(s.checkedAt) || null,
        autoDeploys: p.autoDeploys === true,
        environmentName: str(p.environmentName) || null,
        pushedSha: str(p.pushedSha),
      };
    }
  }
}

/**
 * M1: the commit card's test chip: its text and tone. A payload without `testRun` (requested
 * before the final review) reads as an exact run when a result exists.
 */
export function testChip(
  testsPassed: boolean | null,
  testRun: TestRun | null,
): { label: string; tone: "green" | "red" | "amber" | "neutral" } {
  if (testsPassed === null || testRun === "none") {
    return { label: testResultLabel(false, "none"), tone: "neutral" };
  }
  const run = testRun ?? "exact";
  const label = testResultLabel(testsPassed, run);
  if (run === "partial") return { label, tone: "amber" };
  return { label, tone: testsPassed ? "green" : "red" };
}

export interface ChecksView {
  checks: string;
  checkedAt: string | null;
}

/**
 * M6: the PR checks to show on the merge card: the status the approval was requested with, or
 * the fresher one the last revalidation read (kept on the merge_pr step), whichever is newer.
 */
export function latestChecks(
  payload: ChecksView,
  task: EngineeringTaskDetail | null | undefined,
): ChecksView {
  const out = task?.steps.find((s) => s.step === "merge_pr")?.output;
  const fresh = isRecord(out) && isRecord(out.freshStatus) ? out.freshStatus : null;
  if (!fresh || typeof fresh.checks !== "string" || typeof fresh.checkedAt !== "string") {
    return payload;
  }
  if (payload.checkedAt !== null && payload.checkedAt >= fresh.checkedAt) return payload;
  return { checks: fresh.checks, checkedAt: fresh.checkedAt };
}

/** `HH:MM` (local time) of an ISO timestamp, or empty for an invalid one. */
export function clockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** M7: what cancelling (or rejecting a step, which cancels) does, shown before it happens. */
export const CANCEL_CONFIRM_TEXT =
  "This cancels the task and discards Synapse's uncommitted changes. Committed work is kept on the task branch.";

/** I3: the note over a draft that came from Jira or Slack; null for one the user wrote. */
export function draftSourceNote(source: EngineeringTaskView["source"]): string | null {
  if (source === "manual") return null;
  const from = source === "jira" ? "Jira" : "Slack";
  return `From ${from}: written by someone else. Review and edit before approving — only what you approve is given to Claude.`;
}

/** Only an https link is rendered as one: the URL comes from a payload, not from the user. */
export function safeHttpsUrl(url: string | null): string | null {
  return url?.startsWith("https://") ? url : null;
}

export const shortSha = (sha: string): string => sha.slice(0, 7);

/** `ApiError.code`, else a generic text, as a sentence the user can act on. */
export function engineeringErrorText(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "string") return reasonLabel(code);
  return "Could not reach the API.";
}

/** Runs an engineering call; a refusal is rethrown as its plain-English reason. */
export async function friendly<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw new Error(engineeringErrorText(e));
  }
}

export const SANDBOX_ON_TEXT =
  "Tests run in a sandbox: no network, writes only inside the repository";
export const SANDBOX_OFF_TEXT = "Develop runs are disabled: the test sandbox is turned off";

export type TaskSource = { kind: "jira"; key: string } | { kind: "slack"; messageId: string };

/** The repositories to offer when a proposal is ambiguous, by name. */
export function repositoryChoices(repos: RepositoryView[]): Array<{ id: string; name: string }> {
  return repos
    .map((r) => ({ id: r.id, name: r.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Failing checks at the merge step can be re-checked by asking for a new merge approval. */
export function canCheckAgain(
  t: Pick<EngineeringTaskView, "status" | "failure" | "currentStep">,
): boolean {
  return (
    t.status === "needs_attention" && t.failure === "checks_failing" && t.currentStep === "merge_pr"
  );
}

export type ApprovalTextValues = Partial<Record<ApprovalTextField, string>>;

/** The editable text of a commit or push approval; null for the kinds with none. */
export function approvalTextValues(p: EngineeringApproval): ApprovalTextValues | null {
  if (p.kind === "commit") return { commitMessage: p.message };
  if (p.kind === "push_pr") return { prTitle: p.title, prBody: p.body };
  return null;
}

/** Only the fields whose text differs from the original. */
export function changedText(
  original: ApprovalTextValues,
  current: ApprovalTextValues,
): ApprovalTextEdit {
  const out: ApprovalTextEdit = {};
  for (const k of Object.keys(current) as ApprovalTextField[]) {
    const v = current[k];
    if (v !== undefined && v !== original[k]) out[k] = v;
  }
  return out;
}

const TEXT_PROBLEMS: Record<ApprovalTextField, string> = {
  commitMessage: "A commit message needs 1 to 5000 characters and a first line of at most 200.",
  prTitle: "A PR title needs 1 to 200 characters on one line.",
  prBody: "A PR body can have at most 20000 characters.",
};

/** The first failing field's sentence. It only gates Save; the API is the authority. */
export function approvalTextProblem(v: ApprovalTextValues): string | null {
  for (const k of ["commitMessage", "prTitle", "prBody"] as const) {
    const value = v[k];
    if (value !== undefined && !isValidApprovalText(k, value)) return TEXT_PROBLEMS[k];
  }
  return null;
}
