import type { ConversationType, MessagePage, SourceMessage } from "@synapse/contracts";
import { type Db, type DbOrTx, schema } from "@synapse/database";
import { type Clock, isoNow, newId } from "@synapse/shared";
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import type { EventPublisher } from "../../core/events/publisher";
import type { JobQueue } from "../../core/jobs/queue";
import type { SyncStateService, SyncStream } from "./sync-state";

const { slackConversations, slackUsers, slackMessages } = schema;

export interface InboxStoreDeps {
  db: Db;
  clock: Clock;
  events: EventPublisher;
  queue: JobQueue;
  sync: SyncStateService;
}

export interface InboxMessage {
  id: string;
  conversation: { id: string; name: string | null; type: ConversationType };
  sender: { id: string; name: string | null };
  sentAt: string;
  text: string | null;
  permalink: string | null;
  threadTs: string | null;
  replyCount: number;
}

interface Inserted {
  id: string;
  message: SourceMessage;
}

export class InboxStore {
  constructor(private readonly deps: InboxStoreDeps) {}

  persistPage(
    stream: SyncStream,
    page: MessagePage,
  ): { inserted: number; duplicates: number; threadFetches: number } {
    const { db, sync } = this.deps;
    return db.transaction(
      (tx) => {
        const correlationId = newId();
        const users = new Map<string, string>();
        const conversations = new Map<string, string>();
        const inserted: Inserted[] = [];
        for (const m of page.messages) {
          const conversationId = this.upsertConversation(tx, conversations, m);
          const id = this.insertMessage(tx, users, conversationId, m);
          if (id) inserted.push({ id, message: m });
        }

        let threadFetches = 0;
        for (const { id, message: m } of inserted) {
          this.deps.events.publish(tx, this.event("message.received", id, correlationId));
          if (!m.threadTs || m.threadTs === m.ts) continue;
          const conversationId = conversations.get(m.conversationId) as string;
          const parent = tx
            .select({ id: slackMessages.id })
            .from(slackMessages)
            .where(
              and(
                eq(slackMessages.conversationId, conversationId),
                eq(slackMessages.ts, m.threadTs),
              ),
            )
            .get();
          if (parent) {
            this.deps.events.publish(tx, this.event("message.thread_updated", id, correlationId));
          } else {
            const r = this.deps.queue.enqueue(tx, {
              type: "slack.fetch_thread",
              input: { conversationId: m.conversationId, parentTs: m.threadTs },
              idempotencyKey: `slack.thread:${m.conversationId}:${m.threadTs}`,
              concurrencyGroup: "slack.threads",
              priority: 50,
            });
            if (r.created) threadFetches++;
          }
        }

        if (page.messages.length > 0) {
          const state = sync.get(stream, tx);
          let pageMax = page.messages[0]?.ts as string;
          for (const m of page.messages) if (Number(m.ts) > Number(pageMax)) pageMax = m.ts;
          const nowTs = (this.deps.clock.now().getTime() / 1000).toFixed(6);
          const capped = Number(pageMax) > Number(nowTs) ? nowTs : pageMax;
          const next =
            state.checkpoint !== null && Number(state.checkpoint) >= Number(capped)
              ? state.checkpoint
              : capped;
          if (next !== state.checkpoint) sync.update(tx, stream, { checkpoint: next });
        }

        return {
          inserted: inserted.length,
          duplicates: page.messages.length - inserted.length,
          threadFetches,
        };
      },
      { behavior: "immediate" },
    );
  }

  /** Stores fetched thread messages for an already-known conversation; never touches the checkpoint. */
  storeThread(conversationExternalId: string, messages: SourceMessage[]): { inserted: number } {
    return this.deps.db.transaction(
      (tx) => {
        const conv = tx
          .select({ id: slackConversations.id })
          .from(slackConversations)
          .where(eq(slackConversations.externalId, conversationExternalId))
          .get();
        if (!conv) return { inserted: 0 };
        const correlationId = newId();
        const users = new Map<string, string>();
        let inserted = 0;
        for (const m of messages) {
          const id = this.insertMessage(tx, users, conv.id, m);
          if (!id) continue;
          inserted++;
          this.deps.events.publish(tx, this.event("message.received", id, correlationId));
        }
        return { inserted };
      },
      { behavior: "immediate" },
    );
  }

