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
 * The A4 check list in order, plus the service's pre-checks (`missing_context`, a producer could
 * not build the reply; `recipient_mismatch`, a DM reply whose recipient is not the DM partner;
 * `not_addressed`, `before_session`, `already_answered`, `injection_suspected`), `policy_disabled`
 * (the user tightened the `slack.auto_reply` permission, so the policy gate is shut) and `stale`
 * (too long between the decision and the send). Phase 10b (C7) adds the code-answer reasons:
 * `code_answer_review` (held for the user's approval because `codeAnswer.away.autoSend` is off),
 * `content_code_block`, `not_answerable` and `unverified`.
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
  "content_link",
  "content_mention",
  "content_promise",
  "missing_context",
  "policy_disabled",
  "recipient_mismatch",
  "not_addressed",
  "before_session",
  "already_answered",
  "injection_suspected",
  "stale",
  "code_answer_review",
  "content_code_block",
  "not_answerable",
  "unverified",
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
