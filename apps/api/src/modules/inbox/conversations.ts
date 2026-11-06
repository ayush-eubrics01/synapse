import type {
  ConversationSummary,
  ConversationThread,
  ConversationType,
  FlagSeverity,
  ThreadMessage,
} from "@synapse/contracts";
import { type Db, schema } from "@synapse/database";
import { and, asc, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import type { SettingsService } from "../../core/config/settings";
import type { UrgentInbox } from "./urgent";

const { slackConversations, slackMessages, slackUsers, securityFlags, commitments } = schema;

const PREVIEW_CHARS = 140;
const SENT_WINDOW_MS = 3_600_000;
const SEVERITY_RANK: Record<FlagSeverity, number> = { info: 0, warning: 1, high: 2 };

export interface InboxConversationsDeps {
  db: Db;
  settings: SettingsService;
  urgent: UrgentInbox;
  /** The sender's decode-and-whitespace normalisation (injected: modules never import integrations). */
  normalise: (text: string) => string;
}

interface Row {
  convId: string;
  externalId: string;
  type: ConversationType;
  name: string | null;
  lastAt: string;
  text: string | null;
  senderExternalId: string;
  senderName: string | null;
  messageCount: number;
}

/** Read-only inbox views: the conversation list and an annotated thread. Message text is never logged. */
export class InboxConversations {
  constructor(private readonly deps: InboxConversationsDeps) {}

  list(limit: number): ConversationSummary[] {
    return this.summaries(limit, null);
  }

  /** Null when the conversation is unknown or has no stored message. */
  thread(externalId: string, limit: number): ConversationThread | null {
    const conversation = this.summaries(1, externalId)[0];
    if (!conversation) return null;
    const { db } = this.deps;
    const self = this.deps.settings.get("slack.selfUserId");
    const rows = db
      .select({
        id: slackMessages.id,
        convId: slackConversations.externalId,
        convName: slackConversations.name,
        convType: slackConversations.type,
        senderId: slackUsers.externalId,
        senderName: slackUsers.name,
        sentAt: slackMessages.sentAt,
        text: slackMessages.text,
        permalink: slackMessages.permalink,
        threadTs: slackMessages.threadTs,
        replyCount: slackMessages.replyCount,
      })
      .from(slackMessages)
      .innerJoin(slackConversations, eq(slackMessages.conversationId, slackConversations.id))
      .innerJoin(slackUsers, eq(slackMessages.senderUserId, slackUsers.id))
      .where(eq(slackConversations.externalId, externalId))
      .orderBy(desc(slackMessages.sentAt), sql`${slackMessages}.rowid DESC`)
      .limit(limit)
      .all()
      .reverse();
    const ids = rows.map((r) => r.id);
    const flags = this.flagsOf(ids);
    const cms = this.commitmentsOf(ids);
    const outgoing = db
      .select({
        text: schema.outgoingMessages.text,
        status: schema.outgoingMessages.status,
        at: schema.outgoingMessages.sendingAt,
      })
      .from(schema.outgoingMessages)
      .where(
        and(
          eq(schema.outgoingMessages.conversationExternalId, externalId),
          inArray(schema.outgoingMessages.status, ["sent", "sent_unverified"]),
          isNotNull(schema.outgoingMessages.sendingAt),
        ),
      )
      .all()
      .map((o) => ({
        norm: this.deps.normalise(o.text),
        status: o.status,
        at: Date.parse(o.at as string),
      }));

    const messages: ThreadMessage[] = rows.map((r) => {
      const isSelf = self !== null && r.senderId === self;
      let sentViaSynapse: ThreadMessage["sentViaSynapse"] = null;
      if (isSelf && r.text !== null && outgoing.length > 0) {
        const norm = this.deps.normalise(r.text);
        const sent = Date.parse(r.sentAt);
        const hit = outgoing.find(
          (o) => o.norm === norm && sent >= o.at && sent - o.at <= SENT_WINDOW_MS,
        );
        if (hit) sentViaSynapse = { status: hit.status as "sent" | "sent_unverified" };
      }
      return {
        id: r.id,
        conversation: { id: r.convId, name: r.convName, type: r.convType },
        sender: { id: r.senderId, name: r.senderName },
        sentAt: r.sentAt,
        text: r.text,
        permalink: r.permalink,
        threadTs: r.threadTs,
        replyCount: r.replyCount,
        isSelf,
        flag: flags.get(r.id) ?? null,
        commitment: cms.get(r.id) ?? null,
        sentViaSynapse,
      };
    });
    return { conversation, messages };
  }

  private flagsOf(ids: string[]): Map<string, { severity: FlagSeverity; reason: string }> {
    const out = new Map<string, { severity: FlagSeverity; reason: string }>();
    if (ids.length === 0) return out;
    const rows = this.deps.db
      .select({
        messageId: securityFlags.messageId,
        severity: securityFlags.severity,
        reason: securityFlags.reason,
      })
      .from(securityFlags)
      .where(inArray(securityFlags.messageId, ids))
      .all();
    for (const f of rows) {
      const cur = out.get(f.messageId as string);
      if (!cur || SEVERITY_RANK[f.severity] > SEVERITY_RANK[cur.severity])
        out.set(f.messageId as string, { severity: f.severity, reason: f.reason });
    }
    return out;
  }

  /** The most recently created non-rejected commitment citing each message. */
  private commitmentsOf(ids: string[]): Map<string, NonNullable<ThreadMessage["commitment"]>> {
    const out = new Map<string, NonNullable<ThreadMessage["commitment"]>>();
    if (ids.length === 0) return out;
    const rows = this.deps.db
      .select({
        messageId: schema.commitmentSources.messageId,
        id: commitments.id,
        description: commitments.description,
        direction: commitments.direction,
        reviewStatus: commitments.reviewStatus,
        status: commitments.status,
      })
      .from(schema.commitmentSources)
      .innerJoin(commitments, eq(commitments.id, schema.commitmentSources.commitmentId))
      .where(
        and(
          inArray(schema.commitmentSources.messageId, ids),
          ne(commitments.reviewStatus, "rejected"),
        ),
      )
      .orderBy(desc(commitments.createdAt), desc(sql`${commitments}.rowid`))
      .all();
    for (const r of rows) {
      const key = r.messageId as string;
      if (out.has(key)) continue;
      out.set(key, {
        id: r.id,
        description: r.description,
        direction: r.direction,
        reviewStatus: r.reviewStatus,
        status: r.status,
      });
    }
    return out;
  }

  private summaries(limit: number, externalId: string | null): ConversationSummary[] {
    const { db, settings } = this.deps;
    const self = settings.get("slack.selfUserId");
    // One grouped read: per conversation its newest message (ties by rowid) and its message count.
    const rows = db.all<Row>(sql`
      select c.id as convId, c.external_id as externalId, c.type as type, c.name as name,
             m.sent_at as lastAt, m.text as text, u.external_id as senderExternalId, u.name as senderName,
             (select count(*) from slack_messages where conversation_id = c.id) as messageCount
      from slack_conversations c
      join slack_messages m on m.id = (
        select id from slack_messages where conversation_id = c.id order by sent_at desc, rowid desc limit 1)
      join slack_users u on u.id = m.sender_user_id
      ${externalId === null ? sql`` : sql`where c.external_id = ${externalId}`}
      order by m.sent_at desc, m.rowid desc
      limit ${limit}`);
    if (rows.length === 0) return [];

    const pendingTargets = new Set(
      db
        .select({ ref: schema.approvals.targetRef })
        .from(schema.approvals)
        .where(
          and(eq(schema.approvals.action, "slack.send"), eq(schema.approvals.status, "pending")),
        )
        .all()
        .map((a) => a.ref),
    );
    const urgentBy = new Map<string, Array<{ messageId: string; level: string }>>();
    for (const u of this.deps.urgent.listUrgent({ status: "open" })) {
      const list = urgentBy.get(u.conversation.id) ?? [];
      list.push({ messageId: u.messageId, level: u.level });
      urgentBy.set(u.conversation.id, list);
    }

    const selfName =
      self === null
        ? null
        : (db
            .select({ name: slackUsers.name })
            .from(slackUsers)
            .where(eq(slackUsers.externalId, self))
            .get()?.name ?? null);

    return rows.map((r) => {
      const lastIsSelf = self !== null && r.senderExternalId === self;
      // Same rule as the commitment extractor's partnerOf: the first non-self sender in an im.
      const partner = r.type === "im" && self !== null ? this.partnerOf(r.convId, self) : null;
      // A partner-less im is the self DM only when its stored name equals the self user's stored
      // name. A DM I started that has no reply yet is also partner-less, so that alone is not enough.
      const isSelfDm =
        r.type === "im" && partner === null && selfName !== null && r.name === selfName;
      return {
        id: r.externalId,
        type: r.type,
        name: r.name,
        isSelfDm,
        partner,
        lastMessageAt: r.lastAt,
        lastSender: { id: r.senderExternalId, name: r.senderName, isSelf: lastIsSelf },
        preview: r.text === null ? null : r.text.slice(0, PREVIEW_CHARS),
        messageCount: r.messageCount,
        theyWroteLast: r.type !== "channel" && self !== null && !isSelfDm && !lastIsSelf,
        awaitingApproval: pendingTargets.has(r.externalId),
        openUrgent: urgentBy.get(r.externalId) ?? [],
      };
    });
  }

  private partnerOf(
    conversationId: string,
    self: string,
  ): { id: string; name: string | null } | null {
    const p = this.deps.db
      .select({ id: slackUsers.externalId, name: slackUsers.name })
      .from(slackMessages)
      .innerJoin(slackUsers, eq(slackUsers.id, slackMessages.senderUserId))
      .where(and(eq(slackMessages.conversationId, conversationId), ne(slackUsers.externalId, self)))
      .orderBy(asc(slackMessages.sentAt), sql`${slackMessages}.rowid ASC`)
      .limit(1)
      .get();
    return p ?? null;
  }
}
