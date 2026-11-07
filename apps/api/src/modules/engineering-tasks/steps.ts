import { realpathSync } from "node:fs";
import {
  type AIExecutionResult,
  type Approval,
  type ApprovalTextEdit,
  type ApprovalTextField,
  COMMIT_SUBJECT_MAX,
  DEVELOP_RETRY_REASONS,
  type EngineeringStep,
  ExecutorError,
  type GitWorkflow,
  GitWorkflowError,
  type InvestigationOutput,
  isSafeTestCommand,
  isValidApprovalText,
  JobError,
  type Operation,
  PR_BODY_EDIT_MAX,
  PR_TITLE_MAX,
  type PrStatus,
  PullRequestError,
  type PullRequestProvider,
  type RiskLevel,
  retryDecision,
  SANDBOX_ROOT_MASKED,
  SANDBOX_ROOT_MASKED_HINT,
  SANDBOX_TOOL_RESULT_RE,
  type TestRun,
  testResultLabel,
  testRunSchema,
} from "@synapse/contracts";
import { type Db, type DbOrTx, schema } from "@synapse/database";
import { type Clock, newId } from "@synapse/shared";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import type { ApprovalEngine } from "../../core/approvals/approvals";
import { registerIntegrationExecutor } from "../../core/approvals/execution";
import type { AuditLogger } from "../../core/audit/audit";
import type { SettingsService } from "../../core/config/settings";
import type { OutboxDispatcher } from "../../core/events/dispatcher";
import type { EventPublisher } from "../../core/events/publisher";
import type { HealthCheck } from "../../core/health/health";
import type { JobQueue } from "../../core/jobs/queue";
import { SANDBOX_REQUIRED_REASON } from "../../core/orchestrator/validator";
import {
  parseDevelopReply,
  REPO_IN_MASKED_PATH,
  SANDBOX_PATH_TOO_LONG,
  SANDBOX_PATH_TOO_LONG_HINT,
  testResultFrom,
} from "../../intelligence/engineering/develop-prompt";
import { type EngineeringLock, STEP_JOB } from "./lock";
import {
  ACTIVE_STATUSES,
  EngineeringTaskError,
  EngineeringTaskStore,
  priorFailureOf,
  priorTerminalStatus,
  type TaskRow,
  TERMINAL_STATUSES,
} from "./store";

const { repositories, repositoryEnvironments, approvals: approvalsTable } = schema;
const MODULE = "engineering-tasks";
const WORKER = "engineering";
/** `targetIntegration` of every engineering approval (one executor per action routes on it). */
export const ENGINEERING_INTEGRATION = "engineering";
const DECISIONS_CONSUMER = "engineering.step_decisions";

const COMMIT_DESCRIPTION_MAX = 1000;
const PR_BODY_MAX = 4000;
const PAYLOAD_FILES_MAX = 500;
const PAYLOAD_COMMITS_MAX = 50;

const clip = (s: string, n: number) => [...s].slice(0, n).join("");
/** Clips to n code points, then further until the UTF-16 length is within n (zod `max` counts units). */
const clipUnits = (s: string, n: number) => {
  let r = clip(s, n);
  while (r.length > n) r = [...r].slice(0, -1).join("");
  return r;
};
const codeOf = (e: unknown): string =>
  e instanceof GitWorkflowError || e instanceof PullRequestError ? e.code : "git_failed";

/** The steps a job (`engineering.step`) drives; the rest run from approval executors. */
export type JobStep = "branch" | "develop" | "update_parent" | "cleanup";
export const JOB_STEPS: readonly JobStep[] = ["branch", "develop", "update_parent", "cleanup"];

type ApprovalStep = "commit" | "merge_local" | "push_pr" | "merge_pr";
const ACTION_STEP: Record<string, ApprovalStep> = {
  "engineering.commit": "commit",
  "engineering.merge_local": "merge_local",
  "engineering.push_pr": "push_pr",
  "engineering.merge_pr": "merge_pr",
};

// ---- approval payloads (what the user sees and approves) ------------------------------------

const fileSchema = z.object({ path: z.string(), added: z.number(), removed: z.number() });

export const commitPayloadSchema = z.object({
  taskId: z.string().min(1),
  diffHash: z.string().min(1),
  gitDirBaseline: z.string().min(1),
  configFingerprint: z.string().min(1),
  files: z.array(fileSchema),
  filesTotal: z.number().int(),
  testsPassed: z.boolean(),
  /** M1: absent on approvals requested before the final review (read as exact/none). */
  testRun: testRunSchema.optional(),
  message: z.string().min(1).max(8000),
});
export type CommitPayload = z.infer<typeof commitPayloadSchema>;

export const mergeLocalPayloadSchema = z.object({
  taskId: z.string().min(1),
  parentBranch: z.string(),
  taskBranch: z.string(),
  commitSha: z.string(),
  configFingerprint: z.string().min(1),
});

const deployNotice = { autoDeploys: z.boolean(), environmentName: z.string().optional() };

export const pushPrPayloadSchema = z.object({
  taskId: z.string().min(1),
  parentBranch: z.string(),
  commits: z.array(z.object({ sha: z.string(), subject: z.string() })),
  commitsTotal: z.number().int(),
  /** The parent tip after merge_local: exactly this commit is pushed. */
  mergeSha: z.string().min(1),
  prTitle: z.string().min(1).max(256),
  prBody: z.string().max(PR_BODY_EDIT_MAX),
  configFingerprint: z.string().min(1),
  ...deployNotice,
});

export const mergePrPayloadSchema = z.object({
  taskId: z.string().min(1),
  parentBranch: z.string(),
  prNumber: z.number().int().positive(),
  prUrl: z.string(),
  status: z
    .object({
      state: z.string(),
      mergeable: z.string(),
      checks: z.string(),
      headSha: z.string().nullable(),
      /** M6: when the status was read (the card shows "checks at <time>"). */
      checkedAt: z.string().optional(),
    })
    .nullable(),
  /** The commit pushed to the fork: the PR is merged only while its head is still this. */
  pushedSha: z.string().min(1),
  ...deployNotice,
});

const PAYLOAD_SCHEMAS: Record<ApprovalStep, z.ZodType<{ taskId: string }>> = {
  commit: commitPayloadSchema,
  merge_local: mergeLocalPayloadSchema,
  push_pr: pushPrPayloadSchema,
  merge_pr: mergePrPayloadSchema,
};

// ---- results ---------------------------------------------------------------------------------

export type StepResult =
  | { status: "done" | "awaiting_approval" | "completed"; step: EngineeringStep }
  | { status: "needs_attention" | "failed"; step: EngineeringStep; reason: string }
  | { status: "skipped"; step: EngineeringStep; reason: string };

export interface DevelopTarget {
  taskId: string;
  localPath: string;
  testCommand: string;
  approvedDescription: string;
  plan: InvestigationOutput;
}

export interface DevelopRunner {
  /** Runs the develop request (the worker owns the orchestrator call). May throw a JobError. */
  run(target: DevelopTarget): Promise<AIExecutionResult>;
  /** The claude_runs id of the run, once it exists. */
  runId(): string | null;
}

export interface EngineeringStepDeps {
  db: Db;
  clock: Clock;
  events: Pick<EventPublisher, "publish">;
  audit: Pick<AuditLogger, "record">;
  queue: Pick<JobQueue, "enqueue">;
  approvals: Pick<
    ApprovalEngine,
    "request" | "revokeAsSystem" | "expireAsSystem" | "updatePendingPayload"
  >;
  lock: Pick<EngineeringLock, "holder" | "release">;
  git: GitWorkflow;
  prs: PullRequestProvider;
  settings: Pick<SettingsService, "get">;
  /** The `sandbox` health check: retry refuses while it is not ok. */
  sandboxHealth: HealthCheck;
  /** True when a develop run's sandbox tmpDir would exceed the 64-byte cap (H3.3). */
  sandboxPathTooLong: () => boolean;
}

/** The develop step's pre-run fingerprints plus the placeholder count (ADR-040, Task 4b). */
interface DevelopFingerprints {
  gitDirBaseline: string;
  configFingerprint: string;
  sandboxPlaceholdersRemoved: number;
}

interface Ctx {
  task: TaskRow;
  path: string;
  parent: string;
  taskBranch: string;
  repo: typeof repositories.$inferSelect;
}

/** A develop run's outcome: its result, or what it threw. */
type RunOutcome = { ok: true; result: AIExecutionResult } | { ok: false; error: unknown };

async function attemptRun(run: () => Promise<AIExecutionResult>): Promise<RunOutcome> {
  try {
    return { ok: true, result: await run() };
  } catch (error) {
    return { ok: false, error };
  }
}

/** `max_turns` or `timeout` when the run stopped on its budget; null for any other failure. */
function stopKind(err: unknown): "max_turns" | "timeout" | null {
  if (!(err instanceof JobError)) return null;
  if (err.classified.details?.maxTurns === true) return "max_turns";
  return err.classified.kind === "timeout" ? "timeout" : null;
}

