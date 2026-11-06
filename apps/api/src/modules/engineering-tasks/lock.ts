import type { GitWorkflow, LockView } from "@synapse/contracts";
import { GitWorkflowError } from "@synapse/contracts";
import { type Db, schema } from "@synapse/database";
import { type Clock, newId } from "@synapse/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { AuditLogger } from "../../core/audit/audit";
import type { SettingsService } from "../../core/config/settings";
import type { EventPublisher } from "../../core/events/publisher";
import type { LeaseService } from "../../core/leases/leases";
import { ACTIVE_STATUSES, EngineeringTaskStore, TERMINAL_STATUSES } from "./store";

const { engineeringTasks, repositories, jobs } = schema;
const MODULE = "engineering-tasks";

/** ADR-030: the one global engineering lease. Startup recovery never releases it (core). */
export const ENGINEERING_LEASE = "engineering";
/** The `engineering.step` job type (the step runner, Phase 10 Task 5). */
export const STEP_JOB = "engineering.step";
const HOLDER_PREFIX = "task:";
const LIVE_JOB_STATUSES = ["PENDING", "RETRY", "RUNNING"] as const;
/** Preflight results that mean the tree is not as Synapse left it (E6). */
const UNSAFE_TREE = new Set(["dirty_tree", "merge_in_progress", "not_a_repository"]);

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
  git: Pick<GitWorkflow, "preflight">;
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
   * `awaiting_approval`. A task in any other status is left alone, so its lease expires but is
   * kept (a `needs_attention` task keeps blocking others until the user resolves it).
   */
  renew(): boolean {
    const h = this.holder();
    if (!h?.taskId) return false;
    const task = this.store.get(this.deps.db, h.taskId);
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
   * Startup recovery (E6). Runs once at boot, before the worker starts, for any lease row: at
   * boot every lease belongs to a process that is gone, so a fast restart (lease not yet
   * expired) is checked exactly like an expired one.
   * - No task, or an unparseable holder: released.
   * - A terminal task: released unless a step job (its cleanup) is still queued or running.
   * - A `needs_attention` task: kept as it is.
   * - Otherwise the repository is checked as preflight does: a dirty tree, a merge in progress
   *   or a repository that is no longer the registered top level sets `needs_attention` (reason
   *   code in `failure`) and the lease is kept. A clean tree: a `queued` holder (crash between
   *   acquire and pickup) releases the lock so pickup starts it again; any other status
   *   re-acquires and the task resumes at its current step.
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
      this.release(task.id);
      return { action: "released", taskId: task.id };
    }
    if (task.status === "needs_attention") return this.kept(task.id);

    const reason = await this.treeProblem(task);
    if (reason) {
      db.transaction(
        (tx) => {
          this.store.transition(tx, task.id, "needs_attention", { failure: reason });
          this.deps.audit.record(tx, {
            actor: "system",
            module: MODULE,
            action: "engineering.lock_recovered",
            workerProfile: "engineering",
            targetRef: task.id,
            result: "needs_attention",
            details: { taskId: task.id, reason },
          });
        },
        { behavior: "immediate" },
      );
      return { action: "needs_attention", taskId: task.id, reason };
    }
    if (task.status === "queued") {
      this.release(task.id);
      return { action: "released", taskId: task.id };
    }
    this.deps.leases.acquire(ENGINEERING_LEASE, h.holder, this.ttlMs());
    this.lockChanged(true, "engineering.lock_recovered", task.id, { action: "resumed" });
    return { action: "resumed", taskId: task.id };
  }

  /** The E7 tree checks that matter after a crash; null when the tree is as Synapse left it. */
  private async treeProblem(task: typeof engineeringTasks.$inferSelect): Promise<string | null> {
    const repo = this.deps.db
      .select({ localPath: repositories.localPath })
      .from(repositories)
      .where(eq(repositories.id, task.repositoryId))
      .get();
    if (!repo) return "not_a_repository";
    if (!task.parentBranch) return "invalid_state";
    try {
      const r = await this.deps.git.preflight(repo.localPath, task.parentBranch, {
        allowUpstreamPush: true,
      });
      return !r.ok && UNSAFE_TREE.has(r.reason) ? r.reason : null;
    } catch (e) {
      return e instanceof GitWorkflowError ? e.code : "git_failed";
    }
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

  private liveStepJob(taskId: string): boolean {
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
