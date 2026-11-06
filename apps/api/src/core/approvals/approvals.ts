import type { Approval, ApprovalStatus, Operation, Policy, RiskLevel } from "@synapse/contracts";
import { type Db, type DbOrTx, schema } from "@synapse/database";
import { type Clock, isoNow, newId } from "@synapse/shared";
import { and, asc, eq, inArray, isNotNull, lte } from "drizzle-orm";
import type { AuditLogger } from "../audit/audit";
import type { EventPublisher } from "../events/publisher";
import type { PermissionManager } from "../permissions/permissions";

export type Executor = {
  /** `signal` is the driving job's signal when there is one (aborted on job timeout or stop). */
  execute(a: Approval, signal?: AbortSignal): Promise<unknown>;
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

/** Only `slack.auto_reply` may be approved by a deterministic policy (ADR-033). */
export class PolicyApprovalNotAllowed extends Error {
  constructor(readonly action: Operation) {
    super(`Operation ${action} cannot be approved by a policy`);
    this.name = "PolicyApprovalNotAllowed";
  }
}

/**
 * The user tightened `slack.auto_reply` (effective policy is no longer `policy_gated`), so the
 * auto-reply policy may not approve anything. Nothing falls back to a pending user approval.
 */
export class AutoReplyDisabledByPermission extends Error {
  constructor(readonly policy: Policy) {
    super(`auto-reply disabled by permission (policy ${policy})`);
    this.name = "AutoReplyDisabledByPermission";
  }
}

/** The only operation a policy may approve. */
const POLICY_APPROVABLE: Operation = "slack.auto_reply";

// Stored expiry is compared as text with isoNow(), so it must have the same canonical shape.
const CANONICAL_ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

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

function assertCanonicalExpiry(expiresAt: string | undefined): void {
  if (expiresAt !== undefined && !CANONICAL_ISO.test(expiresAt)) {
    throw new Error(`expiresAt must be canonical UTC ISO (YYYY-MM-DDTHH:mm:ss.sssZ): ${expiresAt}`);
  }
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

  hasExecutor(action: Operation): boolean {
    return this.executors.has(action);
  }

  request(tx: DbOrTx, r: ApprovalRequest): Approval {
    // Checked before the idempotency lookup, so a policy approval is never returned from here.
    if (r.action === POLICY_APPROVABLE) {
      throw new Error(
        `Operation ${r.action} cannot be requested for approval (policy-approved only)`,
      );
    }
    const existing = this.findByKey(tx, r.idempotencyKey);
    if (existing) return toApproval(existing);
    assertCanonicalExpiry(r.expiresAt);
    this.permissions.requireRequestable(r.action);
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

  /**
   * A12: records an approval decided by the deterministic auto-reply policy, inside the caller's
   * transaction. It is inserted `approved` (never `pending`), so `approval.approved` drives the
   * normal execute path. Only `slack.auto_reply`, and only while its effective policy is exactly
   * `policy_gated`: a tightened override throws `AutoReplyDisabledByPermission`.
   */
  recordPolicyApproval(tx: DbOrTx, r: ApprovalRequest, decidedBy: "auto_reply_policy"): Approval {
    if (r.action !== POLICY_APPROVABLE) throw new PolicyApprovalNotAllowed(r.action);
    const policy = this.permissions.check(r.action);
    if (policy !== "policy_gated") throw new AutoReplyDisabledByPermission(policy);
    const existing = this.findByKey(tx, r.idempotencyKey);
    if (existing) {
      if (existing.action !== r.action || existing.decidedBy !== "policy") {
        throw new PolicyApprovalNotAllowed(r.action);
      }
      return toApproval(existing);
    }
    assertCanonicalExpiry(r.expiresAt);
    const now = isoNow(this.clock);
    const row = tx
      .insert(schema.approvals)
      .values({
        id: newId(),
        action: r.action,
        targetIntegration: r.targetIntegration,
        targetRef: r.targetRef,
        payload: r.payload,
        riskLevel: r.riskLevel,
        status: "approved",
        decidedBy: "policy",
        decidedAt: now,
        expiresAt: r.expiresAt,
        idempotencyKey: r.idempotencyKey,
        requestedByModule: r.requestedByModule,
        requestedByWorker: r.requestedByWorker,
        createdAt: now,
      })
      .returning()
      .get();
    this.events.publish(tx, {
      type: "approval.approved",
      aggregateType: "approval",
      aggregateId: row.id,
      correlationId: newId(),
      payload: { approvalId: row.id },
    });
    this.audit.record(tx, {
      actor: "system",
      module: "approvals",
      action: "approval.policy_approved",
      workerProfile: r.requestedByWorker,
      targetIntegration: r.targetIntegration,
      targetRef: r.targetRef,
      approvalId: row.id,
      result: "approved",
      details: {
        operation: r.action,
        riskLevel: r.riskLevel,
        decidedBy,
        requestedByModule: r.requestedByModule,
      },
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

  /**
   * Revokes an approved, unclaimed approval as `system`, inside the caller's transaction (an
   * executor's revalidation found it may no longer run). Throws InvalidApprovalTransition otherwise.
   */
  revokeAsSystem(tx: DbOrTx, id: string, reason: string): Approval {
    const row = tx.select().from(schema.approvals).where(eq(schema.approvals.id, id)).get();
    if (!row || !ALLOWED[row.status].includes("revoked") || row.executionStartedAt !== null) {
      throw new InvalidApprovalTransition(id, row?.status ?? "missing", "revoked");
    }
    return this.apply(tx, row, "revoked", "approval.revoked", "system", reason);
  }

  /**
   * Expires a pending (or approved, unclaimed) approval as `system`, inside the caller's
   * transaction: the work it asked about was cancelled. Throws InvalidApprovalTransition otherwise.
   */
  expireAsSystem(tx: DbOrTx, id: string, reason: string): Approval {
    const row = tx.select().from(schema.approvals).where(eq(schema.approvals.id, id)).get();
    if (!row || !ALLOWED[row.status].includes("expired") || row.executionStartedAt !== null) {
      throw new InvalidApprovalTransition(id, row?.status ?? "missing", "expired");
    }
    return this.apply(tx, row, "expired", "approval.expired", "system", reason);
  }

  /** Whether a policy (not the user) may approve `action` right now: effective policy policy_gated. */
  policyGateOpen(action: Operation): boolean {
    return this.permissions.policyGateOpen(action);
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

  /** `signal` (optional) is passed to the executor so a job timeout can cancel its work. */
  async execute(id: string, signal?: AbortSignal): Promise<ExecuteOutcome> {
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
        // A policy approval runs only while the policy gate is still open. Its executor's
        // revalidate normally catches this first; here the gate shut in between. It can never run
        // later, so it is revoked and the revoke consumers clean up.
        if (
          row.decidedBy === "policy" &&
          !this.permissions.policyGateOpen(row.action as Operation)
        ) {
          this.apply(tx, row, "revoked", "approval.revoked", "system", "policy_disabled");
          return { reason: "policy_disabled" };
        }
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
    let result: unknown;
    try {
      result = (await executor.execute(approval, signal)) ?? null;
    } catch (e) {
      const error = { error: e instanceof Error ? e.message : String(e) };
      this.finish(id, "failed", error);
      return { status: "failed", result: error };
    }
    // Outside the try: the side effect already happened. If recording it throws, the error
    // propagates and the row stays claimed (execution_started_at set), so it can never re-run.
    this.finish(id, "executed", result);
    return { status: "executed", result };
  }

  private findByKey(tx: DbOrTx, key: string): Row | undefined {
    return tx.select().from(schema.approvals).where(eq(schema.approvals.idempotencyKey, key)).get();
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
      .set({
        status: to,
        decidedAt: isoNow(this.clock),
        // The user's own decision; revoke/expiry keep who approved it.
        ...((to === "approved" || to === "rejected") && actor === "user"
          ? { decidedBy: "user" as const }
          : {}),
      })
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
