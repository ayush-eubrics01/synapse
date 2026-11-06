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

/** H4: exactly what a `slack.send` approval will post, and where. Route responses only. */
export interface OutgoingPreview {
  text: string;
  recipientName: string | null;
  /** R17: `#name`, `DM with <name>` or `group DM with <a>, <b> +n` (`a DM` / `a group DM` when unknown). */
  conversationLabel: string;
  /** False when the message is posted to the conversation, not into a thread. */
  threadReply: boolean;
}

export type ApprovalView = Approval & { outgoing?: OutgoingPreview };
