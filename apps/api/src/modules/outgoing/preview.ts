import type { Approval, ApprovalView, OutgoingPreview } from "@synapse/contracts";
import { type Db, type DbOrTx, schema } from "@synapse/database";
import { and, desc, eq, inArray, max, ne } from "drizzle-orm";

const { outgoingMessages, followups, slackMessages, slackUsers, slackConversations } = schema;

const NAME_MAX = 40;
/** Group DM names shown before `+n`. */
const SHOWN_NAMES = 2;

const cleanName = (name: string | null) =>
  name === null ? "" : [...name.replace(/\s+/g, " ").trim()].slice(0, NAME_MAX).join("");

export interface LabelledConversation {
  id: string;
  type: "im" | "mpim" | "channel";
  name: string | null;
  externalId: string;
}

/**
 * R17: the label used wherever Synapse names a send's conversation to the user. A DM or group DM
 * names its participants (the non-self authors of stored messages, newest first), so the user sees
 * who a message reaches: `DM with <name>`, `group DM with <a>, <b> +n`, or `#channel`. Falls back to
 * `a DM` / `a group DM` when the user's identity or the participants' names are unknown.
 */
export function participantLabel(
  db: DbOrTx,
  conv: LabelledConversation,
  selfId: string | null,
): string {
  if (conv.type === "channel") return `#${conv.name ?? conv.externalId}`;
  const generic = conv.type === "im" ? "a DM" : "a group DM";
  if (!selfId) return generic;
  const last = max(slackMessages.sentAt);
  const people = db
    .select({ name: slackUsers.name, last })
    .from(slackMessages)
    .innerJoin(slackUsers, eq(slackUsers.id, slackMessages.senderUserId))
    .where(and(eq(slackMessages.conversationId, conv.id), ne(slackUsers.externalId, selfId)))
    .groupBy(slackUsers.id)
    .orderBy(desc(last), slackUsers.id)
    .all()
    .map((p) => cleanName(p.name));
  if (conv.type === "im") {
    const partner = people[0];
    return partner ? `DM with ${partner}` : generic;
  }
  const shown = people.filter((n) => n !== "").slice(0, SHOWN_NAMES);
  if (shown.length === 0) return generic;
  const rest = people.length - shown.length;
  return `group DM with ${shown.join(", ")}${rest > 0 ? ` +${rest}` : ""}`;
}

/**
 * H4: attaches the exact text, recipient and conversation to pending `slack.send` approvals. The text
 * appears only in the route response, never in logs, events or audit rows.
 */
export function withOutgoingPreviews(
  db: Db,
  approvals: Approval[],
  selfId: string | null,
): ApprovalView[] {
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
      .select()
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
      conversationLabel: conv ? participantLabel(db, conv, selfId) : `#${r.conversationRef}`,
      threadReply: r.threadTs !== null,
    };
    return { ...a, outgoing };
  });
}