/** The run's sandbox failed at startup (Task 2 sets `details.sandboxUnavailable` on the JobError). */
function sandboxUnavailable(err: unknown): boolean {
  return err instanceof JobError && err.classified.details?.sandboxUnavailable === true;
}

/**
 * The engineering step runner (E8–E18, ADR-030, ADR-013). Every Git operation is Synapse code
 * through the `GitWorkflow` port; the model only edits files and runs the tests (the develop run,
 * driven by the step worker). Each write step waits for its own approval, and each approval's
 * executor revalidates first: the task is still at that step, the lock holder is this task, the
 * parent is not protected, and the config fingerprint (plus, for the commit, the diff hash and the
 * git-dir baseline) still equals what the approval shows. Any failure has a fixed reason code;
 * conflicts are aborted and leave the task `needs_attention` with the lock kept. Rejecting a step
 * cancels the task, and cleanup releases the lock.
 *
 * Diff text, file paths, test output, branch names and PR text never reach audit rows, events,
 * logs or thrown messages: diff and test tail live in step outputs; paths, commits and PR text in
 * the approval payloads the user reviews.
 */
/** Develop-retry reasons where the refusal came before any model run (no edits possible). */
const PRE_RUN_RETRY_REASONS: readonly string[] = [
  "sandbox_disabled",
  "sandbox_path_too_long",
  "sandbox_root_masked",
];

export class EngineeringStepService {
  private readonly store: EngineeringTaskStore;
  /** Tasks with a step or executor running in this process; cleanup waits for them. */
  readonly #inFlight = new Set<string>();
  /** Cleanups deferred until the in-flight operation of that task finishes. */
  readonly #cleanupWanted = new Set<string>();

  constructor(private readonly deps: EngineeringStepDeps) {
    this.store = new EngineeringTaskStore(deps);
  }

  /** Wires the four approval executors and the reject/revoke/expire consumers. */
  register(engine: ApprovalEngine, dispatcher: Pick<OutboxDispatcher, "subscribe">): void {
    for (const [action, step] of Object.entries(ACTION_STEP)) {
      registerIntegrationExecutor(engine, action as Operation, ENGINEERING_INTEGRATION, {
        execute: async (a) => this.execute(a, step),
        revalidate: async (a) => this.revalidate(a, step),
      });
    }
    for (const type of ["approval.rejected", "approval.revoked", "approval.expired"] as const) {
      dispatcher.subscribe(type, DECISIONS_CONSUMER, (event, tx) => {
        const approvalId = (event.payload as { approvalId?: unknown }).approvalId;
        if (typeof approvalId !== "string") return;
        try {
          // Savepoint: a failure rolls back this decision only.
          tx.transaction((sp) => this.onDecision(sp, approvalId, type));
        } catch (e) {
          console.error(
            `engineering decision failed approval=${approvalId} error=${e instanceof Error ? e.name : "unknown"}`,
          );
        }
      });
    }
  }

  // ---- F2.1: edit the text of a pending commit or push approval --------------------------------

  /**
   * The user's edit of the commit message or PR title/body. Allowed only on a `pending` approval
   * of the task's current step; the text is stored in the payload and used verbatim by the
   * executors (argv only). Revalidation is untouched. The audit row holds field names only.
   */
  editApprovalText(taskId: string, approvalId: string, edit: ApprovalTextEdit): Approval {
    return this.deps.db.transaction(
      (tx) => {
        const row = tx.select().from(approvalsTable).where(eq(approvalsTable.id, approvalId)).get();
        const task = this.store.get(tx, taskId);
        if (
          !task ||
          !row ||
          row.targetRef !== taskId ||
          row.targetIntegration !== ENGINEERING_INTEGRATION
        ) {
          throw new EngineeringTaskError("not_found");
        }
        const step = ACTION_STEP[row.action];
        const allowed: Partial<Record<ApprovalStep, ApprovalTextField[]>> = {
          commit: ["commitMessage"],
          push_pr: ["prTitle", "prBody"],
        };
        const fields = (Object.keys(edit) as ApprovalTextField[]).filter(
          (f) => edit[f] !== undefined,
        );
        const stepFields = step ? allowed[step] : undefined;
        if (
          !step ||
          !stepFields ||
          fields.length === 0 ||
          fields.some((f) => !stepFields.includes(f))
        ) {
          throw new EngineeringTaskError("invalid_input");
        }
        if (
          row.status !== "pending" ||
          task.status !== "awaiting_approval" ||
          task.currentStep !== step ||
          this.stepRow(tx, taskId, step)?.approvalId !== approvalId
        ) {
          throw new EngineeringTaskError("not_pending");
        }
        const merged: Record<string, unknown> = {
          ...((row.payload as Record<string, unknown> | null) ?? {}),
        };
        for (const f of fields) {
          const value = edit[f] as string;
          if (!isValidApprovalText(f, value)) throw new EngineeringTaskError("invalid_text");
          merged[f === "commitMessage" ? "message" : f] = value;
        }
        if (!PAYLOAD_SCHEMAS[step].safeParse(merged).success) {
          throw new EngineeringTaskError("invalid_text");
        }
        const updated = this.deps.approvals.updatePendingPayload(tx, approvalId, merged);
        if (!updated) throw new EngineeringTaskError("not_pending");
        this.deps.audit.record(tx, {
          actor: "user",
          module: MODULE,
          action: "engineering.approval_edited",
          workerProfile: WORKER,
          targetRef: taskId,
          approvalId,
          result: "ok",
          details: { taskId, fields },
        });
        return updated;
      },
      { behavior: "immediate" },
    );
  }

  // ---- F3.2: re-request merge_pr after failing checks ---------------------------------------------

  /**
   * "Check again": a task parked at `merge_pr` with `checks_failing` re-reads the PR. Passing (or
   * pending but mergeable) checks on the unmoved head request a fresh `engineering.merge_pr`
   * approval; anything else is a fixed refusal and the task stays as it was.
   */
  async retryMerge(taskId: string): Promise<void> {
    const ctx = this.context(taskId);
    if ("skip" in ctx) {
      throw new EngineeringTaskError(
        ctx.skip === "not_found" || ctx.skip === "path_unavailable" ? ctx.skip : "invalid_state",
      );
    }
    const { task, repo, parent } = ctx;
    const eligible = (t: TaskRow | undefined) =>
      t?.status === "needs_attention" &&
      t.failure === "checks_failing" &&
      t.currentStep === "merge_pr";
    const upstream = this.deps.prs.repoRef(repo.upstreamUrl ?? "");
    const pushedSha = this.stepOutput(taskId, "push_pr")?.pushedSha;
    if (
      !eligible(task) ||
      this.deps.lock.holder()?.taskId !== taskId ||
      !upstream ||
      task.prNumber === null ||
      typeof pushedSha !== "string"
    ) {
      throw new EngineeringTaskError("invalid_state");
    }
    if (this.protectedBranches(task.repositoryId).includes(parent)) {
      throw new EngineeringTaskError("protected_branch");
    }
    const prNumber = task.prNumber;
    let status: PrStatus;
    try {
      status = await this.deps.prs.prStatus({ upstream, number: prNumber });
    } catch {
      throw new EngineeringTaskError("pr_status_failed");
    }
    if (status.state !== "OPEN") throw new EngineeringTaskError("state_changed");
    if (status.headSha !== pushedSha) throw new EngineeringTaskError("pr_head_moved");
    if (
      status.checks === "failing" ||
      (status.checks === "pending" && status.mergeable !== "MERGEABLE")
    ) {
      throw new EngineeringTaskError("checks_failing");
    }
    const checkedAt = this.deps.clock.now().toISOString();
    this.deps.db.transaction(
      (tx) => {
        const fresh = this.store.get(tx, taskId);
        if (!fresh || !eligible(fresh) || fresh.prNumber !== prNumber) {
          throw new EngineeringTaskError("invalid_state");
        }
        this.requestStep(
          tx,
          taskId,
          "merge_pr",
          "engineering.merge_pr",
          "high",
          {
            taskId,
            parentBranch: parent,
            prNumber,
            prUrl: fresh.prUrl ?? task.prUrl ?? "",
            status: { ...status, checkedAt },
            pushedSha,
            ...this.deployNotice(fresh),
          },
          { prNumber },
        );
        this.audit(tx, "engineering.merge_rerequested", taskId, "ok", { prNumber });
      },
      { behavior: "immediate" },
    );
  }

  // ---- H3: retry the develop step after a sandbox refusal -----------------------------------------

