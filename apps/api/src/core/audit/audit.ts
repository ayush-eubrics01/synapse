import { type DbOrTx, schema } from "@synapse/database";
import { type Clock, isoNow, newId } from "@synapse/shared";

export interface AuditRecord {
  actor: "user" | "system" | (string & {});
  module: string;
  action: string;
  workerProfile?: string;
  targetIntegration?: string;
  targetRef?: string;
  approvalId?: string;
  result: string;
  details?: Record<string, unknown>;
}

export class AuditLogger {
  constructor(private readonly clock: Clock) {}

  record(tx: DbOrTx, e: AuditRecord): string {
    const id = newId();
    tx.insert(schema.auditEvents)
      .values({
        id,
        actor: e.actor,
        module: e.module,
        action: e.action,
        workerProfile: e.workerProfile,
        targetIntegration: e.targetIntegration,
        targetRef: e.targetRef,
        approvalId: e.approvalId,
        result: e.result,
        details: e.details,
        occurredAt: isoNow(this.clock),
      })
      .run();
    return id;
  }
}
