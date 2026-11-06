import type { AutoReplyKind, HoldReason } from "@synapse/contracts";

/** Spec A18: the People > Priority subtitle. */
export const PRIORITY_SUBTITLE =
  "High priority + away mode = auto-reply tagged “Sent using @claude”";

/** Plain words for why an auto-reply was held. Exhaustive over the contract's HoldReason. */
const HOLD_REASON: Record<HoldReason, string> = {
  away_off: "You came back first",
  kind_not_allowed: "Kind turned off",
  not_priority: "Not a priority person",
  loop_tag: "Their message was itself an auto-reply",
  flagged: "Their message has an open red flag",
  daily_cap: "Daily limit reached",
  thread_gap: "Replied in this thread recently",
  low_confidence: "Not confident enough",
  content_secret: "Draft looked like it contained a secret",
  content_internal_url: "Draft contained an internal link",
  content_promise: "Draft made a promise for you",
  missing_context: "Original message no longer available",
  policy_disabled: "Auto-replies turned off in permissions",
  recipient_mismatch: "Recipient didn't match the conversation",
};

/** Digest card title: singular/plural of auto-replies sent, then the held count. */
export function digestTitle(sent: number, held: number): string {
  return `${sent} ${sent === 1 ? "auto-reply" : "auto-replies"} sent, ${held} held`;
}

export function holdReasonLabel(reason: HoldReason | null): string {
  return reason === null ? "Held" : HOLD_REASON[reason];
}

const KIND: Record<AutoReplyKind, string> = {
  acknowledgement: "Acknowledgement",
  stalled_reminder: "Stalled reminder",
  followup_question: "Follow-up question",
  code_answer: "Code answer",
};

export function kindLabel(kind: AutoReplyKind): string {
  return KIND[kind];
}

/** A sent row's delivery, from its outgoing status. Anything unexpected reads as not sent. */
export function deliveryLabel(outgoingStatus: string | null): string {
  switch (outgoingStatus) {
    case "sent":
      return "Delivered";
    case "sent_unverified":
      return "Sent, not yet verified";
    case "pending":
    case "sending":
      return "Sending…";
    case "needs_attention":
      return "Not sent — needs your attention";
    default:
      return "Not sent";
  }
}

export const BANNER_TITLE = "Away mode is on";

export function bannerCopy(highPriorityCount: number): string {
  if (highPriorityCount === 0)
    return "No one is set to high priority, so nobody will get an auto-reply. Everything waits for you.";
  const people = highPriorityCount === 1 ? "person" : "people";
  return `Synapse may auto-reply to your ${highPriorityCount} high-priority ${people}, tagged “Sent using @claude”. Everything else waits for you.`;
}