  /**
   * "Try again": a task parked at `develop` for a sandbox reason (`DEVELOP_RETRY_REASONS`) that
   * still holds the lock goes back to `in_progress` with a fresh `engineering.step` develop job,
   * once the sandbox setting is on and the `sandbox` health check passes.
   */
  async retryDevelop(taskId: string): Promise<void> {
    const eligible = (t: TaskRow | null | undefined): boolean =>
      t != null &&
      t.status === "needs_attention" &&
      t.currentStep === "develop" &&
      (DEVELOP_RETRY_REASONS as readonly string[]).includes(t.failure ?? "") &&
      this.deps.lock.holder()?.taskId === taskId;
    const task = this.store.get(this.deps.db, taskId);
    if (!task) throw new EngineeringTaskError("not_found");
    if (!eligible(task)) throw new EngineeringTaskError("not_retryable");
    if (!this.deps.settings.get("engineering.sandbox.enabled")) {
      throw new EngineeringTaskError("sandbox_disabled");
    }
    const health = await this.deps.sandboxHealth();
    if (health.status !== "ok") {
      throw new EngineeringTaskError(
        health.detail === "run_root_masked" ? "sandbox_root_masked" : "sandbox_unavailable",
      );
    }
    if (task.failure === "sandbox_path_too_long" && this.deps.sandboxPathTooLong()) {
      throw new EngineeringTaskError("sandbox_path_too_long");
    }
    // The failed run's pre-run fingerprints are discarded below, so compare them now, before any
    // git command that could run a filter or hook (ADR-040).
    const ctx = this.context(taskId);
    if ("skip" in ctx) {
      throw new EngineeringTaskError(
        ctx.skip === "path_unavailable" ? "path_unavailable" : "not_retryable",
      );
    }
    const prior = this.stepOutput(taskId, "develop");
    // The pre-run refusals stopped before any model ran, so no run could have edited git
    // settings and the stored fingerprints say nothing about this retry; a fetch or a config
    // tweak the user made meanwhile must not block it. `sandbox_unavailable` can follow a
    // mid-run failure, so its fingerprints are compared and must exist (fail closed).
    const preRun = PRE_RUN_RETRY_REASONS.includes(task.failure ?? "");
    let baseline: string | undefined;
    if (!preRun) {
      const storedBase = prior?.gitDirBaseline;
      const storedConfig = prior?.configFingerprint;
      if (typeof storedBase !== "string" || typeof storedConfig !== "string") {
        throw new EngineeringTaskError("unsafe_change");
      }
      baseline = storedBase;
      let gitDirNow: string;
      let configNow: string;
      try {
        gitDirNow = await this.deps.git.gitDirFingerprint(ctx.path);
        configNow = await this.deps.git.configFingerprint(ctx.path);
      } catch {
        throw new EngineeringTaskError("git_failed");
      }
      if (gitDirNow !== storedBase || configNow !== storedConfig) {
        throw new EngineeringTaskError("unsafe_change");
      }
    }
    try {
      const diff = await this.deps.git.diffSummary(
        ctx.path,
        baseline === undefined ? undefined : { gitDirBaseline: baseline },
      );
      if (diff.unsafe || diff.files.length > 0) throw new EngineeringTaskError("changes_left");
    } catch (e) {
      throw e instanceof EngineeringTaskError ? e : new EngineeringTaskError("git_failed");
    }
    this.deps.db.transaction(
      (tx) => {
        if (!eligible(this.store.get(tx, taskId))) throw new EngineeringTaskError("not_retryable");
        this.store.transition(tx, taskId, "in_progress", { failure: null }, ["needs_attention"]);
        this.store.upsertStep(tx, taskId, "develop", "pending", {
          output: null,
          claudeRunId: null,
        });
        this.enqueue(tx, taskId, "develop");
        this.audit(tx, "engineering.develop_retried", taskId, "ok", {});
      },
      { behavior: "immediate" },
    );
  }

  // ---- E8: branch -----------------------------------------------------------------------------

  async runBranch(taskId: string): Promise<StepResult> {
    return this.track(taskId, async () => {
      const ctx = this.active(taskId, "branch");
      if ("skip" in ctx) return { status: "skipped", step: "branch", reason: ctx.skip };
      const { path, parent, taskBranch } = ctx;
      let returnTo: string | null = null;
      try {
        returnTo = await this.deps.git.currentBranch(path);
      } catch {
        returnTo = null;
      }
      this.mark(taskId, "branch", "running");
      let baseSha: string;
      try {
        ({ baseSha } = await this.deps.git.createTaskBranch(path, parent, taskBranch));
      } catch (e) {
        return this.attention(taskId, "branch", codeOf(e));
      }
      return this.settle(taskId, "branch", { baseSha, returnTo }, (tx) => {
        this.store.update(tx, taskId, { baseSha, currentStep: "develop" });
        this.store.upsertStep(tx, taskId, "branch", "done", { output: { baseSha, returnTo } });
        this.store.upsertStep(tx, taskId, "develop", "pending", { output: null });
        this.enqueue(tx, taskId, "develop");
        this.audit(tx, "engineering.branch_created", taskId, "ok", {});
        return { status: "done", step: "branch" };
      });
    });
  }

  // ---- E9: develop ----------------------------------------------------------------------------

  /**
   * The develop step: checks the task and a clean tree on the task branch, takes the git-dir and
   * config fingerprints immediately before the run, runs it once, then computes the diff against
   * the baseline. Unsafe → `needs_attention` (`unsafe_change`), no approval. Empty → `failed`
   * (`no_changes`) and cleanup. Otherwise the `engineering.commit` approval is requested, with the
   * test result taken from the last test-command Bash tool_result only (ADR-026).
   */
  async runDevelop(taskId: string, runner: DevelopRunner): Promise<StepResult> {
    return this.track(taskId, async () => {
      const ctx = this.active(taskId, "develop");
      if ("skip" in ctx) return { status: "skipped", step: "develop", reason: ctx.skip };
      const { task, path, repo, taskBranch } = ctx;
      const testCommand = repo.testCommand ?? "";
      if (!isSafeTestCommand(testCommand)) {
        return this.attention(taskId, "develop", "unsafe_test_command");
      }
      if (!task.approvedDescription || !task.plan) {
        return this.attention(taskId, "develop", "invalid_state");
      }
      const approvedDescription: string = task.approvedDescription;
      let gitDirBaseline: string;
      let configFingerprint: string;
      let placeholdersBefore: string[];
      try {
        if ((await this.deps.git.currentBranch(path)) !== taskBranch) {
          return this.attention(taskId, "develop", "branch_changed");
        }
        const before = await this.deps.git.diffSummary(path);
        if (before.files.length > 0 || before.unsafe) {
          return this.attention(taskId, "develop", "dirty_tree");
        }
        gitDirBaseline = await this.deps.git.gitDirFingerprint(path);
        configFingerprint = await this.deps.git.configFingerprint(path);
        placeholdersBefore = await this.deps.git.sandboxPlaceholders(path);
      } catch (e) {
        return this.attention(taskId, "develop", codeOf(e));
      }
      const fingerprints = { gitDirBaseline, configFingerprint };
      this.mark(taskId, "develop", "running", { output: fingerprints, claudeRunId: null });

      const outcome = await attemptRun(() =>
        runner.run({
          taskId,
          localPath: path,
          testCommand,
          approvedDescription,
          plan: task.plan as InvestigationOutput,
        }),
      );
      // ADR-040, Task 4b: before any fingerprint, diff or unsafe check, after every outcome.
      const fp = {
        ...fingerprints,
        sandboxPlaceholdersRemoved: await this.removeSandboxPlaceholders(path, placeholdersBefore),
      };
      if (!outcome.ok) {
        const err = outcome.error;
        // Quota or auth pause: the queue runs the job again later; the step waits again.
        if (err instanceof JobError && retryDecision(err.classified.kind) === "defer") {
          this.mark(taskId, "develop", "pending", { claudeRunId: runner.runId() });
          throw err;
        }
        // The sandbox cannot start: always needs the user (F1.4), never a clean-tree failure.
        if (sandboxUnavailable(err)) {
          return this.attention(
            taskId,
            "develop",
            "sandbox_unavailable",
            { ...fp, failure: "sandbox_unavailable" },
            runner.runId(),
          );
        }
        // Rule M refused the run: the sandbox setting is off (F1.5).
        const sandboxOff =
          err instanceof JobError &&
          err.classified.kind === "invalid_input" &&
          err.classified.message === SANDBOX_REQUIRED_REASON;
        // The worker refuses a repository the sandbox would mask before any run (ADR-040).
        const masked =
          err instanceof JobError &&
          err.classified.kind === "invalid_input" &&
          err.classified.message === REPO_IN_MASKED_PATH;
        // The run's tmpDir would overflow the sandbox's unix socket paths (ADR-040, fix round 2).
        const tooLong =
          err instanceof JobError &&
          err.classified.kind === "invalid_input" &&
          err.classified.message === SANDBOX_PATH_TOO_LONG;
        // The run root is inside a masked path (H4.6).
        const rootMasked =
          err instanceof JobError &&
          err.classified.kind === "invalid_input" &&
          err.classified.message === SANDBOX_ROOT_MASKED;
        // Sandbox refusals are environment problems the user fixes, then retries: the task and
        // the lock stay (needs_attention), like sandbox_unavailable.
        if (sandboxOff) {
          return this.attention(
            taskId,
            "develop",
            "sandbox_disabled",
            { ...fp, failure: "sandbox_disabled" },
            runner.runId(),
          );
        }
        if (tooLong) {
          return this.attention(
            taskId,
            "develop",
            SANDBOX_PATH_TOO_LONG,
            { ...fp, failure: SANDBOX_PATH_TOO_LONG, hint: SANDBOX_PATH_TOO_LONG_HINT },
            runner.runId(),
          );
        }
        if (rootMasked) {
          return this.attention(
            taskId,
            "develop",
            SANDBOX_ROOT_MASKED,
            { ...fp, failure: SANDBOX_ROOT_MASKED, hint: SANDBOX_ROOT_MASKED_HINT },
            runner.runId(),
          );
        }
        const kind = masked
          ? REPO_IN_MASKED_PATH
          : (stopKind(err) ?? (err instanceof JobError ? err.classified.kind : "unknown"));
        return this.developFailed(ctx, kind, fp, runner.runId());
      }
      return this.developDone(ctx, outcome.result, testCommand, fp, runner.runId());
    });
  }

