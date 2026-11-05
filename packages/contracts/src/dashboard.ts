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
