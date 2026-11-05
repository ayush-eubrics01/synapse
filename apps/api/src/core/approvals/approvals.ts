import type { Approval, ApprovalStatus, Operation, RiskLevel } from "@synapse/contracts";
import { type Db, type DbOrTx, schema } from "@synapse/database";
import { type Clock, isoNow, newId } from "@synapse/shared";
import { and, asc, eq, inArray, isNotNull, lte } from "drizzle-orm";
import type { AuditLogger } from "../audit/audit";
import type { EventPublisher } from "../events/publisher";
import type { PermissionManager } from "../permissions/permissions";

export type Executor = {
  execute(a: Approval): Promise<unknown>;
  revalidate?(a: Approval): Promise<boolean>;
};

export interface ApprovalRequest {
  action: Operation;
  targetIntegration: string;
  targetRef: string;
  payload: unknown;
  riskLevel: RiskLevel;
  idempotencyKey: string;
  requestedByModule: string;
  requestedByWorker?: string;
  expiresAt?: string;
}

export type ExecuteOutcome = { status: "executed" | "failed" | "skipped"; result?: unknown };

/** Thrown for a state change the approval lifecycle does not allow; the API maps it to 409. */
export class InvalidApprovalTransition extends Error {
  constructor(
    readonly approvalId: string,
    readonly from: ApprovalStatus | "missing",
    readonly to: ApprovalStatus,
  ) {
    super(`Invalid approval transition ${from} -> ${to} for ${approvalId}`);
    this.name = "InvalidApprovalTransition";
  }
}

const ALLOWED: Record<ApprovalStatus, readonly ApprovalStatus[]> = {
  pending: ["approved", "rejected", "expired"],
  approved: ["revoked", "expired", "executed", "failed"],
  rejected: [],
  expired: [],
  revoked: [],
  executed: [],
  failed: [],
};

type Row = typeof schema.approvals.$inferSelect;

function toApproval(r: Row): Approval {
  return {
    id: r.id,
    action: r.action as Operation,
    targetIntegration: r.targetIntegration ?? "",
    targetRef: r.targetRef ?? "",
    payload: r.payload,
    riskLevel: r.riskLevel as RiskLevel,
    status: r.status,
    requestedByModule: r.requestedByModule ?? "",
    requestedByWorker: r.requestedByWorker,
    expiresAt: r.expiresAt,
    decidedAt: r.decidedAt,
    executionResult: r.executionResult,
    idempotencyKey: r.idempotencyKey,
    createdAt: r.createdAt,
  };
}

type EventName =
  | "approval.approved"
  | "approval.rejected"
  | "approval.revoked"
  | "approval.expired"
  | "approval.executed";

