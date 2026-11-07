import { realpathSync } from "node:fs";
import {
  allBranchNames,
  approveDescriptionInputSchema,
  type EngineeringTaskCreateInput,
  type EngineeringTaskDetail,
  type EngineeringTaskStatus,
  type EngineeringTaskView,
  engineeringTaskCreateInputSchema,
  type GitWorkflow,
  GitWorkflowError,
  type InvestigationOutput,
  isSafeAbsolutePath,
  type PlanApprovalInput,
  planApprovalInputSchema,
  type RepositoryProvider,
  taskBranchName,
} from "@synapse/contracts";
import { type Db, type DbOrTx, schema } from "@synapse/database";
import { type Clock, newId } from "@synapse/shared";
import { eq } from "drizzle-orm";
import type { AuditLogger } from "../../core/audit/audit";
import type { EventPublisher } from "../../core/events/publisher";
import type { JobQueue } from "../../core/jobs/queue";
import { RegistryError } from "../engineering-brain/registry";
import { type EngineeringLock, STEP_JOB } from "./lock";
import {
  cleanupViews,
  EngineeringTaskError,
  EngineeringTaskStore,
  priorTerminalStatus,
  type TaskRow,
  TERMINAL_STATUSES,
  toView,
} from "./store";

export { STEP_JOB } from "./lock";
export { EngineeringTaskError } from "./store";

const { repositories, repositoryEnvironments, jiraIssues, slackMessages } = schema;
const MODULE = "engineering-tasks";

/** E3: the read-only investigation run (one attempt). Input `{taskId}`. */
export const INVESTIGATE_JOB = "engineering.investigate";
/** E6: every minute, picks up the next queued task when the lock is free. */
export const PICKUP_JOB = "engineering.pickup";
/** E6: every 2 minutes, renews the lock while its holder is active. */
export const LOCK_RENEW_JOB = "engineering.lock_renew";

const TITLE_MAX = 120;
const DRAFT_MAX = 8000;

const clip = (s: string, n: number) => [...s].slice(0, n).join("");

/** The registry call plan approval uses for "remember as tracked" (audited by the registry). */
export interface TrackedBranchUpdater {
  update(id: string, patch: { trackedBranch: string }): Promise<unknown>;
}

export interface EngineeringTaskServiceDeps {
  db: Db;
  clock: Clock;
  events: Pick<EventPublisher, "publish">;
  audit: Pick<AuditLogger, "record">;
  queue: Pick<JobQueue, "enqueue">;
  provider: RepositoryProvider;
  registry: TrackedBranchUpdater;
  lock: Pick<EngineeringLock, "holder" | "acquire" | "release">;
  git: Pick<GitWorkflow, "preflight">;
}

export interface InvestigationTarget {
  taskId: string;
  repositoryId: string;
  name: string;
  /** The registered realpath, re-checked against git's top level. */
  localPath: string;
  /** The user-approved description: the only task text a run ever receives (ADR-032). */
  approvedDescription: string;
}

export type PrepareInvestigationResult =
  | { ok: true; target: InvestigationTarget }
  | { ok: false; reason: "not_investigating" | "path_unavailable" };

export interface InvestigationRecord {
  output: InvestigationOutput;
  filesKept: number;
  filesDropped: number;
  testCommandDropped: boolean;
  claudeRunId: string | null;
  permissionDenials: readonly string[];
}

export interface InvestigationSummary {
  status: "planned";
  filesKept: number;
  filesDropped: number;
  unclear: number;
}

/** Most queued tasks one tick will try before giving up (each failing one backs off). */
const PICKUP_MAX_TRIES = 20;

export type PickupResult =
  | { pickedUp: string }
  | { needsAttention: string; reason: string }
  | { deferred: string; reason: string }
  | { skipped: "lock_held" | "nothing_queued" | "state_changed" };

/**
 * I1: preflight failures that say nothing about the repository (the network, a slow remote). The
 * task stays `queued` and the next tick tries again; every other reason is deterministic and sets
 * `needs_attention`.
 */
const RETRYABLE_PREFLIGHT = new Set(["fetch_failed", "git_timeout"]);

function realpathOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Engineering tasks (E1–E7): creation from the user, a Jira issue or a Slack message,
 * description approval, the investigation bookkeeping, plan approval with branch confirmation,
 * pickup under the global lock, and cancellation. Draft text (possibly untrusted: a Jira summary
 * or a Slack message) is stored and shown, never sent to a run; only `approved_description` is.
 * Audit rows and events carry ids, enums and counts: never task text, branch names or paths.
 */
