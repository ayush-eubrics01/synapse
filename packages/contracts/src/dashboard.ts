import type { HealthStatus } from "./health";
import type { ConversationType } from "./messages";
import type { FlagSeverity, UrgencyLevel, UrgencyStatus } from "./urgency";

/** One row of the urgent inbox (`GET /api/urgent`). */
export interface UrgentItem {
  messageId: string;
  level: UrgencyLevel;
  reason: string;
  status: UrgencyStatus;
  /** Computed by the server; the UI shows exactly these buttons. */
  allowedTransitions: UrgencyStatus[];
  /** False for a message notified as "not yet assessed" (its level is the rule level). */
  assessed: boolean;
  /** True when the level came from the rules because the model gave none. */
  fallback: boolean;
  /** R17: a follow-up in a thread that was already notified (no popup, no draft of its own). */
  coalesced: boolean;
  sender: { id: string; name: string | null };
  conversation: { id: string; name: string | null; type: ConversationType };
  sentAt: string;
  text: string | null;
  permalink: string | null;
  draft: { text: string | null; confidence: number } | null;
  /** The approved-send state of this message's reply, or null when none was ever requested. */
  reply: UrgentReply | null;
}

/** What the user may do with a reply whose delivery is unknown (computed by the server). */
export type OutgoingResolveAction = "mark_sent" | "resend" | "discard";

export interface UrgentReply {
  followupId: string;
  status: string;
  approvalId: string | null;
  outgoingId: string | null;
  outgoingStatus: string | null;
  /** True when no send is live or done, so the draft can be edited and sent for approval. */
  canRequest: boolean;
  actions: OutgoingResolveAction[];
}

export type FlagStatus = "open" | "acknowledged" | "contacted" | "dismissed";

/** Security flags grouped per person (`GET /api/security/flags`). */
export interface GroupedFlags {
  slackUserId: string;
  name: string;
  openCount: number;
  maxSeverity: FlagSeverity;
  latest: {
    id: string;
    excerpt: string;
    detector: string;
    createdAt: string;
    permalink: string | null;
  };
  /** The person's newest still-open flag: what the grouped-row review buttons act on. */
  latestOpenId: string | null;
}

/** One flag in a person's history (`GET /api/security/flags/person/:slackUserId`). */
export interface PersonFlag {
  id: string;
  severity: FlagSeverity;
  status: FlagStatus;
  detector: string;
  excerpt: string;
  createdAt: string;
}

export type PipelineStageId = "collect" | "screen" | "assess" | "surface";
export type PipelineState = "ok" | "waiting" | "failing" | "idle";

/** `GET /api/dashboard/overview`: read-only aggregate for the dashboard shell. */
export interface DashboardOverview {
  generatedAt: string;
  self: { slackUserId: string | null; name: string | null };
  counts: {
    urgent: number;
    approvals: number;
    outgoingAttention: number;
    redFlags: number;
    commitmentsToReview: number;
    followupDrafts: number;
    profileRecommendations: number;
    peopleToEvaluate: number;
    conversations: number;
  };
  /** Away mode (ADR-033): the switch and how many people (high or critical, not self) it can reply to. */
  away: { on: boolean; highPriorityCount: number };
  lastSlackSyncAt: string | null;
  health: {
    status: HealthStatus;
    issues: Array<{
      check: string;
      label: string;
      status: HealthStatus;
      detail: string | null;
      hint: string | null;
    }>;
  };
  pipeline: Array<{
    id: PipelineStageId;
    label: string;
    what: string;
    state: PipelineState;
    summary: string;
  }>;
  engineeringLock: null;
}

/** One row of the inbox conversation list (`GET /api/inbox/conversations`). */
export interface ConversationSummary {
  id: string;
  type: ConversationType;
  name: string | null;
  isSelfDm: boolean;
  partner: { id: string; name: string | null } | null;
  lastMessageAt: string;
  lastSender: { id: string; name: string | null; isSelf: boolean };
  /** Latest text, first 140 chars; null when expired. */
  preview: string | null;
  messageCount: number;
  theyWroteLast: boolean;
  awaitingApproval: boolean;
  openUrgent: Array<{ messageId: string; level: string }>;
}

/** One message of an annotated thread (`GET /api/inbox/conversations/:id/thread`). */
export interface ThreadMessage {
  id: string;
  conversation: { id: string; name: string | null; type: ConversationType };
  sender: { id: string; name: string | null };
  sentAt: string;
  text: string | null;
  permalink: string | null;
  threadTs: string | null;
  replyCount: number;
  isSelf: boolean;
  flag: { severity: FlagSeverity; reason: string } | null;
  commitment: {
    id: string;
    description: string;
    direction: "mine" | "theirs";
    reviewStatus: string;
    status: string;
  } | null;
  /** `auto` is true when an away-mode auto-reply sent it (an `auto_replies` row links the message). */
  sentViaSynapse: { status: "sent" | "sent_unverified"; auto: boolean } | null;
}

/** Messages are oldest first. */
export interface ConversationThread {
  conversation: ConversationSummary;
  messages: ThreadMessage[];
}