  /**
   * ADR-040, Task 4b: the sandbox leaves empty mount placeholders in .git and the repository top.
   * Removes the ones the run created (absent from `before`) while they are empty; anything
   * non-empty stays and the fingerprint flags it as before. Every develop run that started was
   * sandboxed (rule M), and a refused run created nothing. A failure counts as 0 removed.
   */
  private async removeSandboxPlaceholders(path: string, before: string[]): Promise<number> {
    try {
      return await this.deps.git.removeSandboxPlaceholders(path, before);
    } catch {
      return 0;
    }
  }

  private async developDone(
    ctx: Ctx,
    result: AIExecutionResult,
    testCommand: string,
    fp: DevelopFingerprints,
    claudeRunId: string | null,
  ): Promise<StepResult> {
    const { task, path } = ctx;
    const taskId = task.id;
    // ADR-040, fix round 2: the sandbox can fail inside the run, after startup; the CLI then
    // reports it in the Bash tool_result. That is sandbox_unavailable (needs the user), never a
    // failed test run.
    if (
      result.toolResults.some(
        (r) => r.toolName === "Bash" && SANDBOX_TOOL_RESULT_RE.test(r.content),
      )
    ) {
      return this.attention(
        taskId,
        "develop",
        "sandbox_unavailable",
        { ...fp, failure: "sandbox_unavailable" },
        claudeRunId,
      );
    }
    let diff: Awaited<ReturnType<GitWorkflow["diffSummary"]>>;
    try {
      diff = await this.deps.git.diffSummary(path, { gitDirBaseline: fp.gitDirBaseline });
    } catch (e) {
      return this.attention(taskId, "develop", codeOf(e), { ...fp }, claudeRunId);
    }
    const tests = testResultFrom(result.toolResults, testCommand);
    const reply = parseDevelopReply(result.finalText);
    const output = {
      ...fp,
      diffHash: diff.unsafe ? null : diff.hash,
      files: diff.files,
      unsafeReasons: diff.unsafeReasons,
      diffText: diff.diffText,
      truncated: diff.truncated,
      testsPassed: tests.testsPassed,
      testOutputTail: tests.testOutputTail,
      testRun: tests.testRun,
      modelSummary: reply?.summary ?? null,
      modelNotes: reply?.notes ?? null,
      // Tool names only: a denial means the run tried to step outside its scope.
      permissionDenials: [...new Set(result.permissionDenials)].sort(),
    };
    if (diff.unsafe) {
      return this.attention(taskId, "develop", "unsafe_change", output, claudeRunId);
    }
    if (diff.files.length === 0) {
      return this.terminalFailure(taskId, "develop", "no_changes", output, claudeRunId);
    }
    let configNow: string;
    try {
      // Recomputed right before the approval request; the executor checks it again.
      configNow = await this.deps.git.configFingerprint(path);
    } catch (e) {
      return this.attention(taskId, "develop", codeOf(e), output, claudeRunId);
    }
    const payload: CommitPayload = {
      taskId,
      diffHash: diff.hash,
      gitDirBaseline: fp.gitDirBaseline,
      configFingerprint: configNow,
      files: diff.files.slice(0, PAYLOAD_FILES_MAX),
      filesTotal: diff.files.length,
      testsPassed: tests.testsPassed,
      testRun: tests.testRun,
      message: commitMessage(task),
    };
    return this.settle(taskId, "develop", output, (tx) => {
      this.store.upsertStep(tx, taskId, "develop", "done", { output, claudeRunId });
      this.requestStep(tx, taskId, "commit", "engineering.commit", "medium", payload, {
        diffHash: diff.hash,
        gitDirBaseline: fp.gitDirBaseline,
        configFingerprint: configNow,
      });
      this.audit(tx, "engineering.developed", taskId, "ok", {
        files: diff.files.length,
        testsPassed: tests.testsPassed,
        testRun: tests.testRun,
        permissionDenials: output.permissionDenials,
      });
      return { status: "awaiting_approval", step: "commit" };
    });
  }

  /** A run failure: with a clean tree the task fails (and is cleaned up); else needs attention. */
  private async developFailed(
    ctx: Ctx,
    code: string,
    fp: DevelopFingerprints,
    claudeRunId: string | null,
    extra: Record<string, unknown> = {},
  ): Promise<StepResult> {
    let clean = false;
    try {
      const d = await this.deps.git.diffSummary(ctx.path, { gitDirBaseline: fp.gitDirBaseline });
      clean = !d.unsafe && d.files.length === 0;
    } catch {
      clean = false;
    }
    const output = { ...fp, failure: code, ...extra };
    if (clean) return this.terminalFailure(ctx.task.id, "develop", code, output, claudeRunId);
    return this.attention(ctx.task.id, "develop", code, output, claudeRunId);
  }

  // ---- E10: commit, E11: update_parent ----------------------------------------------------------

  private async executeCommit(ctx: Ctx, p: CommitPayload): Promise<unknown> {
    const { task, path } = ctx;
    let sha: string;
    try {
      ({ sha } = await this.deps.git.commitAll(path, p.message, p.diffHash, {
        gitDirBaseline: p.gitDirBaseline,
        expectedConfigFingerprint: p.configFingerprint,
      }));
    } catch (e) {
      this.attention(task.id, "commit", codeOf(e));
      throw new ExecutorError(codeOf(e));
    }
    const out = {
      sha,
      diffHash: p.diffHash,
      gitDirBaseline: p.gitDirBaseline,
      configFingerprint: p.configFingerprint,
    };
    await this.settle(task.id, "commit", out, (tx) => {
      this.store.upsertStep(tx, task.id, "commit", "done", { output: out });
      this.store.update(tx, task.id, { currentStep: "update_parent" });
      this.store.upsertStep(tx, task.id, "update_parent", "pending", { output: null });
      // E11 runs as its own step job: it fetches twice and must not stretch this execution.
      this.enqueue(tx, task.id, "update_parent");
      this.audit(tx, "engineering.committed", task.id, "ok", {});
      return { status: "done", step: "commit" };
    });
    return { sha };
  }

  async runUpdateParent(taskId: string): Promise<StepResult> {
    return this.track(taskId, async () => {
      const ctx = this.active(taskId, "update_parent");
      if ("skip" in ctx) return { status: "skipped", step: "update_parent", reason: ctx.skip };
      const { path, parent, taskBranch } = ctx;
      const commitOut = this.stepOutput(taskId, "commit");
      const expected = commitOut?.configFingerprint;
      const commitSha = commitOut?.sha;
      if (typeof expected !== "string" || typeof commitSha !== "string") {
        return this.attention(taskId, "update_parent", "invalid_state");
      }
      this.mark(taskId, "update_parent", "running");
      let configNow: string;
      try {
        const r = await this.deps.git.updateParent(path, parent, {
          expectedConfigFingerprint: expected,
        });
        if (!r.ok) return this.attention(taskId, "update_parent", "parent_conflict");
        configNow = await this.deps.git.configFingerprint(path);
      } catch (e) {
        return this.attention(taskId, "update_parent", codeOf(e));
      }
      return this.settle(taskId, "update_parent", {}, (tx) => {
        this.store.upsertStep(tx, taskId, "update_parent", "done", { output: {} });
        this.requestStep(
          tx,
          taskId,
          "merge_local",
          "engineering.merge_local",
          "medium",
          { taskId, parentBranch: parent, taskBranch, commitSha, configFingerprint: configNow },
          { configFingerprint: configNow },
        );
        this.audit(tx, "engineering.parent_updated", taskId, "ok", {});
        return { status: "awaiting_approval", step: "merge_local" };
      });
    });
  }

  // ---- E12: merge_local -----------------------------------------------------------------------

