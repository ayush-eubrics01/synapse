import type { Operation } from "./permissions";

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "revoked"
  | "executed"
  | "failed";

export type RiskLevel = "low" | "medium" | "high";

export interface Approval {
  id: string;
  action: Operation;
  targetIntegration: string;
  targetRef: string;
  payload: unknown;
  riskLevel: RiskLevel;
  status: ApprovalStatus;
  requestedByModule: string;
  requestedByWorker: string | null;
  expiresAt: string | null;
  decidedAt: string | null;
  executionResult: unknown;
  idempotencyKey: string;
  createdAt: string;
}
