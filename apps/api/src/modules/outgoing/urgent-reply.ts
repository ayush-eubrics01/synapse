import type { OutgoingResolveAction, UrgentReply } from "@synapse/contracts";
import { type Db, schema } from "@synapse/database";
import { type Clock, isoNow, newId } from "@synapse/shared";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { AuditLogger } from "../../core/audit/audit";
import { URGENT } from "../inbox/urgent";
import { InvalidOutgoingText, type OutgoingService, SendAlreadyPending } from "./service";

const { slackMessages, slackUsers, slackConversations, followups, outgoingMessages } = schema;

const MAX_TEXT = 4000;
const LIVE = ["pending", "sending", "sent_unverified", "needs_attention"] as const;
/** A reply in these states can be edited and sent for approval again. */
const REQUESTABLE = ["draft", "failed", "discarded"];

/** The message is not an urgent one, or does not exist (404). */
export class UrgentMessageNotFound extends Error {
  constructor() {
    super("urgent message not found");
    this.name = "UrgentMessageNotFound";
  }
}

/** The message text expired, so the thread cannot be confirmed (409). `allowNoThread` overrides. */
export class ExpiredSource extends Error {
  constructor() {
    super("the message content expired; the reply can only be posted outside the thread");
    this.name = "ExpiredSource";
  }
}

export interface UrgentReplyDeps {
  db: Db;
  clock: Clock;
  audit: AuditLogger;
  outgoing: Pick<OutgoingService, "requestSend">;
}

/** What the user may do next; mirrors `OutgoingService.resolveNeedsAttention` exactly. */
export function resolveActions(
  status: string | null,
  failure: string | null,
): OutgoingResolveAction[] {
  if (status === "needs_attention") return ["mark_sent", "resend", "discard"];
  if (status === "sent_unverified" && failure === "unverified") return ["mark_sent", "discard"];
  return [];
}

/** The latest urgent-reply follow-up (and its outgoing message) per message id. */
export function replyStates(db: Db, messageIds: string[]): Map<string, UrgentReply> {
  const out = new Map<string, UrgentReply>();
  if (messageIds.length === 0) return out;
  const rows = db
    .select({
      messageId: followups.originMessageId,
      followupId: followups.id,
      status: followups.status,
      approvalId: followups.approvalId,
      outgoingId: outgoingMessages.id,
      outgoingStatus: outgoingMessages.status,
      failure: outgoingMessages.failure,
    })
    .from(followups)
    .leftJoin(outgoingMessages, eq(outgoingMessages.id, followups.outgoingId))
    .where(
      and(eq(followups.origin, "urgent_reply"), inArray(followups.originMessageId, messageIds)),
    )
    .orderBy(desc(followups.createdAt), desc(followups.id))
    .all();
  for (const r of rows) {
    if (r.messageId === null || out.has(r.messageId)) continue;
    out.set(r.messageId, {
      followupId: r.followupId,
      status: r.status,
      approvalId: r.approvalId,
      outgoingId: r.outgoingId,
      outgoingStatus: r.outgoingStatus,
      canRequest: REQUESTABLE.includes(r.status),
      actions: resolveActions(r.outgoingStatus, r.failure),
    });
  }
  return out;
}

export class UrgentReplies {
  constructor(private readonly deps: UrgentReplyDeps) {}

  /**
   * Turns the user's (possibly edited) draft into a pending `slack.send` approval. One live reply
   * per urgent message: SendAlreadyPending (409) while one is pending, sending, unverified or
   * awaiting a decision. Text is stored only in the module tables.
   */
  requestUrgentReply(
    messageId: string,
    rawText: string,
    opts: { allowNoThread?: boolean } = {},
  ): { followupId: string; approvalId: string; outgoingId: string } {
    const { db, clock, audit, outgoing } = this.deps;
    const text = rawText.trimEnd();
    if (text.length < 1 || text.length > MAX_TEXT) throw new InvalidOutgoingText();
    return db.transaction(
      (tx) => {
        const m = tx
          .select({
            ts: slackMessages.ts,
            threadTs: slackMessages.threadTs,
            text: slackMessages.text,
            expiredAt: slackMessages.contentExpiredAt,
            senderRef: slackUsers.externalId,
            conversationId: slackMessages.conversationId,
            convRef: slackConversations.externalId,
          })
          .from(slackMessages)
          .innerJoin(slackUsers, eq(slackUsers.id, slackMessages.senderUserId))
          .innerJoin(slackConversations, eq(slackConversations.id, slackMessages.conversationId))
          .where(and(eq(slackMessages.id, messageId), URGENT))
          .get();
        if (!m) throw new UrgentMessageNotFound();
        const expired = m.expiredAt !== null || m.text === null;
        if (expired && !opts.allowNoThread) throw new ExpiredSource();
        const threadTs = expired ? null : (m.threadTs ?? m.ts);

        const existing = tx
          .select({ id: followups.id, status: followups.status })
          .from(followups)
          .where(
            and(eq(followups.origin, "urgent_reply"), eq(followups.originMessageId, messageId)),
          )
          .orderBy(desc(followups.createdAt), desc(followups.id))
          .all();
        const live = tx
          .select({ followupId: outgoingMessages.followupId })
          .from(outgoingMessages)
          .where(
            and(
              inArray(
                outgoingMessages.followupId,
                existing.map((f) => f.id),
              ),
              inArray(outgoingMessages.status, LIVE),
            ),
          )
          .get();
        if (live?.followupId) throw new SendAlreadyPending(live.followupId);

        const now = isoNow(clock);
        const reuse = existing[0] && REQUESTABLE.includes(existing[0].status) ? existing[0] : null;
        const followupId = reuse?.id ?? newId();
        const fields = {
          // R15: the internal slack_conversations.id, like every other follow-up.
          conversationId: m.conversationId,
          threadTs,
          recipientSlackUserId: m.senderRef,
          draftText: text,
          status: "awaiting_approval" as const,
          updatedAt: now,
        };
        if (reuse) {
          tx.update(followups).set(fields).where(eq(followups.id, followupId)).run();
        } else {
          tx.insert(followups)
            .values({
              id: followupId,
              origin: "urgent_reply",
              originMessageId: messageId,
              createdAt: now,
              ...fields,
            })
            .run();
        }
        const sent = outgoing.requestSend(tx, {
          followupId,
          conversationExternalId: m.convRef,
          threadTs,
          text,
          requestedByModule: "inbox",
        });
        audit.record(tx, {
          actor: "user",
          module: "outgoing",
          action: "urgent_reply.requested",
          targetRef: messageId,
          approvalId: sent.approvalId,
          result: "ok",
          details: {
            messageId,
            followupId,
            outgoingId: sent.outgoingId,
            threaded: threadTs !== null,
          },
        });
        return { followupId, ...sent };
      },
      { behavior: "immediate" },
    );
  }
}