export class EngineeringTaskService {
  private readonly store: EngineeringTaskStore;

  constructor(private readonly deps: EngineeringTaskServiceDeps) {
    this.store = new EngineeringTaskStore(deps);
  }

  // ---- creation (E2) -------------------------------------------------------------------------

  create(raw: EngineeringTaskCreateInput): EngineeringTaskDetail {
    const parsed = engineeringTaskCreateInputSchema.safeParse(raw);
    if (!parsed.success) throw new EngineeringTaskError("invalid_input");
    const input = parsed.data;
    if (!this.repoExists(input.repositoryId)) throw new EngineeringTaskError("not_found");
    return this.insert({
      repositoryId: input.repositoryId,
      source: "manual",
      sourceRef: null,
      title: input.title,
      draftDescription: input.draftDescription,
    });
  }

  /**
   * A proposal from a stored Jira issue: the draft is the summary only (E2). The repository is
   * the given one, else the only repository whose Jira keys include the issue's project, else
   * the only registered repository.
   */
  createFromJira(key: string, repositoryId?: string): EngineeringTaskDetail {
    const issue = this.deps.db
      .select({
        key: jiraIssues.key,
        projectKey: jiraIssues.projectKey,
        summary: jiraIssues.summary,
      })
      .from(jiraIssues)
      .where(eq(jiraIssues.key, key))
      .get();
    if (!issue) throw new EngineeringTaskError("not_found");
    const repoId = this.resolveRepository(repositoryId, issue.projectKey);
    const summary = issue.summary.trim();
    if (summary === "") throw new EngineeringTaskError("no_content");
    return this.insert({
      repositoryId: repoId,
      source: "jira",
      sourceRef: issue.key,
      title: clip(`${issue.key}: ${summary.replace(/\s+/g, " ")}`, TITLE_MAX),
      draftDescription: clip(summary, DRAFT_MAX),
    });
  }

  /** A proposal from a collected Slack message: the draft is its text (E2). */
  createFromSlack(messageId: string, repositoryId?: string): EngineeringTaskDetail {
    const msg = this.deps.db
      .select({ id: slackMessages.id, text: slackMessages.text })
      .from(slackMessages)
      .where(eq(slackMessages.id, messageId))
      .get();
    if (!msg) throw new EngineeringTaskError("not_found");
    const text = msg.text?.trim() ?? "";
    if (text === "") throw new EngineeringTaskError("no_content");
    const repoId = this.resolveRepository(repositoryId, null);
    const firstLine = text.split("\n")[0]?.replace(/\s+/g, " ").trim() ?? "";
    return this.insert({
      repositoryId: repoId,
      source: "slack",
      sourceRef: msg.id,
      title: clip(firstLine === "" ? "Task from Slack" : firstLine, TITLE_MAX),
      draftDescription: clip(text, DRAFT_MAX),
    });
  }

  // ---- description approval and investigation (E2, E3) ----------------------------------------

  /**
   * The user's approved description (from `proposed`, or `planned` to re-investigate). Clears any
   * plan, resets the task's one `investigate` step row and enqueues a single-attempt run.
   */
  approveDescription(id: string, description: string): EngineeringTaskDetail {
    const parsed = approveDescriptionInputSchema.safeParse({ description });
    if (!parsed.success || parsed.data.description.trim() === "") {
      throw new EngineeringTaskError("invalid_input");
    }
    const { db, queue, audit } = this.deps;
    db.transaction(
      (tx) => {
        this.store.transition(
          tx,
          id,
          "investigating",
          {
            approvedDescription: parsed.data.description,
            plan: null,
            failure: null,
            currentStep: "investigate",
          },
          ["proposed", "planned"],
        );
        this.store.upsertStep(tx, id, "investigate", "pending", {
          output: null,
          claudeRunId: null,
        });
        queue.enqueue(tx, {
          type: INVESTIGATE_JOB,
          input: { taskId: id },
          idempotencyKey: `${INVESTIGATE_JOB}:${id}:${newId()}`,
          maxAttempts: 1,
        });
        audit.record(tx, {
          actor: "user",
          module: MODULE,
          action: "engineering.description_approved",
          targetRef: id,
          result: "ok",
          details: { taskId: id },
        });
      },
      { behavior: "immediate" },
    );
    return this.mustGet(id);
  }