  private async executeMergeLocal(
    ctx: Ctx,
    p: z.infer<typeof mergeLocalPayloadSchema>,
  ): Promise<unknown> {
    const { task, path, parent, taskBranch } = ctx;
    if (this.protectedBranches(task.repositoryId).includes(parent)) {
      this.attention(task.id, "merge_local", "protected_branch");
      throw new ExecutorError("protected_branch");
    }
    let merged: Awaited<ReturnType<GitWorkflow["mergeLocal"]>>;
    try {
      merged = await this.deps.git.mergeLocal(path, parent, taskBranch, {
        expectedConfigFingerprint: p.configFingerprint,
        commit: p.commitSha,
      });
    } catch (e) {
      this.attention(task.id, "merge_local", codeOf(e));
      throw new ExecutorError(codeOf(e));
    }
    if (!merged.ok) {
      this.attention(task.id, "merge_local", "merge_conflict");
      throw new ExecutorError("merge_conflict");
    }
    const sha = merged.sha;
    let commits: { sha: string; subject: string }[];
    let configNow: string;
    try {
      commits = await this.deps.git.commitsAhead(path, parent);
      configNow = await this.deps.git.configFingerprint(path);
    } catch (e) {
      this.attention(task.id, "merge_local", codeOf(e), { sha });
      throw new ExecutorError(codeOf(e));
    }
    const deploy = this.deployNotice(task);
    const payload: z.infer<typeof pushPrPayloadSchema> = {
      taskId: task.id,
      parentBranch: parent,
      commits: commits.slice(0, PAYLOAD_COMMITS_MAX),
      commitsTotal: commits.length,
      mergeSha: sha,
      prTitle: clipUnits(task.title, PR_TITLE_MAX),
      prBody: prBody(task, developTestResult(this.stepOutput(task.id, "develop"))),
      configFingerprint: configNow,
      ...deploy,
    };
    await this.settle(task.id, "merge_local", { sha }, (tx) => {
      this.store.update(tx, task.id, { mergeSha: sha });
      this.store.upsertStep(tx, task.id, "merge_local", "done", {
        output: { sha, configFingerprint: p.configFingerprint },
      });
      this.requestStep(
        tx,
        task.id,
        "push_pr",
        "engineering.push_pr",
        deploy.autoDeploys ? "high" : "medium",
        payload,
        { configFingerprint: configNow, commits: commits.length },
      );
      this.audit(tx, "engineering.merged_local", task.id, "ok", { commits: commits.length });
      return { status: "awaiting_approval", step: "push_pr" };
    });
    return { sha };
  }

  // ---- E13: push_pr ---------------------------------------------------------------------------

  private async executePushPr(ctx: Ctx, p: z.infer<typeof pushPrPayloadSchema>): Promise<unknown> {
    const { task, path, parent, repo } = ctx;
    const upstream = this.deps.prs.repoRef(repo.upstreamUrl ?? "");
    const fork = this.deps.prs.repoRef(repo.originUrl ?? "");
    // Checked before the push: never push what cannot become a PR.
    if (!upstream || !fork) {
      this.attention(task.id, "push_pr", "unsupported_remote");
      throw new ExecutorError("unsupported_remote");
    }
    try {
      await this.deps.git.pushParent(path, parent, {
        protectedBranches: this.protectedBranches(task.repositoryId),
        upstreamUrl: repo.upstreamUrl,
        // M10: the push goes only to the origin the user registered (normalised, owner/repo).
        expectedOriginUrl: repo.originUrl,
        expectedConfigFingerprint: p.configFingerprint,
        expectedSha: p.mergeSha,
      });
    } catch (e) {
      this.attention(task.id, "push_pr", codeOf(e));
      throw new ExecutorError(codeOf(e));
    }
    const pushedSha = p.mergeSha;
    const pushed = { pushed: true, pushedSha, configFingerprint: p.configFingerprint };
    // Cancelled while the push ran: the push stays (it cannot be undone), no PR is created.
    const cancelled = this.deps.db.transaction(
      (tx) => {
        const t = this.store.get(tx, task.id);
        if (t && TERMINAL_STATUSES.includes(t.status)) {
          this.store.upsertStep(tx, task.id, "push_pr", "done", {
            output: { ...pushed, outcome: "pushed_not_pr" },
          });
          this.audit(tx, "engineering.pushed_not_pr", task.id, "cancelled", {});
          return true;
        }
        this.store.upsertStep(tx, task.id, "push_pr", "running", { output: pushed });
        return false;
      },
      { behavior: "immediate" },
    );
    if (cancelled) {
      this.#cleanupWanted.add(task.id);
      return { pushed: true, pr: false };
    }
    let pr: { url: string; number: number };
    try {
      pr = await this.deps.prs.createPr({
        upstream,
        headOwner: fork.owner,
        branch: parent,
        title: p.prTitle,
        body: p.prBody,
      });
    } catch (e) {
      this.attention(task.id, "push_pr", codeOf(e), pushed);
      throw new ExecutorError(codeOf(e));
    }
    // M5: the PR exists now, whatever happens next (a cancel meanwhile included): record it.
    this.deps.db.transaction(
      (tx) => {
        this.store.update(tx, task.id, { prUrl: pr.url, prNumber: pr.number });
        this.store.upsertStep(tx, task.id, "push_pr", "running", {
          output: { ...pushed, prUrl: pr.url, prNumber: pr.number },
        });
      },
      { behavior: "immediate" },
    );
    let status: (PrStatus & { checkedAt: string }) | null = null;
    try {
      status = {
        ...(await this.deps.prs.prStatus({ upstream, number: pr.number })),
        checkedAt: this.deps.clock.now().toISOString(),
      };
    } catch {
      status = null; // shown as unknown; merge_pr is high risk and re-checked at revalidation
    }
    const deploy = this.deployNotice(task);
    // The fingerprint stays on the output: cleanup compares against the latest one checked.
    const out = { ...pushed, prUrl: pr.url, prNumber: pr.number };
    await this.settle(task.id, "push_pr", out, (tx) => {
      this.store.update(tx, task.id, { prUrl: pr.url, prNumber: pr.number });
      this.store.upsertStep(tx, task.id, "push_pr", "done", { output: out });
      this.requestStep(
        tx,
        task.id,
        "merge_pr",
        "engineering.merge_pr",
        // E14: always high, whatever the deploy notice says.
        "high",
        {
          taskId: task.id,
          parentBranch: parent,
          prNumber: pr.number,
          prUrl: pr.url,
          status,
          pushedSha,
          ...deploy,
        },
        { prNumber: pr.number },
      );
      this.audit(tx, "engineering.pushed", task.id, "ok", { prNumber: pr.number });
      return { status: "awaiting_approval", step: "merge_pr" };
    });
    return { prNumber: pr.number };
  }

  // ---- E14: merge_pr --------------------------------------------------------------------------

  private async executeMergePr(
    ctx: Ctx,
    p: z.infer<typeof mergePrPayloadSchema>,
  ): Promise<unknown> {
    const { task, repo, parent } = ctx;
    if (this.protectedBranches(task.repositoryId).includes(parent)) {
      this.attention(task.id, "merge_pr", "protected_branch");
      throw new ExecutorError("protected_branch");
    }
    const upstream = this.deps.prs.repoRef(repo.upstreamUrl ?? "");
    if (!upstream) {
      this.attention(task.id, "merge_pr", "unsupported_remote");
      throw new ExecutorError("unsupported_remote");
    }
    const pushedSha = this.stepOutput(task.id, "push_pr")?.pushedSha;
    if (typeof pushedSha !== "string" || pushedSha !== p.pushedSha) {
      this.attention(task.id, "merge_pr", "state_changed");
      throw new ExecutorError("state_changed");
    }
    let merged: { merged: boolean; sha?: string };
    try {
      merged = await this.deps.prs.mergePr({ upstream, number: p.prNumber, headSha: pushedSha });
    } catch (e) {
      this.attention(task.id, "merge_pr", codeOf(e));
      throw new ExecutorError(codeOf(e));
    }
    const out = { merged: merged.merged, ...(merged.sha ? { sha: merged.sha } : {}) };
    if (merged.merged && this.mergedAfterCancel(task.id, out, merged.sha ?? null, pushedSha)) {
      this.#cleanupWanted.add(task.id);
      return { merged: true };
    }
    const settled = await this.settle(task.id, "merge_pr", out, (tx) => {
      this.store.upsertStep(tx, task.id, "merge_pr", "done", { output: out });
      this.store.transition(tx, task.id, "completed", { currentStep: "cleanup", failure: null });
      this.audit(tx, "engineering.completed", task.id, "ok", { prNumber: p.prNumber });
      return { status: "completed", step: "merge_pr" };
    });
    if (settled.status === "completed") this.#cleanupWanted.add(task.id);
    return { merged: merged.merged };
  }

  /**
   * M5: the PR merged although the task was cancelled while gh ran. The merge is the truth: the
   * task becomes `completed` with `merged_after_cancel` in `failure` and on the step output, plus
   * the merge commit when gh reported one (`mergeSha`). gh does not always return it: then
   * `mergeSha` stays null and the PR head that merged is recorded as `prHeadSha`, never passed
   * off as the merge commit. False when the task was not cancelled.
   */
  private mergedAfterCancel(
    taskId: string,
    out: Record<string, unknown>,
    mergeSha: string | null,
    prHeadSha: string,
  ): boolean {
    return this.deps.db.transaction(
      (tx) => {
        if (this.store.get(tx, taskId)?.status !== "cancelled") return false;
        this.store.upsertStep(tx, taskId, "merge_pr", "done", {
          output: {
            ...out,
            outcome: "merged_after_cancel",
            mergeSha,
            ...(mergeSha === null ? { prHeadSha } : {}),
          },
        });
        this.store.transition(
          tx,
          taskId,
          "completed",
          { currentStep: "cleanup", failure: "merged_after_cancel" },
          ["cancelled"],
        );
        this.audit(tx, "engineering.completed", taskId, "ok", { outcome: "merged_after_cancel" });
        return true;
      },
      { behavior: "immediate" },
    );
  }

