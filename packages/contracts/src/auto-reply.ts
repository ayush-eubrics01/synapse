import { z } from "zod";

/** Phase 6b away-mode auto-replies (ADR-033). */

/** ADR-033 / A10: every auto-reply ends with this tag, added in code. */
export const AUTO_REPLY_TAG = "Sent using @claude";

export type AutoReplyKind =
  | "code_answer"
  | "stalled_reminder"
  | "followup_question"
  | "acknowledgement";

/**
 * The A4 check list in order, plus `missing_context` (a producer could not build the reply),
 * `policy_disabled` (the user tightened the `slack.auto_reply` permission, so the policy gate is shut)
 * and `recipient_mismatch` (a DM reply whose recipient is not the DM partner).
 */
export const holdReasonSchema = z.enum([
  "away_off",
  "kind_not_allowed",
  "not_priority",
  "loop_tag",
  "flagged",
  "daily_cap",
  "thread_gap",
  "low_confidence",
  "content_secret",
  "content_internal_url",
  "content_promise",
  "missing_context",
  "policy_disabled",
  "recipient_mismatch",
]);
export type HoldReason = z.infer<typeof holdReasonSchema>;

export interface AutoReplyView {
  id: string;
  kind: AutoReplyKind;
  decision: "sent" | "held";
  reason: HoldReason | null;
  recipient: { slackUserId: string; name: string | null };
  conversationLabel: string | null;
  threadTs: string | null;
  createdAt: string;
  outgoingStatus: string | null;
}

export interface AwayDigest {
  session: { id: string; startedAt: string; endedAt: string };
  sent: AutoReplyView[];
  held: AutoReplyView[];
}