  listMessages(q: {
    limit: number;
    beforeSentAt?: string;
    conversationId?: string;
  }): InboxMessage[] {
    const limit = Math.min(200, Math.max(1, Math.trunc(q.limit) || 1));
    const conds = [];
    if (q.beforeSentAt) conds.push(lt(slackMessages.sentAt, q.beforeSentAt));
    if (q.conversationId) conds.push(eq(slackConversations.externalId, q.conversationId));
    const rows = this.deps.db
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
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(slackMessages.sentAt), sql`${slackMessages}.rowid DESC`)
      .limit(limit)
      .all();
    return rows.map((r) => ({
      id: r.id,
      conversation: { id: r.convId, name: r.convName, type: r.convType },
      sender: { id: r.senderId, name: r.senderName },
      sentAt: r.sentAt,
      text: r.text,
      permalink: r.permalink,
      threadTs: r.threadTs,
      replyCount: r.replyCount,
    }));
  }

  expireContent(olderThanDays: number): number {
    const nowMs = this.deps.clock.now().getTime();
    const cutoff = new Date(nowMs - olderThanDays * 86_400_000).toISOString();
    const res = this.deps.db
      .update(slackMessages)
      .set({ text: null, fullNotes: null, contentExpiredAt: isoNow(this.deps.clock) })
      .where(and(lt(slackMessages.sentAt, cutoff), isNull(slackMessages.contentExpiredAt)))
      .returning({ id: slackMessages.id })
      .all();
    return res.length;
  }

  private event<T extends "message.received" | "message.thread_updated">(
    type: T,
    messageId: string,
    correlationId: string,
  ) {
    return {
      type,
      aggregateType: "slack_message",
      aggregateId: messageId,
      correlationId,
      payload: { messageId },
    };
  }

  private upsertConversation(tx: DbOrTx, cache: Map<string, string>, m: SourceMessage): string {
    const cached = cache.get(m.conversationId);
    if (cached) return cached;
    const name = m.conversationName?.trim() ? m.conversationName : null;
    const base = tx.insert(slackConversations).values({
      id: newId(),
      externalId: m.conversationId,
      type: m.conversationType,
      name,
    });
    if (name) {
      base.onConflictDoUpdate({ target: slackConversations.externalId, set: { name } }).run();
    } else {
      base.onConflictDoNothing({ target: slackConversations.externalId }).run();
    }
    const row = tx
      .select({ id: slackConversations.id })
      .from(slackConversations)
      .where(eq(slackConversations.externalId, m.conversationId))
      .get();
    if (!row) throw new Error("conversation row vanished");
    cache.set(m.conversationId, row.id);
    return row.id;
  }

  private upsertUser(tx: DbOrTx, cache: Map<string, string>, m: SourceMessage): string {
    const name = m.senderName?.trim() ? m.senderName : null;
    const email = m.senderEmail?.trim() ? m.senderEmail : null;
    const cached = cache.get(m.senderId);
    if (cached && !name && !email) return cached;
    const base = tx.insert(slackUsers).values({ id: newId(), externalId: m.senderId, name, email });
    const set: { name?: string; email?: string } = {};
    if (name) set.name = name;
    if (email) set.email = email;
    if (Object.keys(set).length > 0) {
      base.onConflictDoUpdate({ target: slackUsers.externalId, set }).run();
    } else {
      base.onConflictDoNothing({ target: slackUsers.externalId }).run();
    }
    const row = tx
      .select({ id: slackUsers.id })
      .from(slackUsers)
      .where(eq(slackUsers.externalId, m.senderId))
      .get();
    if (!row) throw new Error("user row vanished");
    cache.set(m.senderId, row.id);
    return row.id;
  }

  /** Returns the new message id, or null when (conversation, ts) already existed. */
  private insertMessage(
    tx: DbOrTx,
    users: Map<string, string>,
    conversationId: string,
    m: SourceMessage,
  ): string | null {
    const senderUserId = this.upsertUser(tx, users, m);
    const id = newId();
    const rows = tx
      .insert(slackMessages)
      .values({
        id,
        conversationId,
        ts: m.ts,
        threadTs: m.threadTs ?? null,
        senderUserId,
        text: m.text,
        fullNotes: m.fullNotes ?? null,
        permalink: m.permalink ?? null,
        replyCount: m.replyCount ?? 0,
        sentAt: m.sentAt,
        collectedAt: isoNow(this.deps.clock),
      })
      .onConflictDoNothing({ target: [slackMessages.conversationId, slackMessages.ts] })
      .returning({ id: slackMessages.id })
      .all();
    return rows.length > 0 ? id : null;
  }
}
