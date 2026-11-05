import type { Approval, ApprovalView, OutgoingPreview } from "@synapse/contracts";
import { type Db, schema } from "@synapse/database";
import { eq, inArray } from "drizzle-orm";

const { outgoingMessages, followups, slackUsers, slackConversations } = schema;

/** The label used wherever Synapse names a conversation to the user. */
export const conversationLabel = (type: string | null, name: string | null, ref: string) =>
  type === "im" ? "a DM" : type === "mpim" ? "a group DM" : `#${name ?? ref}`;

/**
 * H4: attaches the exact text, recipient and conversation to pending `slack.send` approvals. The text
 * appears only in the route response, never in logs, events or audit rows.
 */
export function withOutgoingPreviews(db: Db, approvals: Approval[]): ApprovalView[] {
  const sends = approvals.filter((a) => a.action === "slack.send");
  if (sends.length === 0) return approvals;
  const rows = db
    .select({
      approvalId: outgoingMessages.approvalId,
      text: outgoingMessages.text,
      threadTs: outgoingMessages.threadTs,
      conversationRef: outgoingMessages.conversationExternalId,
      recipientId: followups.recipientSlackUserId,
    })
    .from(outgoingMessages)
    .leftJoin(followups, eq(followups.id, outgoingMessages.followupId))
    .where(
      inArray(
        outgoingMessages.approvalId,
        sends.map((a) => a.id),
      ),
    )
    .all();
  const byApproval = new Map(rows.map((r) => [r.approvalId, r]));
  return approvals.map((a): ApprovalView => {
    const r = byApproval.get(a.id);
    if (a.action !== "slack.send" || !r) return a;
    const conv = db
      .select({ type: slackConversations.type, name: slackConversations.name })
      .from(slackConversations)
      .where(eq(slackConversations.externalId, r.conversationRef))
      .get();
    const user =
      r.recipientId === null
        ? undefined
        : db
            .select({ name: slackUsers.name })
            .from(slackUsers)
            .where(eq(slackUsers.externalId, r.recipientId))
            .get();
    const outgoing: OutgoingPreview = {
      text: r.text,
      recipientName: user?.name ?? null,
      conversationLabel: conversationLabel(
        conv?.type ?? null,
        conv?.name ?? null,
        r.conversationRef,
      ),
      threadReply: r.threadTs !== null,
    };
    return { ...a, outgoing };
  });
}