  /**
   * What the investigation run needs, or why it must not run. The registered path must still be
   * a safe absolute realpath that git reports as its own top level. Marks the step `running`.
   */
  async prepareInvestigation(taskId: string): Promise<PrepareInvestigationResult> {
    const { db, provider } = this.deps;
    const task = this.store.get(db, taskId);
    if (task?.status !== "investigating" || !task.approvedDescription) {
      return { ok: false, reason: "not_investigating" };
    }
    const repo = db.select().from(repositories).where(eq(repositories.id, task.repositoryId)).get();
    let ok = !!repo && isSafeAbsolutePath(repo.localPath);
    if (ok && repo) ok = realpathOrNull(repo.localPath) === repo.localPath;
    if (ok && repo) {
      const r = await provider.inspect(repo.localPath);
      ok = r.ok && r.inspection.topLevel === repo.localPath;
    }
    if (!ok || !repo) {
      this.recordInvestigationFailure(taskId, "path_unavailable");
      return { ok: false, reason: "path_unavailable" };
    }
    const running = db.transaction(
      (tx) => {
        const fresh = this.store.get(tx, taskId);
        if (fresh?.status !== "investigating") return false;
        this.store.upsertStep(tx, taskId, "investigate", "running");
        return true;
      },
      { behavior: "immediate" },
    );
    if (!running) return { ok: false, reason: "not_investigating" };
    return {
      ok: true,
      target: {
        taskId,
        repositoryId: repo.id,
        name: repo.name,
        localPath: repo.localPath,
        approvedDescription: task.approvedDescription,
      },
    };
  }

  /**
   * Stores the verified plan on the task and moves it to `planned` (also with open `unclear`
   * questions: the user may approve or edit and re-investigate). Nothing is written when the
   * task left `investigating` (cancelled) while the run was going. Audited with counts only.
   */
  recordInvestigation(
    taskId: string,
    r: InvestigationRecord,
  ): InvestigationSummary | { skipped: "not_investigating" } {
    const { db, audit } = this.deps;
    return db.transaction(
      (tx) => {
        const task = this.store.get(tx, taskId);
        if (task?.status !== "investigating") return { skipped: "not_investigating" as const };
        this.store.transition(tx, taskId, "planned", {
          plan: r.output,
          currentStep: null,
          failure: null,
        });
        const counts = {
          filesKept: r.filesKept,
          filesDropped: r.filesDropped,
          unclear: r.output.unclear.length,
        };
        this.store.upsertStep(tx, taskId, "investigate", "done", {
          claudeRunId: r.claudeRunId,
          output: { ...counts, testCommandDropped: r.testCommandDropped },
        });
        audit.record(tx, {
          actor: "system",
          module: MODULE,
          action: "engineering.investigated",
          workerProfile: "engineering",
          targetRef: taskId,
          result: "ok",
          details: {
            taskId,
            ...counts,
            planSteps: r.output.plan.length,
            risk: r.output.risk,
            size: r.output.size,
            testCommandDropped: r.testCommandDropped,
            // Tool names only: a denial means the run tried to step outside its scope.
            permissionDenials: [...new Set(r.permissionDenials)].sort(),
          },
        });
        return { status: "planned" as const, ...counts };
      },
      { behavior: "immediate" },
    );
  }

  /** The run was deferred (quota or auth pause): the step waits again; the task stays put. */
  markInvestigationDeferred(taskId: string): void {
    this.deps.db.transaction(
      (tx) => {
        if (this.store.get(tx, taskId)?.status !== "investigating") return;
        this.store.upsertStep(tx, taskId, "investigate", "pending");
      },
      { behavior: "immediate" },
    );
  }

  /**
   * A failed investigation (one attempt): back to `proposed` with the fixed code in `failure`,
   * so the user can edit the description and approve again. No-op when no longer investigating.
   */
  recordInvestigationFailure(
    taskId: string,
    code: string,
    claudeRunId: string | null = null,
  ): void {
    const { db, audit } = this.deps;
    db.transaction(
      (tx) => {
        const task = this.store.get(tx, taskId);
        if (task?.status !== "investigating") return;
        this.store.transition(tx, taskId, "proposed", { failure: code, currentStep: null });
        this.store.upsertStep(tx, taskId, "investigate", "failed", {
          claudeRunId,
          output: { failure: code },
        });
        audit.record(tx, {
          actor: "system",
          module: MODULE,
          action: "engineering.investigate_failed",
          workerProfile: "engineering",
          targetRef: taskId,
          result: "failed",
          details: { taskId, kind: code },
        });
      },
      { behavior: "immediate" },
    );
  }

