import type {
  ConversationType,
  ScreeningRecord,
  UrgencyLevel,
  UrgencyStatus,
} from "@synapse/contracts";
import { type Db, schema } from "@synapse/database";
import { type Clock, newId } from "@synapse/shared";
import { and, eq, sql } from "drizzle-orm";
import type { AuditLogger } from "../../core/audit/audit";
import type { EventPublisher } from "../../core/events/publisher";

import { safePermalink } from "./permalink";

const { slackMessages, slackConversations, slackUsers, messageDrafts } = schema;

/** The only transitions the user may make. Resolved and dismissed are terminal. */
const TRANSITIONS: Record<UrgencyStatus, UrgencyStatus[]> = {
  new: ["acknowledged", "in_progress", "resolved", "dismissed"],
  acknowledged: ["in_progress", "resolved", "dismissed"],
  in_progress: ["resolved", "dismissed"],
  resolved: [],
  dismissed: [],
};
const OPEN: UrgencyStatus[] = ["new", "acknowledged", "in_progress"];
const LEVEL_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export interface UrgentItem {
  messageId: string;
  level: UrgencyLevel;
  reason: string;
  status: UrgencyStatus;
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

export class InvalidUrgencyTransition extends Error {
  constructor(
    readonly from: UrgencyStatus | "missing",
    readonly to: UrgencyStatus,
  ) {
    super(`invalid urgency transition ${from} -> ${to}`);
  }
}

export interface UrgentInboxDeps {
  db: Db;
  clock: Clock;
  events: EventPublisher;
  audit: AuditLogger;
}

// Critical/high assessed messages, plus unassessed ones notified (or coalesced, R17) during a
// quota or auth pause.
const URGENT = sql`(${slackMessages.urgencyLevel} in ('critical','high') or (${slackMessages.urgencyLevel} is null and (json_extract(${slackMessages.screening}, '$.notified') = 1 or json_extract(${slackMessages.screening}, '$.coalesced') = 1)))`;

export class UrgentInbox {
  constructor(private readonly deps: UrgentInboxDeps) {}

  listUrgent(filter: { status: "open" | "all" }): UrgentItem[] {
    const rows = this.deps.db
      .select({
        id: slackMessages.id,
        level: slackMessages.urgencyLevel,
        reason: slackMessages.urgencyReason,
        status: slackMessages.urgencyStatus,
        screening: slackMessages.screening,
        sentAt: slackMessages.sentAt,
        text: slackMessages.text,
        permalink: slackMessages.permalink,
        senderId: slackUsers.externalId,
        senderName: slackUsers.name,
        convId: slackConversations.externalId,
        convName: slackConversations.name,
        convType: slackConversations.type,
        draftText: messageDrafts.text,
        draftConfidence: messageDrafts.confidence,
        draftId: messageDrafts.id,
      })
      .from(slackMessages)
      .innerJoin(slackUsers, eq(slackUsers.id, slackMessages.senderUserId))
      .innerJoin(slackConversations, eq(slackConversations.id, slackMessages.conversationId))
      .leftJoin(
        messageDrafts,
        and(
          eq(messageDrafts.messageId, slackMessages.id),
          eq(messageDrafts.kind, "suggested_response"),
          eq(messageDrafts.status, "proposed"),
        ),
      )
      .where(URGENT)
      .all();
    const items: UrgentItem[] = [];
    for (const r of rows) {
      const screening = r.screening as ScreeningRecord | null;
      const assessed = r.level !== null;
      const level = (r.level ?? screening?.ruleLevel ?? "high") as UrgencyLevel;
      const status = (r.status ?? "new") as UrgencyStatus;
      if (filter.status === "open" && !OPEN.includes(status)) continue;
      items.push({
        messageId: r.id,
        level,
        reason: r.reason ?? screening?.matchedRules?.join(", ") ?? "",
        status,
        allowedTransitions: TRANSITIONS[status],
        assessed,
        fallback: screening?.fallback === true,
        coalesced: screening?.coalesced === true,
        sender: { id: r.senderId, name: r.senderName },
        conversation: {
          id: r.convId,
          name: r.convName,
          type: r.convType as ConversationType,
        },
        sentAt: r.sentAt,
        text: r.text,
        permalink: safePermalink(r.permalink),
        draft:
          r.draftId === null ? null : { text: r.draftText, confidence: r.draftConfidence ?? 0 },
      });
    }
    return items.sort(
      (a, b) =>
        (LEVEL_RANK[a.level] ?? 9) - (LEVEL_RANK[b.level] ?? 9) ||
        b.sentAt.localeCompare(a.sentAt) ||
        a.messageId.localeCompare(b.messageId),
    );
  }

  /** Throws InvalidUrgencyTransition (from "missing" when the message is not an urgent one). */
  setUrgencyStatus(messageId: string, status: UrgencyStatus): void {
    this.deps.db.transaction(
      (tx) => {
        const row = tx
          .select({ status: slackMessages.urgencyStatus })
          .from(slackMessages)
          .where(and(eq(slackMessages.id, messageId), URGENT))
          .get();
        if (!row) throw new InvalidUrgencyTransition("missing", status);
        const from = (row.status ?? "new") as UrgencyStatus;
        if (!TRANSITIONS[from].includes(status)) throw new InvalidUrgencyTransition(from, status);
        tx.update(slackMessages)
          .set({ urgencyStatus: status })
          .where(eq(slackMessages.id, messageId))
          .run();
        this.deps.audit.record(tx, {
          actor: "user",
          module: "inbox",
          action: "urgency.status_changed",
          targetRef: messageId,
          result: "ok",
          details: { messageId, from, status },
        });
        this.deps.events.publish(tx, {
          type: "urgency.status_changed",
          aggregateType: "slack_message",
          aggregateId: messageId,
          correlationId: newId(),
          payload: { messageId, status },
        });
      },
      { behavior: "immediate" },
    );
  }
}
