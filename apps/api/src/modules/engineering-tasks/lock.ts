import type {
  EngineeringStep,
  EngineeringTaskStatus,
  GitWorkflow,
  LockView,
} from "@synapse/contracts";
import { GitWorkflowError } from "@synapse/contracts";
import { type Db, schema } from "@synapse/database";
import { type Clock, newId } from "@synapse/shared";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { ApprovalEngine } from "../../core/approvals/approvals";
import { APPROVAL_EXECUTE_JOB } from "../../core/approvals/execution";
import type { AuditLogger } from "../../core/audit/audit";
import type { SettingsService } from "../../core/config/settings";
import type { EventPublisher } from "../../core/events/publisher";
import type { JobQueue } from "../../core/jobs/queue";
import type { LeaseService } from "../../core/leases/leases";
import { ACTIVE_STATUSES, EngineeringTaskStore, TERMINAL_STATUSES } from "./store";

const { engineeringTasks, engineeringTaskSteps, repositories, jobs, approvals } = schema;
/** `targetIntegration` of engineering approvals (see steps.ts ENGINEERING_INTEGRATION). */
const ENGINEERING_INTEGRATION = "engineering";
const MODULE = "engineering-tasks";

/** ADR-030: the one global engineering lease. Startup recovery never releases it (core). */
export const ENGINEERING_LEASE = "engineering";
/** The `engineering.step` job type (the step runner, Phase 10 Task 5). */
export const STEP_JOB = "engineering.step";
const HOLDER_PREFIX = "task:";
const LIVE_JOB_STATUSES = ["PENDING", "RETRY", "RUNNING"] as const;
/** Jobs that will still run after a restart (a RUNNING one belonged to the dead process). */
const WAITING_JOB_STATUSES = ["PENDING", "RETRY"] as const;
/** Statuses before plan approval: such a task can never hold the lock (corrupt state). */
const PRE_QUEUE: readonly EngineeringTaskStatus[] = [
  "proposed",
  "investigating",
  "planned",
  "approved",
];

export const holderOf = (taskId: string) => `${HOLDER_PREFIX}${taskId}`;

export interface LockHolder {
  /** Null when the holder string is not `task:<id>`. */
  taskId: string | null;
  holder: string;
  since: string;
  expiresAt: string;
  expired: boolean;
}

export type RecoveryResult =
  | { action: "none" }
  | { action: "resumed"; taskId: string }
  | { action: "released"; taskId: string | null }
  | { action: "kept"; taskId: string }
  | { action: "needs_attention"; taskId: string; reason: string };

export interface EngineeringLockDeps {
  db: Db;
  clock: Clock;
  leases: LeaseService;
  settings: Pick<SettingsService, "get">;
  events: Pick<EventPublisher, "publish">;
  audit: Pick<AuditLogger, "record">;
  git: Pick<
    GitWorkflow,
    "localState" | "diffSummary" | "configFingerprint" | "gitDirFingerprint" | "branchExists"
  >;
  /** Re-drives an idempotent step after a restart (E6 "resumed"). */
  queue: Pick<JobQueue, "enqueue">;
  /** Expires the open approvals of a task that recovery sends to needs_attention. */
  approvals: Pick<ApprovalEngine, "expireAsSystem">;
}

/**
 * The global engineering lock (E6, ADR-030) over the `engineering` lease, holder `task:<id>`.
 * An existing lease row means the lock is held, even once expired: an expired lease is a crash
 * that startup recovery must look at, never a free lock. Audit rows and events carry ids only.
 */
export class EngineeringLock {
  private readonly store: EngineeringTaskStore;

  constructor(private readonly deps: EngineeringLockDeps) {
    this.store = new EngineeringTaskStore(deps);
  }

  private ttlMs(): number {
    return this.deps.settings.get("engineering.lock.ttlMinutes") * 60_000;
  }