  // ---- plan approval with branch confirmation (E4, E5, ADR-035) -------------------------------

  /**
   * One user action: confirms the parent branch, optional environment and test command. Refuses
   * an unsafe test command, an environment of another repository, a protected environment or
   * any parent equal to a protected environment's branch (`protected_branch`, no override), and
   * a parent that exists neither locally nor on a remote. On success: the repository's
   * `test_command` is stored, the task gets its parent and task branch and becomes `queued`.
   * `rememberAsTracked` also sets the repository's tracked branch through the registry.
   */
  async approvePlan(id: string, raw: PlanApprovalInput): Promise<EngineeringTaskDetail> {
    const parsed = planApprovalInputSchema.safeParse(raw);
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path[0];
      if (field === "testCommand") throw new EngineeringTaskError("unsafe_test_command");
      if (field === "parentBranch") throw new EngineeringTaskError("unknown_branch");
      throw new EngineeringTaskError("invalid_input");
    }
    const input = parsed.data;
    const { db, provider } = this.deps;
    const task = this.store.get(db, id);
    if (!task) throw new EngineeringTaskError("not_found");
    if (task.status !== "planned" || task.plan == null) {
      throw new EngineeringTaskError("invalid_state");
    }
    const repo = db.select().from(repositories).where(eq(repositories.id, task.repositoryId)).get();
    if (!repo) throw new EngineeringTaskError("not_found");
    const envs = this.environments(db, repo.id);
    if (input.environmentId !== undefined) {
      const env = envs.find((e) => e.id === input.environmentId);
      if (!env) throw new EngineeringTaskError("unknown_environment");
      if (env.protected) throw new EngineeringTaskError("protected_branch");
    }
    if (envs.some((e) => e.protected && e.branch === input.parentBranch)) {
      throw new EngineeringTaskError("protected_branch");
    }
    const inspected = await provider.inspect(repo.localPath);
    if (!inspected.ok || inspected.inspection.topLevel !== repo.localPath) {
      throw new EngineeringTaskError("path_unavailable");
    }
    if (!allBranchNames(inspected.inspection).includes(input.parentBranch)) {
      throw new EngineeringTaskError("unknown_branch");
    }
    db.transaction(
      (tx) => {
        const fresh = this.store.get(tx, id);
        if (fresh?.status !== "planned" || fresh.plan == null) {
          throw new EngineeringTaskError("invalid_state");
        }
        this.store.transition(tx, id, "queued", {
          parentBranch: input.parentBranch,
          taskBranch: taskBranchName(id, fresh.title),
          environmentId: input.environmentId ?? null,
          failure: null,
        });
        tx.update(repositories)
          .set({ testCommand: input.testCommand })
          .where(eq(repositories.id, repo.id))
          .run();
        this.deps.audit.record(tx, {
          actor: "user",
          module: MODULE,
          action: "engineering.plan_approved",
          targetRef: id,
          result: "ok",
          details: {
            taskId: id,
            repositoryId: repo.id,
            environmentId: input.environmentId ?? null,
            rememberAsTracked: input.rememberAsTracked === true,
          },
        });
      },
      { behavior: "immediate" },
    );
    // After the transition succeeded: a refused approval never changes the registry.
    if (input.rememberAsTracked && repo.trackedBranch !== input.parentBranch) {
      try {
        await this.deps.registry.update(repo.id, { trackedBranch: input.parentBranch });
      } catch (e) {
        if (e instanceof RegistryError) throw new EngineeringTaskError(`registry_error:${e.code}`);
        throw e;
      }
    }
    return this.mustGet(id);
  }

  // ---- pickup (E6, E7) ------------------------------------------------------------------------

  /**
   * The minute tick. When no lease row exists (an expired one still counts as held) and a task
   * is queued, takes the lock for the highest-priority, oldest task and runs preflight. A passing
   * failure (`fetch_failed`, `git_timeout`: the network, not the repository) releases the lock,
   * leaves the task `queued` with `lastPickupError` set, and the next tick retries (I1). Any other
   * failure (including a parent that became protected) sets `needs_attention` with the fixed
   * reason and releases the lock. Success clears `lastPickupError`, sets `in_progress` at step
   * `branch` and enqueues the step job.
   */
  async pickupNext(): Promise<PickupResult> {
    // A deferred task backs off (nextQueued skips it), so the next eligible task, possibly in
    // another repository, is tried in the same tick instead of being blocked behind it.
    let firstDeferred: PickupResult | null = null;
    for (let i = 0; i < PICKUP_MAX_TRIES; i++) {
      const r = await this.pickupOne();
      if ("deferred" in r) {
        firstDeferred ??= r;
        continue;
      }
      if ("skipped" in r && r.skipped === "nothing_queued" && firstDeferred) return firstDeferred;
      return r;
    }
    return firstDeferred ?? { skipped: "nothing_queued" };
  }

  private async pickupOne(): Promise<PickupResult> {
    const { db, lock } = this.deps;
    if (lock.holder()) return { skipped: "lock_held" };
    const task = this.store.nextQueued(db);
    if (!task) return { skipped: "nothing_queued" };
    if (!lock.acquire(task.id)) return { skipped: "lock_held" };

    const reason = await this.preflightReason(task);
    if (reason && RETRYABLE_PREFLIGHT.has(reason)) {
      db.transaction(
        (tx) => {
          if (this.store.get(tx, task.id)?.status !== "queued") return; // cancelled meanwhile
          this.store.update(tx, task.id, {
            lastPickupError: reason,
            pickupFailures: task.pickupFailures + 1,
          });
          // One audit row per distinct error, not one per retry.
          if (task.lastPickupError !== reason) {
            this.deps.audit.record(tx, {
              actor: "system",
              module: MODULE,
              action: "engineering.pickup_deferred",
              workerProfile: "engineering",
              targetRef: task.id,
              result: "deferred",
              details: { taskId: task.id, reason },
            });
          }
        },
        { behavior: "immediate" },
      );
      lock.release(task.id);
      return { deferred: task.id, reason };
    }
    if (reason) {
      db.transaction(
        (tx) => {
          try {
            this.store.transition(
              tx,
              task.id,
              "needs_attention",
              { failure: reason, lastPickupError: null, pickupFailures: 0 },
              ["queued"],
            );
          } catch (e) {
            if (!(e instanceof EngineeringTaskError)) throw e;
            return; // cancelled while preflight ran
          }
          this.deps.audit.record(tx, {
            actor: "system",
            module: MODULE,
            action: "engineering.preflight_failed",
            workerProfile: "engineering",
            targetRef: task.id,
            result: "needs_attention",
            details: { taskId: task.id, reason },
          });
        },
        { behavior: "immediate" },
      );
      lock.release(task.id);
      return { needsAttention: task.id, reason };
    }

    try {
      db.transaction(
        (tx) => {
          this.store.transition(
            tx,
            task.id,
            "in_progress",
            { currentStep: "branch", failure: null, lastPickupError: null, pickupFailures: 0 },
            ["queued"],
          );
          this.enqueueStep(tx, task.id, "branch");
          this.deps.audit.record(tx, {
            actor: "system",
            module: MODULE,
            action: "engineering.picked_up",
            workerProfile: "engineering",
            targetRef: task.id,
            result: "ok",
            details: { taskId: task.id },
          });
        },
        { behavior: "immediate" },
      );
    } catch (e) {
      if (!(e instanceof EngineeringTaskError)) throw e;
      lock.release(task.id);
      return { skipped: "state_changed" };
    }
    return { pickedUp: task.id };
  }

  /** E7 plus ADR-035 at pickup time; a fixed reason code, or null when the task may start. */
  private async preflightReason(task: TaskRow): Promise<string | null> {
    const { db, git } = this.deps;
    const repo = db.select().from(repositories).where(eq(repositories.id, task.repositoryId)).get();
    if (!repo) return "not_a_repository";
    if (!task.parentBranch) return "invalid_state";
    const parent = task.parentBranch;
    if (this.environments(db, repo.id).some((e) => e.protected && e.branch === parent)) {
      return "protected_branch";
    }
    try {
      // The user accepted an enabled upstream push URL only by registering (or accepting) it
      // that way; if git now differs from the stored state, preflight refuses.
      const r = await git.preflight(repo.localPath, parent, {
        allowUpstreamPush: !repo.upstreamPushDisabled,
      });
      return r.ok ? null : r.reason;
    } catch (e) {
      return e instanceof GitWorkflowError ? e.code : "git_failed";
    }
  }

  // ---- cancel, list, get (E16, E19) -----------------------------------------------------------

  /**
   * Cancels a task that is not finished. A task holding the lock gets its `cleanup` step job
   * enqueued: the step runner expires its pending approvals, cleans up the local branch and then
   * releases the lock (E15, E16). A `queued` task was never touched by Synapse, so nothing is
   * cleaned (if pickup holds the lock for it right now, pickup releases it when its transition
   * fails). A `needs_attention` task that had completed or failed before its cleanup failed keeps
   * that status and only gets its cleanup retried (it becomes `completed` or `failed` again on
   * success, M8).
   */
  cancel(id: string): EngineeringTaskDetail {
    const { db, lock, audit } = this.deps;
    db.transaction(
      (tx) => {
        const task = this.store.get(tx, id);
        if (!task) throw new EngineeringTaskError("not_found");
        if (TERMINAL_STATUSES.includes(task.status))
          throw new EngineeringTaskError("invalid_state");
        const holdsLock = lock.holder()?.taskId === id && task.status !== "queued";
        // A completed or failed task whose cleanup found a dirty tree is not cancelled: cleanup
        // is retried and closes it with that outcome again once the tree is tidy (M8).
        const prior = task.status === "needs_attention" ? priorTerminalStatus(tx, id) : null;
        const retryCompleted = prior === "completed" || prior === "failed";
        if (!retryCompleted) this.store.transition(tx, id, "cancelled");
        if (holdsLock) this.enqueueStep(tx, id, "cleanup");
        audit.record(tx, {
          actor: "user",
          module: MODULE,
          action: "engineering.cancelled",
          targetRef: id,
          result: "ok",
          details: { taskId: id, from: task.status, cleanup: holdsLock, retryCompleted },
        });
      },
      { behavior: "immediate" },
    );
    return this.mustGet(id);
  }

  list(status?: EngineeringTaskStatus): EngineeringTaskView[] {
    const rows = this.store.list(this.deps.db, status);
    const c = cleanupViews(this.deps.db, rows);
    return rows.map((r) => toView(r, c.get(r.id) ?? null));
  }

  get(id: string): EngineeringTaskDetail | null {
    return this.store.detail(this.deps.db, id);
  }

  // ---- helpers --------------------------------------------------------------------------------

  private insert(
    v: Pick<TaskRow, "repositoryId" | "source" | "sourceRef" | "title" | "draftDescription">,
  ): EngineeringTaskDetail {
    const { db, audit } = this.deps;
    const row = db.transaction(
      (tx) => {
        const r = this.store.insert(tx, v);
        audit.record(tx, {
          actor: v.source === "manual" ? "user" : "system",
          module: MODULE,
          action: "engineering.task_created",
          targetRef: r.id,
          result: "ok",
          details: { taskId: r.id, repositoryId: r.repositoryId, source: r.source },
        });
        return r;
      },
      { behavior: "immediate" },
    );
    return this.mustGet(row.id);
  }

  private enqueueStep(tx: DbOrTx, taskId: string, step: "branch" | "cleanup"): void {
    this.deps.queue.enqueue(tx, {
      type: STEP_JOB,
      input: { taskId, step },
      idempotencyKey: `${STEP_JOB}:${taskId}:${step}:${newId()}`,
      maxAttempts: 1,
    });
  }

  private mustGet(id: string): EngineeringTaskDetail {
    const d = this.get(id);
    if (!d) throw new EngineeringTaskError("not_found");
    return d;
  }

  private repoExists(id: string): boolean {
    return (
      this.deps.db
        .select({ id: repositories.id })
        .from(repositories)
        .where(eq(repositories.id, id))
        .get() !== undefined
    );
  }

  private environments(tx: DbOrTx, repoId: string) {
    return tx
      .select()
      .from(repositoryEnvironments)
      .where(eq(repositoryEnvironments.repositoryId, repoId))
      .all();
  }

  /** The given repository, else the only one mapped to the Jira project, else the only one. */
  private resolveRepository(given: string | undefined, jiraProjectKey: string | null): string {
    if (given !== undefined) {
      if (!this.repoExists(given)) throw new EngineeringTaskError("not_found");
      return given;
    }
    const all = this.deps.db
      .select({ id: repositories.id, keys: repositories.jiraProjectKeys })
      .from(repositories)
      .all();
    if (jiraProjectKey !== null) {
      const mapped = all.filter((r) => r.keys.includes(jiraProjectKey));
      if (mapped.length === 1 && mapped[0]) return mapped[0].id;
    }
    if (all.length === 1 && all[0]) return all[0].id;
    throw new EngineeringTaskError("repository_required");
  }
}
