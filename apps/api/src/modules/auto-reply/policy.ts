import type { AutoReplyKind, HoldReason } from "@synapse/contracts";
import { contentCheck } from "../../intelligence/auto-reply/content-checks";

/** A11: fixed acknowledgement text, first person because it posts as the user. No model text. */
export const ACK_TEXT =
  "Thanks, I'm away at the moment. I've noted your message and will get back to you as soon as I can.";

/** ADR-033: every auto-reply ends with this tag. */
export const AUTO_REPLY_TAG = "Sent using @claude";
const TAG = AUTO_REPLY_TAG;

/** A10: the tag is added in code just before the send is requested. */
export function withAutoReplyTag(text: string): string {
  return `${text.trimEnd()}\n\n${TAG}`;
}

// Modules may not import integrations, so decodeSlackText is not reused. Entities are all that
// matters for a plain-text tag match.
const decodeEntities = (s: string): string =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** A9: loop guard. Case-insensitive, whitespace-collapsed, entity-decoded. */
export function hasAutoReplyTag(text: string): boolean {
  return decodeEntities(text).replace(/\s+/g, " ").toLowerCase().includes(TAG.toLowerCase());
}

export interface PolicyInput {
  awayOn: boolean;
  kind: AutoReplyKind;
  allowedKinds: AutoReplyKind[];
  recipientPriority: "normal" | "high" | "critical";
  incomingText: string | null;
  incomingFlagged: boolean;
  /** `sent` auto-replies to this recipient in the rolling 24 h before `now`. */
  sentToRecipientLast24h: number;
  lastSentInThreadAt: string | null;
  now: string;
  confidence: number | null;
  candidateText: string;
  maxPerDay: number;
  minGapMinutes: number;
  minConfidence: number;
}

export type AutoReplyDecision = { send: true } | { send: false; reason: HoldReason };

const hold = (reason: HoldReason): AutoReplyDecision => ({ send: false, reason });

/** A3/A4: pure and deterministic; the first failing check wins. */
export function decideAutoReply(i: PolicyInput): AutoReplyDecision {
  if (!i.awayOn) return hold("away_off");
  if (!i.allowedKinds.includes(i.kind)) return hold("kind_not_allowed");
  if (i.recipientPriority !== "high" && i.recipientPriority !== "critical")
    return hold("not_priority");
  if (i.incomingText !== null && hasAutoReplyTag(i.incomingText)) return hold("loop_tag");
  if (i.incomingFlagged) return hold("flagged");
  if (i.sentToRecipientLast24h >= i.maxPerDay) return hold("daily_cap");
  if (i.lastSentInThreadAt !== null) {
    const elapsed = Date.parse(i.now) - Date.parse(i.lastSentInThreadAt);
    // An unparseable timestamp holds (conservative).
    if (Number.isNaN(elapsed) || elapsed < i.minGapMinutes * 60_000) return hold("thread_gap");
  }
  // A6: an acknowledgement is fixed text, so it has no confidence check. null is below threshold.
  if (i.kind !== "acknowledgement" && (i.confidence === null || i.confidence < i.minConfidence))
    return hold("low_confidence");
  const issue = contentCheck(i.candidateText);
  if (issue) return hold(issue);
  return { send: true };
}