  holder(): LockHolder | null {
    const l = this.deps.leases.get(ENGINEERING_LEASE);
    if (!l) return null;
    return {
      taskId: l.holder.startsWith(HOLDER_PREFIX) ? l.holder.slice(HOLDER_PREFIX.length) : null,
      holder: l.holder,
      since: l.acquiredAt,
      expiresAt: l.expiresAt,
      expired: l.expiresAt <= this.deps.clock.now().toISOString(),
    };
  }

  view(): LockView {
    const h = this.holder();
    if (!h) return { held: false };
    return { held: true, ...(h.taskId ? { taskId: h.taskId } : {}), since: h.since };
  }

  /** Takes the lock for `taskId` unless any other holder has a lease row, expired or not. */
  acquire(taskId: string): boolean {
    const current = this.holder();
    if (current && current.holder !== holderOf(taskId)) return false;
    const ok = this.deps.leases.acquire(ENGINEERING_LEASE, holderOf(taskId), this.ttlMs());
    if (ok && !current) this.lockChanged(true, "engineering.lock_acquired", taskId);
    return ok;
  }

  /**
   * The 2-minute tick: extends the current holder's lease while its task is `in_progress` or
   * `awaiting_approval`. A `needs_attention` task's lease expires but is kept (it keeps blocking
   * others until the user resolves it). A terminal task whose lease expired and that has no live
   * step job and no running executor is looked at (M3): its cleanup done (or skipped for a changed
   * config, which releases) → released; its cleanup never ran → the cleanup step is enqueued (it
   * releases on success); its cleanup started but died (`running` with no live job) → the task
   * goes to `needs_attention` (`cleanup_incomplete`) with its prior outcome kept, lock kept.
   */
  renew(): boolean {
    const h = this.holder();
    if (!h?.taskId) return false;
    const task = this.store.get(this.deps.db, h.taskId);
    if (task && TERMINAL_STATUSES.includes(task.status)) {
      if (h.expired && !this.liveStepJob(task.id) && !this.executingApproval(task.id)) {
        const cleanup = this.cleanupState(task.id);
        if (cleanup === "settled") this.release(task.id);
        else if (cleanup === "missing") this.enqueueCleanup(task.id);
        else this.cleanupIncomplete(task.id, task.status);
      }
      return false;
    }
    if (!task || !ACTIVE_STATUSES.includes(task.status)) return false;
    // Same holder: LeaseService.acquire extends it even when it lapsed (system sleep).
    return this.deps.leases.acquire(ENGINEERING_LEASE, h.holder, this.ttlMs());
  }

  release(taskId: string): boolean {
    const ok = this.deps.leases.release(ENGINEERING_LEASE, holderOf(taskId));
    if (ok) this.lockChanged(false, "engineering.lock_released", taskId);
    return ok;
  }

