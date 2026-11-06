import { DEFAULT_POLICIES, type Operation, type Policy, stricterOf } from "@synapse/contracts";
import { type Db, schema } from "@synapse/database";
import { newId } from "@synapse/shared";
import { eq } from "drizzle-orm";
import type { AuditLogger } from "../audit/audit";

/** Effective policy = stricterOf(default, stored override). Overrides can only tighten. */
export class PermissionManager {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditLogger,
  ) {}

  check(op: Operation): Policy {
    const def = DEFAULT_POLICIES[op];
    const row = this.db
      .select()
      .from(schema.permissions)
      .where(eq(schema.permissions.operation, op))
      .get();
    return row ? stricterOf(def, row.policy as Policy) : def;
  }

  /**
   * The effective policy of an operation the user may be asked to approve. Throws for `denied` and
   * `user_only`, and for `policy_gated`: a policy-gated operation never pends for a user decision,
   * only `ApprovalEngine.recordPolicyApproval` may approve it (ADR-033).
   */
  requireRequestable(op: Operation): Policy {
    const policy = this.check(op);
    if (policy === "denied" || policy === "user_only" || policy === "policy_gated") {
      throw new Error(`Operation ${op} cannot be requested for approval (policy ${policy})`);
    }
    return policy;
  }

  /** true only while the effective policy is exactly `policy_gated` (no tightening override). */
  policyGateOpen(op: Operation): boolean {
    return this.check(op) === "policy_gated";
  }

  setOverride(op: Operation, policy: Policy): void {
    this.db.transaction(
      (tx) => {
        const existing = tx
          .select()
          .from(schema.permissions)
          .where(eq(schema.permissions.operation, op))
          .get();
        if (existing) {
          tx.update(schema.permissions)
            .set({ policy })
            .where(eq(schema.permissions.id, existing.id))
            .run();
        } else {
          tx.insert(schema.permissions).values({ id: newId(), operation: op, policy }).run();
        }
        const def = DEFAULT_POLICIES[op];
        const effective = stricterOf(def, policy);
        this.audit.record(tx, {
          actor: "user",
          module: "permissions",
          action: effective === policy ? "permission.override_set" : "permission.override_ignored",
          result: effective === policy ? "applied" : "ignored_looser_than_default",
          details: { operation: op, requested: policy, default: def, effective },
        });
      },
      { behavior: "immediate" },
    );
  }
}