  // ---- executors and revalidation (E18) -------------------------------------------------------

  private async execute(a: Approval, step: ApprovalStep): Promise<unknown> {
    const parsed = PAYLOAD_SCHEMAS[step].safeParse(a.payload);
    if (!parsed.success) throw new ExecutorError("invalid_payload");
    const taskId = parsed.data.taskId;
    return this.track(taskId, async () => {
      const ctx = this.context(taskId);
      if ("skip" in ctx) {
        // M9: revalidation passed but the repository went away since: never leave the task
        // waiting on an approval that can no longer run.
        this.executeRefused(a, step, taskId, ctx.skip);
        throw new ExecutorError(ctx.skip);
      }
      // Claim the step: awaiting this approval → in_progress. A cancelled task never executes.
      const claimed = this.deps.db.transaction(
        (tx) => {
          const task = this.store.get(tx, taskId);
          const row = this.stepRow(tx, taskId, step);
          if (
            task?.status !== "awaiting_approval" ||
            task.currentStep !== step ||
            row?.approvalId !== a.id
          ) {
            return false;
          }
          this.store.transition(tx, taskId, "in_progress", {}, ["awaiting_approval"]);
          this.store.upsertStep(tx, taskId, step, "running");
          return true;
        },
        { behavior: "immediate" },
      );
      if (!claimed) throw new ExecutorError("state_changed");
      switch (step) {
        case "commit":
          return this.executeCommit(ctx, parsed.data as CommitPayload);
        case "merge_local":
          return this.executeMergeLocal(
            ctx,
            parsed.data as z.infer<typeof mergeLocalPayloadSchema>,
          );
        case "push_pr":
          return this.executePushPr(ctx, parsed.data as z.infer<typeof pushPrPayloadSchema>);
        case "merge_pr":
          return this.executeMergePr(ctx, parsed.data as z.infer<typeof mergePrPayloadSchema>);
      }
    });
  }

  /**
   * M9: the executor found the task unworkable after revalidation passed. Like a failed
   * revalidation: the task (still waiting on this approval) goes to `needs_attention` with the
   * reason. The approval was already claimed, so it cannot be revoked; the engine records it
   * `failed` when the executor throws.
   */
  private executeRefused(a: Approval, step: ApprovalStep, taskId: string, reason: string): void {
    this.deps.db.transaction(
      (tx) => {
        const task = this.store.get(tx, taskId);
        const row = this.stepRow(tx, taskId, step);
        if (
          task?.status !== "awaiting_approval" ||
          task.currentStep !== step ||
          row?.approvalId !== a.id
        ) {
          return;
        }
        try {
          this.deps.approvals.revokeAsSystem(tx, a.id, reason);
        } catch {
          // claimed by execute(): the engine marks it failed
        }
        this.store.transition(tx, taskId, "needs_attention", { failure: reason });
        this.store.upsertStep(tx, taskId, step, "failed", {
          output: { ...((row.output as object | null) ?? {}), failure: reason },
        });
        this.audit(tx, "engineering.step_failed", taskId, "needs_attention", { step, reason });
      },
      { behavior: "immediate" },
    );
  }

  /**
   * E18. False revokes the approval (as system) and moves the task to `needs_attention` with the
   * reason, in one transaction; the engine then skips the execution.
   */
  private async revalidate(a: Approval, step: ApprovalStep): Promise<boolean> {
    let reason: string | null;
    try {
      reason = await this.revalidateReason(a, step);
    } catch {
      reason = "revalidate_failed";
    }
    if (reason === null) return true;
    const taskId = (a.payload as { taskId?: unknown } | null)?.taskId;
    this.deps.db.transaction(
      (tx) => {
        try {
          this.deps.approvals.revokeAsSystem(tx, a.id, reason);
        } catch {
          // already decided or claimed: nothing to revoke
        }
        if (typeof taskId !== "string") return;
        const task = this.store.get(tx, taskId);
        const row = this.stepRow(tx, taskId, step);
        if (!task || !ACTIVE_STATUSES.includes(task.status) || row?.approvalId !== a.id) return;
        this.store.transition(tx, taskId, "needs_attention", { failure: reason });
        this.store.upsertStep(tx, taskId, step, "failed", {
          output: { ...((row.output as object | null) ?? {}), failure: reason },
        });
        this.audit(tx, "engineering.revalidate_failed", taskId, "needs_attention", {
          step,
          reason,
        });
      },
      { behavior: "immediate" },
    );
    return false;
  }

  private async revalidateReason(a: Approval, step: ApprovalStep): Promise<string | null> {
    const parsed = PAYLOAD_SCHEMAS[step].safeParse(a.payload);
    if (!parsed.success) return "invalid_payload";
    const ctx = this.context(parsed.data.taskId);
    if ("skip" in ctx) return ctx.skip;
    const { task, path, parent } = ctx;
    const row = this.stepRow(this.deps.db, task.id, step);
    if (
      task.status !== "awaiting_approval" ||
      task.currentStep !== step ||
      row?.approvalId !== a.id
    ) {
      return "state_changed";
    }
    if (this.deps.lock.holder()?.taskId !== task.id) return "lock_lost";
    if (this.protectedBranches(task.repositoryId).includes(parent)) return "protected_branch";
    const { git } = this.deps;
    switch (step) {
      case "commit": {
        const p = parsed.data as CommitPayload;
        // Config first: a changed config could name a filter that `git status` would run.
        if ((await git.configFingerprint(path)) !== p.configFingerprint) return "config_changed";
        const d = await git.diffSummary(path, { gitDirBaseline: p.gitDirBaseline });
        if (d.unsafe) return "unsafe_change";
        return d.hash === p.diffHash ? null : "diff_changed";
      }
      case "merge_local": {
        const p = parsed.data as z.infer<typeof mergeLocalPayloadSchema>;
        if ((await git.configFingerprint(path)) !== p.configFingerprint) return "config_changed";
        return (await git.branchTip(path, ctx.taskBranch)) === p.commitSha ? null : "branch_moved";
      }
      case "push_pr": {
        const p = parsed.data as z.infer<typeof pushPrPayloadSchema>;
        if ((await git.configFingerprint(path)) !== p.configFingerprint) return "config_changed";
        return (await git.branchTip(path, parent)) === p.mergeSha ? null : "branch_moved";
      }
      case "merge_pr": {
        const p = parsed.data as z.infer<typeof mergePrPayloadSchema>;
        if (task.prNumber !== p.prNumber) return "state_changed";
        if (this.stepOutput(task.id, "push_pr")?.pushedSha !== p.pushedSha) return "state_changed";
        const upstream = this.deps.prs.repoRef(ctx.repo.upstreamUrl ?? "");
        if (!upstream) return "unsupported_remote";
        const status = await this.deps.prs.prStatus({ upstream, number: p.prNumber });
        // M6: the fresh status is kept on the step for the task view; failing checks refuse.
        const freshStatus = { ...status, checkedAt: this.deps.clock.now().toISOString() };
        this.deps.db.transaction((tx) => {
          const r = this.stepRow(tx, task.id, "merge_pr");
          this.store.upsertStep(tx, task.id, "merge_pr", r?.status ?? "awaiting_approval", {
            output: { ...((r?.output as object | null) ?? {}), freshStatus },
          });
        });
        if (status.headSha !== p.pushedSha) return "pr_head_moved";
        return status.checks === "failing" ? "checks_failing" : null;
      }
    }
  }

  /** E16: a rejected, revoked or expired step approval cancels the task and enqueues cleanup. */
  private onDecision(tx: DbOrTx, approvalId: string, type: string): void {
    const a = tx.select().from(approvalsTable).where(eq(approvalsTable.id, approvalId)).get();
    if (!a || a.targetIntegration !== ENGINEERING_INTEGRATION) return;
    const step = ACTION_STEP[a.action];
    if (!step || !a.targetRef) return;
    const task = this.store.get(tx, a.targetRef);
    const row = this.stepRow(tx, a.targetRef, step);
    // A system revoke after a failed revalidation finds the task in needs_attention: ignored.
    if (
      task?.status !== "awaiting_approval" ||
      task.currentStep !== step ||
      row?.approvalId !== approvalId
    ) {
      return;
    }
    const decision = type.slice("approval.".length);
    this.store.transition(tx, task.id, "cancelled", {}, ["awaiting_approval"]);
    this.store.upsertStep(tx, task.id, step, "skipped", {
      output: { ...((row.output as object | null) ?? {}), decision },
    });
    this.expirePending(tx, task.id);
    this.enqueue(tx, task.id, "cleanup");
    this.audit(tx, "engineering.step_rejected", task.id, "cancelled", { step, decision });
  }

  // ---- E15: cleanup ---------------------------------------------------------------------------