  /**
   * Startup recovery (E6). Runs once at boot, after the API port is bound and before the worker
   * starts, for any lease row: at boot every lease belongs to a process that is gone, so a fast
   * restart (lease not yet expired) is checked exactly like an expired one.
   * - No task, or an unparseable holder: released.
   * - A terminal task: kept while a step job (its cleanup) is queued or running; kept with its
   *   cleanup step enqueued when that cleanup never finished (M3); otherwise released.
   * - A `needs_attention` task: kept as it is.
   * - A task before plan approval (corrupt state) or `queued` (crash between acquire and pickup;
   *   Synapse never touched the tree): released, so pickup can start it again.
   * - `awaiting_approval` at `commit`: the tree is dirty by design. Resumed (approval left
   *   pending) when the config fingerprint and the diff hash still equal the ones the approval
   *   shows; otherwise `needs_attention` (`config_changed`, `unsafe_change` or `diff_changed`).
   * - Otherwise the repository is checked locally (`GitWorkflow.localState`, I1: no remote is
   *   contacted, so a boot without network never strands a task): a dirty tree, a merge in
   *   progress or a repository that is no longer the registered top level sets `needs_attention`
   *   (reason in `failure`) and the lease is kept. Clean and `awaiting_approval`: resumed. Clean and
   *   `in_progress`: the current step is re-driven when that is safe (`branch` while the task
   *   branch doesn't exist, `develop` while the git dir is untouched, `update_parent`), else
   *   `needs_attention` with `resume_unsafe`.
   */
  async recover(): Promise<RecoveryResult> {
    const h = this.holder();
    if (!h) return { action: "none" };
    const { db } = this.deps;
    const task = h.taskId ? this.store.get(db, h.taskId) : null;
    if (!task) {
      this.deps.leases.release(ENGINEERING_LEASE, h.holder);
      this.lockChanged(false, "engineering.lock_recovered", h.taskId, { action: "released" });
      return { action: "released", taskId: h.taskId };
    }
    if (TERMINAL_STATUSES.includes(task.status)) {
      if (this.liveStepJob(task.id)) return this.kept(task.id);
      // M3: a cleanup that never ran, or that the restart interrupted, is run (once) now.
      if (this.cleanupState(task.id) !== "settled") {
        this.enqueueCleanup(task.id);
        return this.kept(task.id);
      }
      this.release(task.id);
      return { action: "released", taskId: task.id };
    }
    if (task.status === "needs_attention") return this.kept(task.id);
    if (task.status === "queued" || PRE_QUEUE.includes(task.status)) {
      this.release(task.id);
      return { action: "released", taskId: task.id };
    }

    if (task.status === "awaiting_approval" && task.currentStep === "commit") {
      const reason = await this.commitResumeProblem(task);
      return reason ? this.needsAttention(task.id, reason) : this.resumed(h.holder, task.id);
    }
    const reason = await this.treeProblem(task);
    if (reason) return this.needsAttention(task.id, reason);
    if (task.status === "awaiting_approval") return this.resumed(h.holder, task.id);

    const step = await this.redriveStep(task);
    if (!step) return this.needsAttention(task.id, "resume_unsafe");
    const result = this.resumed(h.holder, task.id);
    if (!this.waitingStepJob(task.id, step)) {
      this.deps.queue.enqueue(db, {
        type: STEP_JOB,
        input: { taskId: task.id, step },
        idempotencyKey: `${STEP_JOB}:${task.id}:${step}:${newId()}`,
        maxAttempts: 1,
      });
    }
    return result;
  }

  private resumed(holder: string, taskId: string): RecoveryResult {
    this.deps.leases.acquire(ENGINEERING_LEASE, holder, this.ttlMs());
    this.lockChanged(true, "engineering.lock_recovered", taskId, { action: "resumed" });
    return { action: "resumed", taskId };
  }

  private needsAttention(taskId: string, reason: string): RecoveryResult {
    this.deps.db.transaction(
      (tx) => {
        this.store.transition(tx, taskId, "needs_attention", { failure: reason }, [
          "in_progress",
          "awaiting_approval",
        ]);
        // A pending step approval (e.g. the commit) no longer shows what is on disk.
        const open = tx
          .select({ id: approvals.id })
          .from(approvals)
          .where(
            and(
              eq(approvals.targetIntegration, ENGINEERING_INTEGRATION),
              eq(approvals.targetRef, taskId),
              inArray(approvals.status, ["pending", "approved"]),
              isNull(approvals.executionStartedAt),
            ),
          )
          .all();
        for (const a of open) this.deps.approvals.expireAsSystem(tx, a.id, reason);
        this.deps.audit.record(tx, {
          actor: "system",
          module: MODULE,
          action: "engineering.lock_recovered",
          workerProfile: "engineering",
          targetRef: taskId,
          result: "needs_attention",
          details: { taskId, reason },
        });
      },
      { behavior: "immediate" },
    );
    return { action: "needs_attention", taskId, reason };
  }

  private stepOutput(taskId: string, step: EngineeringStep): Record<string, unknown> | null {
    const row = this.deps.db
      .select({ output: engineeringTaskSteps.output })
      .from(engineeringTaskSteps)
      .where(and(eq(engineeringTaskSteps.taskId, taskId), eq(engineeringTaskSteps.step, step)))
      .get();
    const out = row?.output;
    return out && typeof out === "object" ? (out as Record<string, unknown>) : null;
  }

