import type {
  EngineeringStep,
  EngineeringStepStatus,
  EngineeringTaskDetail,
  EngineeringTaskStatus,
  EngineeringTaskStepView,
  EngineeringTaskView,
  InvestigationOutput,
} from "@synapse/contracts";
import { type DbOrTx, schema } from "@synapse/database";
import { type Clock, isoNow, newId } from "@synapse/shared";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { EventPublisher } from "../../core/events/publisher";

const { engineeringTasks, engineeringTaskSteps } = schema;

export type TaskRow = typeof engineeringTasks.$inferSelect;
export type StepRow = typeof engineeringTaskSteps.$inferSelect;
type TaskPatch = Partial<Omit<TaskRow, "id" | "status" | "createdAt" | "updatedAt">>;

export const ENGINEERING_TASK_ERROR_CODES = [
  "not_found",
  "invalid_input",
  "invalid_state",
  "repository_required",
  "no_content",
  "unknown_branch",
  "unknown_environment",
  "protected_branch",
  "unsafe_test_command",
  "path_unavailable",
] as const;
/** `registry_error:<RegistryErrorCode>` wraps a refusal of the repository registry. */
export type EngineeringTaskErrorCode =
  | (typeof ENGINEERING_TASK_ERROR_CODES)[number]
  | `registry_error:${string}`;

/** A refused call. The message is the fixed code only: never a branch, path or any task text. */
export class EngineeringTaskError extends Error {
  constructor(readonly code: EngineeringTaskErrorCode) {
    super(`engineering task: ${code}`);
    this.name = "EngineeringTaskError";
  }
}

export const TERMINAL_STATUSES: readonly EngineeringTaskStatus[] = [
  "completed",
  "failed",
  "cancelled",
];

/** Statuses during which the task holds (or may hold) the global engineering lock (E6). */
export const ACTIVE_STATUSES: readonly EngineeringTaskStatus[] = [
  "in_progress",
  "awaiting_approval",
];

/**
 * The task state machine (E1–E6, E15, E16). `investigating → proposed` is a failed investigation
 * (the user edits the description and re-approves); `planned → investigating` is a
 * re-investigation. `approved` is kept for a future two-step approval; plan approval goes straight
 * to `queued`. A terminal status moves on only to `needs_attention`, and only from the cleanup
 * step: the local cleanup found a dirty tree, so the task keeps the lock until the user tidies up
 * and cancels again (which re-runs cleanup). The one exception is `cancelled → completed`: the PR
 * merged while the cancel was being recorded (M5, `merged_after_cancel`).
 */
export const ALLOWED_TRANSITIONS: Readonly<
  Record<EngineeringTaskStatus, readonly EngineeringTaskStatus[]>
> = {
  proposed: ["investigating", "cancelled"],
  investigating: ["planned", "proposed", "cancelled"],
  planned: ["investigating", "approved", "queued", "cancelled"],
  approved: ["queued", "cancelled"],
  queued: ["in_progress", "needs_attention", "cancelled"],
  in_progress: ["awaiting_approval", "completed", "failed", "cancelled", "needs_attention"],
  awaiting_approval: ["in_progress", "completed", "failed", "cancelled", "needs_attention"],
  needs_attention: [
    "queued",
    "in_progress",
    "awaiting_approval",
    "failed",
    "cancelled",
    "completed",
  ],
  completed: ["needs_attention"],
  failed: ["needs_attention"],
  // M5: a PR that merged while the cancel was being recorded makes the task completed.
  cancelled: ["needs_attention", "completed"],
};