  /**
   * After `completed`, `cancelled` or `failed`. Never touches git while another task holds the
   * lock (step `skipped`) or while this task still has an operation running here (deferred until
   * it ends). Expires the task's pending approvals. Uncommitted develop changes are discarded
   * only when they still hash to what the run produced (and the user saw). Then switches back to
   * the branch checked out at pickup and deletes the task branch (forced only before a commit).
   * A dirty tree: `needs_attention` (`dirty_tree`), the lock is kept. A config that changed since
   * Synapse last checked it: git is not run at all, the step is `skipped` (`config_changed`) and
   * the lock is released. Otherwise the lock is released.
   */
  async cleanup(taskId: string): Promise<StepResult> {
    const { db, lock, git } = this.deps;
    const task = this.store.get(db, taskId);
    if (!task) return { status: "skipped", step: "cleanup", reason: "not_found" };
    const holder = lock.holder();
    if (holder && holder.taskId !== taskId) {
      this.mark(taskId, "cleanup", "skipped", { output: { reason: "lock_held_by_other" } });
      return { status: "skipped", step: "cleanup", reason: "lock_held_by_other" };
    }
    // A completed or failed task whose cleanup found a dirty tree is retried from needs_attention
    // and is closed with that outcome again only by a successful cleanup (M8 adds `failed`).
    const priorNow = task.status === "needs_attention" ? priorTerminalStatus(db, taskId) : null;
    const retry = priorNow === "completed" || priorNow === "failed";
    if (!TERMINAL_STATUSES.includes(task.status) && !retry) {
      return { status: "skipped", step: "cleanup", reason: "not_terminal" };
    }
    if (this.#inFlight.has(taskId)) {
      this.#cleanupWanted.add(taskId);
      return { status: "skipped", step: "cleanup", reason: "step_running" };
    }
    const prior = retry ? priorNow : null;
    db.transaction((tx) => {
      this.expirePending(tx, taskId);
      const priorFailure = prior ? priorFailureOf(tx, taskId) : null;
      this.store.upsertStep(tx, taskId, "cleanup", "running", {
        output: prior ? { priorStatus: prior, ...(priorFailure ? { priorFailure } : {}) } : null,
      });
    });
    const release = () => {
      if (holder) lock.release(taskId);
    };
    const steps = this.store.steps(db, taskId);
    const status = (s: EngineeringStep) => steps.find((r) => r.step === s)?.status;
    const out = (s: EngineeringStep) => {
      const o = steps.find((r) => r.step === s)?.output;
      return o && typeof o === "object" ? (o as Record<string, unknown>) : null;
    };
    const repo = db.select().from(repositories).where(eq(repositories.id, task.repositoryId)).get();
    if (status("branch") !== "done" || !repo || !task.taskBranch || !task.parentBranch) {
      // Synapse never created the task branch: nothing to clean locally.
      return this.cleaned(taskId, { git: false }, release);
    }
    const path = repo.localPath;
    const trusted = (["push_pr", "merge_local", "commit", "develop"] as const)
      .map((s) => out(s)?.configFingerprint)
      .find((v): v is string => typeof v === "string");
    try {
      if (trusted && (await git.configFingerprint(path)) !== trusted) {
        db.transaction((tx) => {
          this.store.upsertStep(tx, taskId, "cleanup", "skipped", {
            output: { reason: "config_changed" },
          });
          this.audit(tx, "engineering.cleanup_skipped", taskId, "skipped", {
            reason: "config_changed",
          });
        });
        release();
        return { status: "skipped", step: "cleanup", reason: "config_changed" };
      }
      const committed = status("commit") === "done";
      const developHash = out("develop")?.diffHash;
      if (!committed && typeof developHash === "string") {
        try {
          await git.discardChanges(path, developHash, { expectedConfigFingerprint: trusted });
        } catch {
          // Changed since the run (the user's own edits?): left alone; cleanup sees it dirty.
        }
      }
      const returnTo = await this.returnBranch(path, task, out("branch")?.returnTo);
      // Forced only while the branch holds no commit at all (its tip is still the base). Any
      // commit (Synapse's, even one whose bookkeeping a crash lost, or the user's) is deleted
      // only when another local branch contains it; otherwise the branch is kept.
      const tip = await git.branchTip(path, task.taskBranch);
      const force = tip !== null && task.baseSha !== null && tip === task.baseSha;
      const r = await git.cleanup(path, task.taskBranch, returnTo, { force });
      if (!r.ok) return this.cleanupAttention(taskId, "dirty_tree");
      // Not deleted while it exists: unmerged commits, or no branch to step off it to (I2).
      const kept = !r.deleted && tip !== null;
      return this.cleaned(
        taskId,
        { git: true, deleted: r.deleted, ...(kept ? { outcome: "branch_kept" } : {}) },
        release,
      );
    } catch (e) {
      return this.cleanupAttention(taskId, codeOf(e));
    }
  }

  private cleaned(
    taskId: string,
    output: Record<string, unknown>,
    release: () => void,
  ): StepResult {
    this.deps.db.transaction(
      (tx) => {
        const task = this.store.get(tx, taskId);
        const prior = task?.status === "needs_attention" ? priorTerminalStatus(tx, taskId) : null;
        const priorFailure = prior ? priorFailureOf(tx, taskId) : null;
        this.store.upsertStep(tx, taskId, "cleanup", "done", {
          output: {
            ...output,
            ...(prior ? { priorStatus: prior } : {}),
            ...(priorFailure ? { priorFailure } : {}),
          },
        });
        // The re-cleanup of a completed or failed task closes it with that outcome again; a
        // failed task keeps its failure reason (M8).
        if (prior === "completed") {
          this.store.transition(tx, taskId, "completed", { failure: null });
        } else if (prior === "failed") {
          this.store.transition(tx, taskId, "failed", { failure: priorFailure });
        }
        this.audit(tx, "engineering.cleaned", taskId, "ok", {
          deleted: output.deleted === true,
          branchKept: output.outcome === "branch_kept",
        });
      },
      { behavior: "immediate" },
    );
    release();
    return { status: "done", step: "cleanup" };
  }

  private cleanupAttention(taskId: string, reason: string): StepResult {
    this.deps.db.transaction(
      (tx) => {
        const task = this.store.get(tx, taskId);
        // The terminal outcome it had (or, on a retry, the one recorded before) is kept.
        const terminal = task !== null && TERMINAL_STATUSES.includes(task.status);
        const priorStatus = terminal ? task.status : priorTerminalStatus(tx, taskId);
        // M8: the failure reason of a failed task, restored when a retried cleanup succeeds.
        const priorFailure = terminal ? task.failure : priorFailureOf(tx, taskId);
        if (task && task.status !== "needs_attention") {
          this.store.transition(tx, taskId, "needs_attention", { failure: reason });
        }
        this.store.upsertStep(tx, taskId, "cleanup", "failed", {
          output: {
            failure: reason,
            ...(priorStatus ? { priorStatus } : {}),
            ...(priorFailure ? { priorFailure } : {}),
          },
        });
        this.audit(tx, "engineering.cleanup_failed", taskId, "needs_attention", { reason });
      },
      { behavior: "immediate" },
    );
    return { status: "needs_attention", step: "cleanup", reason };
  }

  // ---- helpers --------------------------------------------------------------------------------

  /**
   * I2: where cleanup switches to: the branch checked out at pickup, else the parent, whichever
   * still exists locally; null (stay on the current branch) when neither does. The task branch is
   * never a return target.
   */
  private async returnBranch(path: string, task: TaskRow, stored: unknown): Promise<string | null> {
    const candidates = [typeof stored === "string" ? stored : null, task.parentBranch];
    for (const b of candidates) {
      if (b && b !== task.taskBranch && (await this.deps.git.branchExists(path, b))) return b;
    }
    return null;
  }

  /**
   * Runs `fn` with the task marked in flight, then any cleanup that was asked for meanwhile (a
   * cancel during the step, or the step itself ending the task).
   */
  private async track<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    if (this.#inFlight.has(taskId)) throw new ExecutorError("step_running");
    this.#inFlight.add(taskId);
    try {
      return await fn();
    } finally {
      this.#inFlight.delete(taskId);
      if (this.#cleanupWanted.delete(taskId)) {
        try {
          await this.cleanup(taskId);
        } catch (e) {
          console.error(
            `engineering cleanup failed task=${taskId} error=${e instanceof Error ? e.name : "unknown"}`,
          );
        }
      }
    }
  }

  /** Task, repository and branches, or why the task cannot be worked on. */
  private context(taskId: string): Ctx | { skip: string } {
    const { db } = this.deps;
    const task = this.store.get(db, taskId);
    if (!task) return { skip: "not_found" };
    const repo = db.select().from(repositories).where(eq(repositories.id, task.repositoryId)).get();
    if (!repo) return { skip: "not_found" };
    if (!task.parentBranch || !task.taskBranch) return { skip: "invalid_state" };
    let real: string | null = null;
    try {
      real = realpathSync(repo.localPath);
    } catch {
      real = null;
    }
    if (real !== repo.localPath) return { skip: "path_unavailable" };
    return {
      task,
      repo,
      path: repo.localPath,
      parent: task.parentBranch,
      taskBranch: task.taskBranch,
    };
  }