  private repoPath(task: typeof engineeringTasks.$inferSelect): string | null {
    return (
      this.deps.db
        .select({ localPath: repositories.localPath })
        .from(repositories)
        .where(eq(repositories.id, task.repositoryId))
        .get()?.localPath ?? null
    );
  }

  /** Null when the pending commit approval still shows exactly the tree and config on disk. */
  private async commitResumeProblem(
    task: typeof engineeringTasks.$inferSelect,
  ): Promise<string | null> {
    const path = this.repoPath(task);
    if (!path) return "not_a_repository";
    const out = this.stepOutput(task.id, "commit");
    const diffHash = out?.diffHash;
    const baseline = out?.gitDirBaseline;
    const fp = out?.configFingerprint;
    if (typeof diffHash !== "string" || typeof baseline !== "string" || typeof fp !== "string") {
      return "resume_unsafe";
    }
    try {
      // Config first: a changed config could name a filter that `git status` would run.
      if ((await this.deps.git.configFingerprint(path)) !== fp) return "config_changed";
      const d = await this.deps.git.diffSummary(path, { gitDirBaseline: baseline });
      if (d.unsafe) return "unsafe_change";
      return d.hash === diffHash ? null : "diff_changed";
    } catch (e) {
      return e instanceof GitWorkflowError ? e.code : "git_failed";
    }
  }

  /** The step to enqueue again for a clean `in_progress` task, or null when that is unsafe. */
  private async redriveStep(
    task: typeof engineeringTasks.$inferSelect,
  ): Promise<"branch" | "develop" | "update_parent" | null> {
    const path = this.repoPath(task);
    if (!path || !task.taskBranch) return null;
    try {
      switch (task.currentStep) {
        case "branch":
          return (await this.deps.git.branchExists(path, task.taskBranch)) ? null : "branch";
        case "develop": {
          // The tree is clean (checked before); a write into .git shows only in the fingerprint.
          const baseline = this.stepOutput(task.id, "develop")?.gitDirBaseline;
          if (
            typeof baseline === "string" &&
            (await this.deps.git.gitDirFingerprint(path)) !== baseline
          ) {
            return null;
          }
          return "develop";
        }
        case "update_parent":
          return "update_parent";
        default:
          return null;
      }
    } catch {
      return null;
    }
  }

  /** The E7 tree checks that matter after a crash, local only (I1); null when the tree is as Synapse left it. */
  private async treeProblem(task: typeof engineeringTasks.$inferSelect): Promise<string | null> {
    const path = this.repoPath(task);
    if (!path) return "not_a_repository";
    if (!task.parentBranch) return "invalid_state";
    try {
      const r = await this.deps.git.localState(path);
      return r.ok ? null : r.reason;
    } catch (e) {
      return e instanceof GitWorkflowError ? e.code : "git_failed";
    }
  }

  /**
   * M3: where a terminal task's cleanup stands. `settled`: done, or skipped for a changed config
   * (that skip releases the lock); `missing`: not run since the task ended (no row, pending,
   * failed on an earlier attempt, or skipped while another task held the lock); `died`: started
   * (`running`) but its job is gone.
   */
  private cleanupState(taskId: string): "settled" | "missing" | "died" {
    const row = this.deps.db
      .select({ status: engineeringTaskSteps.status, output: engineeringTaskSteps.output })
      .from(engineeringTaskSteps)
      .where(and(eq(engineeringTaskSteps.taskId, taskId), eq(engineeringTaskSteps.step, "cleanup")))
      .get();
    if (!row) return "missing";
    if (row.status === "done") return "settled";
    const reason = (row.output as { reason?: unknown } | null)?.reason;
    if (row.status === "skipped" && reason === "config_changed") return "settled";
    if (row.status === "running") return "died";
    return "missing";
  }