export function canTransition(from: EngineeringTaskStatus, to: EngineeringTaskStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** Statuses that would resume work on a task. */
const RESUMING: readonly EngineeringTaskStatus[] = ["queued", "in_progress", "awaiting_approval"];

/**
 * The terminal status a `needs_attention` task had before its cleanup found a dirty tree (the
 * cleanup step's `output.priorStatus`), or null when it was never terminal.
 */
export function priorTerminalStatus(tx: DbOrTx, taskId: string): EngineeringTaskStatus | null {
  const row = tx
    .select({ output: engineeringTaskSteps.output })
    .from(engineeringTaskSteps)
    .where(and(eq(engineeringTaskSteps.taskId, taskId), eq(engineeringTaskSteps.step, "cleanup")))
    .get();
  const prior = (row?.output as { priorStatus?: unknown } | null)?.priorStatus;
  return typeof prior === "string" && TERMINAL_STATUSES.includes(prior as EngineeringTaskStatus)
    ? (prior as EngineeringTaskStatus)
    : null;
}

/** M8: the failure reason a task had when its cleanup failed (`output.priorFailure`), or null. */
export function priorFailureOf(tx: DbOrTx, taskId: string): string | null {
  const row = tx
    .select({ output: engineeringTaskSteps.output })
    .from(engineeringTaskSteps)
    .where(and(eq(engineeringTaskSteps.taskId, taskId), eq(engineeringTaskSteps.step, "cleanup")))
    .get();
  const f = (row?.output as { priorFailure?: unknown } | null)?.priorFailure;
  return typeof f === "string" ? f : null;
}

export function toView(r: TaskRow): EngineeringTaskView {
  return {
    id: r.id,
    repositoryId: r.repositoryId,
    environmentId: r.environmentId,
    source: r.source,
    sourceRef: r.sourceRef,
    title: r.title,
    status: r.status,
    currentStep: r.currentStep,
    parentBranch: r.parentBranch,
    taskBranch: r.taskBranch,
    prUrl: r.prUrl,
    prNumber: r.prNumber,
    failure: r.failure,
    lastPickupError: r.lastPickupError,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function toStepView(s: StepRow): EngineeringTaskStepView {
  return {
    id: s.id,
    step: s.step,
    status: s.status,
    approvalId: s.approvalId,
    claudeRunId: s.claudeRunId,
    output: s.output ?? null,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

const STEP_ORDER: readonly EngineeringStep[] = [
  "investigate",
  "branch",
  "develop",
  "commit",
  "update_parent",
  "merge_local",
  "push_pr",
  "merge_pr",
  "cleanup",
];

/**
 * Rows of `engineering_tasks` and `engineering_task_steps`. Every status change goes through
 * `transition` (checked against ALLOWED_TRANSITIONS, conditional on the status read) and every
 * step change through `upsertStep`; both publish their event with ids and enums only.
 */
export class EngineeringTaskStore {
  constructor(private readonly deps: { clock: Clock; events: Pick<EventPublisher, "publish"> }) {}

  insert(
    tx: DbOrTx,
    v: Pick<TaskRow, "repositoryId" | "source" | "sourceRef" | "title" | "draftDescription">,
  ): TaskRow {
    const now = isoNow(this.deps.clock);
    const row = tx
      .insert(engineeringTasks)
      .values({ id: newId(), ...v, status: "proposed", createdAt: now, updatedAt: now })
      .returning()
      .get();
    this.deps.events.publish(tx, {
      type: "engineering.task_created",
      aggregateType: "engineering_task",
      aggregateId: row.id,
      correlationId: newId(),
      payload: { taskId: row.id },
    });
    return row;
  }

  get(tx: DbOrTx, id: string): TaskRow | null {
    return tx.select().from(engineeringTasks).where(eq(engineeringTasks.id, id)).get() ?? null;
  }

  /**
   * Moves the task to `to` when its current status is one of `from` (any status when omitted) and
   * the move is allowed; applies `patch` in the same update. Throws `not_found` or `invalid_state`.
   */
  transition(
    tx: DbOrTx,
    id: string,
    to: EngineeringTaskStatus,
    patch: TaskPatch = {},
    from?: readonly EngineeringTaskStatus[],
  ): TaskRow {
    const current = this.get(tx, id);
    if (!current) throw new EngineeringTaskError("not_found");
    if (from && !from.includes(current.status)) throw new EngineeringTaskError("invalid_state");
    if (!canTransition(current.status, to)) throw new EngineeringTaskError("invalid_state");
    if (current.status === "needs_attention") {
      // A task that already ended (its cleanup failed) never resumes; it is closed as
      // `completed` or `failed` again only with the outcome it had (after a successful
      // re-cleanup, M8).
      const prior = priorTerminalStatus(tx, id);
      if (prior && RESUMING.includes(to)) throw new EngineeringTaskError("invalid_state");
      if (to === "completed" && prior !== "completed") {
        throw new EngineeringTaskError("invalid_state");
      }
      if (to === "failed" && prior && prior !== "failed") {
        throw new EngineeringTaskError("invalid_state");
      }
    }
    const row = tx
      .update(engineeringTasks)
      .set({ ...patch, status: to, updatedAt: isoNow(this.deps.clock) })
      .where(and(eq(engineeringTasks.id, id), eq(engineeringTasks.status, current.status)))
      .returning()
      .get();
    if (!row) throw new EngineeringTaskError("invalid_state");
    this.deps.events.publish(tx, {
      type: "engineering.task_status_changed",
      aggregateType: "engineering_task",
      aggregateId: id,
      correlationId: newId(),
      payload: { taskId: id, status: to },
    });
    return row;
  }

  /** Field changes that keep the status (no event). */
  update(tx: DbOrTx, id: string, patch: TaskPatch): void {
    tx.update(engineeringTasks)
      .set({ ...patch, updatedAt: isoNow(this.deps.clock) })
      .where(eq(engineeringTasks.id, id))
      .run();
  }

  /**
   * Creates or updates the task's one row for `step` (unique on task and step: a re-run updates
   * it). Fields left out keep their value on update; `output`, `claudeRunId` and `approvalId` can
   * be reset with null.
   */
  upsertStep(
    tx: DbOrTx,
    taskId: string,
    step: EngineeringStep,
    status: EngineeringStepStatus,
    fields: Partial<Pick<StepRow, "output" | "claudeRunId" | "approvalId">> = {},
  ): void {
    const now = isoNow(this.deps.clock);
    tx.insert(engineeringTaskSteps)
      .values({
        id: newId(),
        taskId,
        step,
        status,
        approvalId: fields.approvalId ?? null,
        claudeRunId: fields.claudeRunId ?? null,
        output: fields.output ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [engineeringTaskSteps.taskId, engineeringTaskSteps.step],
        set: { ...fields, status, updatedAt: now },
      })
      .run();
    this.deps.events.publish(tx, {
      type: "engineering.step_changed",
      aggregateType: "engineering_task",
      aggregateId: taskId,
      correlationId: newId(),
      payload: { taskId, step, status },
    });
  }

  steps(tx: DbOrTx, taskId: string): StepRow[] {
    return tx
      .select()
      .from(engineeringTaskSteps)
      .where(eq(engineeringTaskSteps.taskId, taskId))
      .all()
      .sort((a, b) => STEP_ORDER.indexOf(a.step) - STEP_ORDER.indexOf(b.step));
  }

  /** E6: the next task to pick up: highest priority, then oldest. */
  nextQueued(tx: DbOrTx): TaskRow | null {
    return (
      tx
        .select()
        .from(engineeringTasks)
        .where(eq(engineeringTasks.status, "queued"))
        .orderBy(
          desc(engineeringTasks.priority),
          asc(engineeringTasks.createdAt),
          sql`${engineeringTasks}.rowid asc`,
        )
        .limit(1)
        .get() ?? null
    );
  }

  list(tx: DbOrTx, status?: EngineeringTaskStatus): TaskRow[] {
    const q = tx.select().from(engineeringTasks);
    return (status ? q.where(eq(engineeringTasks.status, status)) : q)
      .orderBy(desc(engineeringTasks.createdAt), sql`${engineeringTasks}.rowid desc`)
      .all();
  }

  detail(tx: DbOrTx, id: string): EngineeringTaskDetail | null {
    const r = this.get(tx, id);
    if (!r) return null;
    return {
      ...toView(r),
      draftDescription: r.draftDescription,
      approvedDescription: r.approvedDescription,
      plan: (r.plan as InvestigationOutput | null) ?? null,
      baseSha: r.baseSha,
      mergeSha: r.mergeSha,
      steps: this.steps(tx, id).map(toStepView),
    };
  }
}