  /** The context of an `in_progress` task at `step` that holds the lock. */
  private active(taskId: string, step: EngineeringStep): Ctx | { skip: string } {
    const task = this.store.get(this.deps.db, taskId);
    if (task?.status !== "in_progress" || task.currentStep !== step)
      return { skip: "state_changed" };
    if (this.deps.lock.holder()?.taskId !== taskId) return { skip: "lock_lost" };
    const ctx = this.context(taskId);
    if ("skip" in ctx && ctx.skip === "path_unavailable") {
      this.attention(taskId, step, "path_unavailable");
    }
    return ctx;
  }

  /**
   * Writes a step outcome unless the task was cancelled meanwhile; then the step is recorded as
   * it ended (`done` with its output) and cleanup is asked for.
   */
  private async settle(
    taskId: string,
    step: EngineeringStep,
    output: Record<string, unknown>,
    fn: (tx: DbOrTx) => StepResult,
  ): Promise<StepResult> {
    const r = this.deps.db.transaction(
      (tx): StepResult | null => {
        const task = this.store.get(tx, taskId);
        if (!task || TERMINAL_STATUSES.includes(task.status)) {
          this.store.upsertStep(tx, taskId, step, "done", { output });
          return null;
        }
        return fn(tx);
      },
      { behavior: "immediate" },
    );
    if (r) return r;
    this.#cleanupWanted.add(taskId);
    return { status: "skipped", step, reason: "cancelled" };
  }

  /**
   * `needs_attention` with a fixed reason; the lock is kept (the user resolves it, then cancels).
   * A task cancelled meanwhile stays cancelled and gets its cleanup.
   */
  private attention(
    taskId: string,
    step: EngineeringStep,
    reason: string,
    output?: Record<string, unknown>,
    claudeRunId?: string | null,
  ): StepResult {
    const cancelled = this.deps.db.transaction(
      (tx) => {
        const task = this.store.get(tx, taskId);
        const prev = (this.stepRow(tx, taskId, step)?.output as object | null) ?? {};
        this.store.upsertStep(tx, taskId, step, "failed", {
          output: { ...prev, ...(output ?? {}), failure: reason },
          ...(claudeRunId !== undefined ? { claudeRunId } : {}),
        });
        if (!task || !ACTIVE_STATUSES.includes(task.status)) return true;
        this.store.transition(tx, taskId, "needs_attention", { failure: reason });
        this.audit(tx, "engineering.step_failed", taskId, "needs_attention", { step, reason });
        return false;
      },
      { behavior: "immediate" },
    );
    if (cancelled) this.#cleanupWanted.add(taskId);
    return { status: "needs_attention", step, reason };
  }

  /** `failed` with a fixed reason, then cleanup (after the current operation). */
  private terminalFailure(
    taskId: string,
    step: EngineeringStep,
    reason: string,
    output: Record<string, unknown>,
    claudeRunId: string | null,
  ): StepResult {
    this.deps.db.transaction(
      (tx) => {
        this.store.upsertStep(tx, taskId, step, "failed", {
          output: { ...output, failure: reason },
          claudeRunId,
        });
        const task = this.store.get(tx, taskId);
        if (task && ACTIVE_STATUSES.includes(task.status)) {
          this.store.transition(tx, taskId, "failed", { failure: reason });
          this.audit(tx, "engineering.step_failed", taskId, "failed", { step, reason });
        }
      },
      { behavior: "immediate" },
    );
    this.#cleanupWanted.add(taskId);
    return { status: "failed", step, reason };
  }

  /** Requests a step approval and moves the task to `awaiting_approval` at that step. */
  private requestStep(
    tx: DbOrTx,
    taskId: string,
    step: ApprovalStep,
    action: Operation,
    riskLevel: RiskLevel,
    payload: unknown,
    stepOutput: Record<string, unknown>,
  ): void {
    // An attempt counter: a re-requested step never gets an old, already decided approval back.
    const attempt =
      tx
        .select({ id: approvalsTable.id })
        .from(approvalsTable)
        .where(
          and(
            eq(approvalsTable.targetIntegration, ENGINEERING_INTEGRATION),
            eq(approvalsTable.targetRef, taskId),
            eq(approvalsTable.action, action),
          ),
        )
        .all().length + 1;
    const approval = this.deps.approvals.request(tx, {
      action,
      targetIntegration: ENGINEERING_INTEGRATION,
      targetRef: taskId,
      payload,
      riskLevel,
      idempotencyKey: `engineering:${step}:${taskId}:${attempt}`,
      requestedByModule: MODULE,
      requestedByWorker: WORKER,
    });
    this.store.upsertStep(tx, taskId, step, "awaiting_approval", {
      approvalId: approval.id,
      output: stepOutput,
    });
    this.store.transition(tx, taskId, "awaiting_approval", { currentStep: step, failure: null });
  }

  /** Expires the task's pending (or approved, unclaimed) approvals. */
  private expirePending(tx: DbOrTx, taskId: string): void {
    const open = tx
      .select({ id: approvalsTable.id })
      .from(approvalsTable)
      .where(
        and(
          eq(approvalsTable.targetIntegration, ENGINEERING_INTEGRATION),
          eq(approvalsTable.targetRef, taskId),
          inArray(approvalsTable.status, ["pending", "approved"]),
          isNull(approvalsTable.executionStartedAt),
        ),
      )
      .all();
    for (const a of open) this.deps.approvals.expireAsSystem(tx, a.id, "task_cancelled");
  }

  private mark(
    taskId: string,
    step: EngineeringStep,
    status: "running" | "pending" | "skipped",
    fields: Parameters<EngineeringTaskStore["upsertStep"]>[4] = {},
  ): void {
    this.deps.db.transaction((tx) => this.store.upsertStep(tx, taskId, step, status, fields));
  }

  private enqueue(tx: DbOrTx, taskId: string, step: JobStep): void {
    this.deps.queue.enqueue(tx, {
      type: STEP_JOB,
      input: { taskId, step },
      idempotencyKey: `${STEP_JOB}:${taskId}:${step}:${newId()}`,
      maxAttempts: 1,
    });
  }

  private stepRow(tx: DbOrTx, taskId: string, step: EngineeringStep) {
    return this.store.steps(tx, taskId).find((r) => r.step === step);
  }

  private stepOutput(taskId: string, step: EngineeringStep): Record<string, unknown> | null {
    const o = this.stepRow(this.deps.db, taskId, step)?.output;
    return o && typeof o === "object" ? (o as Record<string, unknown>) : null;
  }

  private environments(repoId: string) {
    return this.deps.db
      .select()
      .from(repositoryEnvironments)
      .where(eq(repositoryEnvironments.repositoryId, repoId))
      .all();
  }

  /** ADR-035: branches of protected environments, re-read at every check. */
  private protectedBranches(repoId: string): string[] {
    return this.environments(repoId)
      .filter((e) => e.protected)
      .map((e) => e.branch);
  }

  /** The auto-deploy notice: the environment whose branch is the parent and deploys on merge. */
  private deployNotice(task: TaskRow): { autoDeploys: boolean; environmentName?: string } {
    const env = this.environments(task.repositoryId).find(
      (e) => e.branch === task.parentBranch && e.autoDeploysOnMerge,
    );
    return env ? { autoDeploys: true, environmentName: env.name } : { autoDeploys: false };
  }

  private audit(
    tx: DbOrTx,
    action: string,
    taskId: string,
    result: string,
    details: Record<string, unknown>,
  ): void {
    this.deps.audit.record(tx, {
      actor: "system",
      module: MODULE,
      action,
      workerProfile: WORKER,
      targetRef: taskId,
      result,
      details: { taskId, ...details },
    });
  }
}

/** E10: `<title>`, the approved description (summarised), `Task: <id>`. */
export function commitMessage(task: Pick<TaskRow, "id" | "title" | "approvedDescription">): string {
  const desc = clip((task.approvedDescription ?? "").trim(), COMMIT_DESCRIPTION_MAX);
  const subject = clipUnits(task.title, COMMIT_SUBJECT_MAX);
  return desc === ""
    ? `${subject}\n\nTask: ${task.id}`
    : `${subject}\n\n${desc}\n\nTask: ${task.id}`;
}

/** M1: the develop step's test result; output from before the final review has no `testRun`. */
export function developTestResult(out: Record<string, unknown> | null): {
  testsPassed: boolean;
  testRun: TestRun;
} {
  const testsPassed = out?.testsPassed === true;
  const parsed = testRunSchema.safeParse(out?.testRun);
  const testRun: TestRun = parsed.success
    ? parsed.data
    : typeof out?.testOutputTail === "string"
      ? "exact"
      : "none";
  return { testsPassed, testRun };
}

/** E13: the PR body: the approved description, the task id and the test result (M1 wording). */
export function prBody(
  task: Pick<TaskRow, "id" | "approvedDescription">,
  tests: { testsPassed: boolean; testRun: TestRun },
): string {
  const desc = clip((task.approvedDescription ?? "").trim(), PR_BODY_MAX);
  return `${desc}\n\nTask: ${task.id}\n${testResultLabel(tests.testsPassed, tests.testRun)}`;
}