export class ApprovalEngine {
  private readonly executors = new Map<Operation, Executor>();

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly events: EventPublisher,
    private readonly audit: AuditLogger,
    private readonly permissions: PermissionManager,
  ) {}

  registerExecutor(action: Operation, ex: Executor): void {
    this.executors.set(action, ex);
  }

  request(tx: DbOrTx, r: ApprovalRequest): Approval {
    const existing = tx
      .select()
      .from(schema.approvals)
      .where(eq(schema.approvals.idempotencyKey, r.idempotencyKey))
      .get();
    if (existing) return toApproval(existing);
    if (this.permissions.check(r.action) === "denied") {
      throw new Error(`Operation ${r.action} is denied by permission policy`);
    }
    const row = tx
      .insert(schema.approvals)
      .values({
        id: newId(),
        action: r.action,
        targetIntegration: r.targetIntegration,
        targetRef: r.targetRef,
        payload: r.payload,
        riskLevel: r.riskLevel,
        status: "pending",
        expiresAt: r.expiresAt,
        idempotencyKey: r.idempotencyKey,
        requestedByModule: r.requestedByModule,
        requestedByWorker: r.requestedByWorker,
        createdAt: isoNow(this.clock),
      })
      .returning()
      .get();
    this.events.publish(tx, {
      type: "approval.requested",
      aggregateType: "approval",
      aggregateId: row.id,
      correlationId: newId(),
      payload: { approvalId: row.id },
    });
    this.audit.record(tx, {
      actor: r.requestedByModule,
      module: "approvals",
      action: "approval.requested",
      workerProfile: r.requestedByWorker,
      targetIntegration: r.targetIntegration,
      targetRef: r.targetRef,
      approvalId: row.id,
      result: "pending",
      details: { operation: r.action, riskLevel: r.riskLevel },
    });
    return toApproval(row);
  }

  approve(id: string): Approval {
    return this.transition(id, "approved", "approval.approved", "user");
  }

  reject(id: string, reason: string): Approval {
    return this.transition(id, "rejected", "approval.rejected", "user", reason);
  }

  revoke(id: string, reason: string): Approval {
    return this.transition(id, "revoked", "approval.revoked", "user", reason);
  }

  expireDue(): number {
    return this.db.transaction(
      (tx) => {
        const now = isoNow(this.clock);
        const due = tx
          .select()
          .from(schema.approvals)
          .where(
            and(
              inArray(schema.approvals.status, ["pending", "approved"]),
              isNotNull(schema.approvals.expiresAt),
              lte(schema.approvals.expiresAt, now),
            ),
          )
          .orderBy(asc(schema.approvals.createdAt))
          .all()
          // an approval already claimed by execute() has started; it is not expired under it
          .filter((r) => r.executionStartedAt === null);
        for (const r of due) this.apply(tx, r, "expired", "approval.expired", "system");
        return due.length;
      },
      { behavior: "immediate" },
    );
  }

  listPending(): Approval[] {
    return this.db
      .select()
      .from(schema.approvals)
      .where(eq(schema.approvals.status, "pending"))
      .orderBy(asc(schema.approvals.createdAt), asc(schema.approvals.id))
      .all()
      .map(toApproval);
  }

  async execute(id: string): Promise<ExecuteOutcome> {
    const first = this.load(id);
    if (first.status === "executed") return { status: "executed", result: first.executionResult };
    const executor = this.executors.get(first.action as Operation);
    if (!executor) return this.skip(first, "no_executor");

    // Revalidation is async, so it runs before the claim; the claim re-checks everything.
    const pre = this.skipReason(first);
    if (pre) return this.skip(first, pre);
    if (executor.revalidate) {
      let ok = false;
      try {
        ok = await executor.revalidate(toApproval(first));
      } catch {
        ok = false;
      }
      if (!ok) return this.skip(first, "revalidation_failed");
    }

    const claimed = this.db.transaction<{ row: Row } | { reason: string }>(
      (tx) => {
        const row = tx.select().from(schema.approvals).where(eq(schema.approvals.id, id)).get();
        if (!row) return { reason: "missing" };
        const reason = this.skipReason(row);
        if (reason) return { reason };
        tx.update(schema.approvals)
          .set({ executionStartedAt: isoNow(this.clock) })
          .where(eq(schema.approvals.id, id))
          .run();
        return { row };
      },
      { behavior: "immediate" },
    );
    if (!("row" in claimed)) {
      const cur = this.load(id);
      if (cur.status === "executed") return { status: "executed", result: cur.executionResult };
      return this.skip(cur, claimed.reason);
    }

    const approval = toApproval(claimed.row);
    try {
      const result = (await executor.execute(approval)) ?? null;
      this.finish(id, "executed", result);
      return { status: "executed", result };
    } catch (e) {
      const error = { error: e instanceof Error ? e.message : String(e) };
      this.finish(id, "failed", error);
      return { status: "failed", result: error };
    }
  }

  private load(id: string): Row {
    const row = this.db.select().from(schema.approvals).where(eq(schema.approvals.id, id)).get();
    if (!row) throw new InvalidApprovalTransition(id, "missing", "approved");
    return row;
  }

  /** Why this row may not start executing now, or undefined if it may. */
  private skipReason(row: Row): string | undefined {
    if (row.status !== "approved") return `status_${row.status}`;
    if (row.executionStartedAt !== null) return "already_in_progress";
    if (row.expiresAt !== null && row.expiresAt <= isoNow(this.clock)) return "expired";
    if (this.permissions.check(row.action as Operation) === "denied") return "permission_denied";
    return undefined;
  }

  private skip(row: Row, reason: string): ExecuteOutcome {
    this.audit.record(this.db, {
      actor: "system",
      module: "approvals",
      action: "approval.execution_skipped",
      targetIntegration: row.targetIntegration ?? undefined,
      targetRef: row.targetRef ?? undefined,
      approvalId: row.id,
      result: "skipped",
      details: { reason },
    });
    return { status: "skipped" };
  }

  private finish(id: string, to: "executed" | "failed", result: unknown): void {
    this.db.transaction(
      (tx) => {
        const row = tx.select().from(schema.approvals).where(eq(schema.approvals.id, id)).get();
        if (!row || !ALLOWED[row.status].includes(to)) {
          throw new InvalidApprovalTransition(id, row?.status ?? "missing", to);
        }
        tx.update(schema.approvals)
          .set({ status: to, executionResult: result })
          .where(eq(schema.approvals.id, id))
          .run();
        if (to === "executed") {
          this.events.publish(tx, {
            type: "approval.executed",
            aggregateType: "approval",
            aggregateId: id,
            correlationId: newId(),
            payload: { approvalId: id },
          });
        }
        this.audit.record(tx, {
          actor: "system",
          module: "approvals",
          action: `approval.${to}`,
          targetIntegration: row.targetIntegration ?? undefined,
          targetRef: row.targetRef ?? undefined,
          approvalId: id,
          result: to,
          details: to === "failed" ? (result as Record<string, unknown>) : undefined,
        });
      },
      { behavior: "immediate" },
    );
  }

  private transition(
    id: string,
    to: ApprovalStatus,
    event: EventName,
    actor: string,
    reason?: string,
  ): Approval {
    return this.db.transaction(
      (tx) => {
        const row = tx.select().from(schema.approvals).where(eq(schema.approvals.id, id)).get();
        if (!row || !ALLOWED[row.status].includes(to)) {
          throw new InvalidApprovalTransition(id, row?.status ?? "missing", to);
        }
        // Once execute() has claimed it, it can no longer be revoked or expired.
        if (row.executionStartedAt !== null)
          throw new InvalidApprovalTransition(id, row.status, to);
        if (to === "approved" && row.expiresAt !== null && row.expiresAt <= isoNow(this.clock)) {
          throw new InvalidApprovalTransition(id, row.status, to);
        }
        return this.apply(tx, row, to, event, actor, reason);
      },
      { behavior: "immediate" },
    );
  }

  private apply(
    tx: DbOrTx,
    row: Row,
    to: ApprovalStatus,
    event: EventName,
    actor: string,
    reason?: string,
  ): Approval {
    const updated = tx
      .update(schema.approvals)
      .set({ status: to, decidedAt: isoNow(this.clock) })
      .where(eq(schema.approvals.id, row.id))
      .returning()
      .get();
    this.events.publish(tx, {
      type: event,
      aggregateType: "approval",
      aggregateId: row.id,
      correlationId: newId(),
      payload: { approvalId: row.id },
    });
    this.audit.record(tx, {
      actor,
      module: "approvals",
      action: event,
      targetIntegration: row.targetIntegration ?? undefined,
      targetRef: row.targetRef ?? undefined,
      approvalId: row.id,
      result: to,
      details: reason === undefined ? undefined : { reason },
    });
    return toApproval(updated);
  }
}