  private enqueueCleanup(taskId: string): void {
    this.deps.db.transaction((tx) => {
      this.deps.queue.enqueue(tx, {
        type: STEP_JOB,
        input: { taskId, step: "cleanup" },
        idempotencyKey: `${STEP_JOB}:${taskId}:cleanup:${newId()}`,
        maxAttempts: 1,
      });
      this.deps.audit.record(tx, {
        actor: "system",
        module: MODULE,
        action: "engineering.cleanup_requeued",
        workerProfile: "engineering",
        targetRef: taskId,
        result: "ok",
        details: { taskId },
      });
    });
  }

  /** M3: a terminal task whose cleanup died cannot be cleaned by the tick; the user decides. */
  private cleanupIncomplete(taskId: string, prior: EngineeringTaskStatus): void {
    const reason = "cleanup_incomplete";
    this.deps.db.transaction(
      (tx) => {
        const priorFailure = this.store.get(tx, taskId)?.failure ?? null;
        this.store.transition(tx, taskId, "needs_attention", { failure: reason }, [prior]);
        this.store.upsertStep(tx, taskId, "cleanup", "failed", {
          output: {
            failure: reason,
            priorStatus: prior,
            ...(priorFailure ? { priorFailure } : {}),
          },
        });
        this.deps.audit.record(tx, {
          actor: "system",
          module: MODULE,
          action: "engineering.cleanup_failed",
          workerProfile: "engineering",
          targetRef: taskId,
          result: "needs_attention",
          details: { taskId, reason },
        });
      },
      { behavior: "immediate" },
    );
  }

  private kept(taskId: string): RecoveryResult {
    this.deps.db.transaction((tx) => {
      this.deps.audit.record(tx, {
        actor: "system",
        module: MODULE,
        action: "engineering.lock_recovered",
        workerProfile: "engineering",
        targetRef: taskId,
        result: "kept",
        details: { taskId, action: "kept" },
      });
    });
    return { action: "kept", taskId };
  }

  private waitingStepJob(taskId: string, step: string): boolean {
    return (
      this.deps.db
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.type, STEP_JOB),
            inArray(jobs.status, [...WAITING_JOB_STATUSES]),
            sql`json_extract(${jobs.input}, '$.taskId') = ${taskId}`,
            sql`json_extract(${jobs.input}, '$.step') = ${step}`,
          ),
        )
        .limit(1)
        .get() !== undefined
    );
  }

  /** An `approval.execute` job is running an engineering approval of this task right now. */
  private executingApproval(taskId: string): boolean {
    return (
      this.deps.db
        .select({ id: jobs.id })
        .from(jobs)
        .innerJoin(approvals, sql`${approvals.id} = json_extract(${jobs.input}, '$.approvalId')`)
        .where(
          and(
            eq(jobs.type, APPROVAL_EXECUTE_JOB),
            eq(jobs.status, "RUNNING"),
            eq(approvals.targetIntegration, ENGINEERING_INTEGRATION),
            eq(approvals.targetRef, taskId),
          ),
        )
        .limit(1)
        .get() !== undefined
    );
  }

  liveStepJob(taskId: string): boolean {
    return (
      this.deps.db
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.type, STEP_JOB),
            inArray(jobs.status, [...LIVE_JOB_STATUSES]),
            sql`json_extract(${jobs.input}, '$.taskId') = ${taskId}`,
          ),
        )
        .limit(1)
        .get() !== undefined
    );
  }

  private lockChanged(
    held: boolean,
    action: string,
    taskId: string | null,
    details: Record<string, unknown> = {},
  ): void {
    this.deps.db.transaction((tx) => {
      this.deps.events.publish(tx, {
        type: "engineering.lock_changed",
        aggregateType: "engineering_lock",
        aggregateId: ENGINEERING_LEASE,
        correlationId: newId(),
        payload: { held },
      });
      this.deps.audit.record(tx, {
        actor: "system",
        module: MODULE,
        action,
        workerProfile: "engineering",
        targetRef: taskId ?? undefined,
        result: "ok",
        details: { taskId, held, ...details },
      });
    });
  }
}
