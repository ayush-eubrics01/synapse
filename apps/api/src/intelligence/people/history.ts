import type { Db } from "@synapse/database";
import { sql } from "drizzle-orm";

export interface HistoryItem {
  messageId: string;
  sentAt: string;
  author: "them" | "self" | "other";
  conversationLabel: string;
  text: string;
  /** `<conversation external id>:<ts>`; survives message expiry as evidence provenance. */
  sourceRef: string;
}

export interface HistoryOptions {
  days: number;
  maxMessages: number;
  /** Slack external id of the user; null until confirmed (then only the person's own messages). */
  selfUserId: string | null;
  now: Date;
}

interface Row {
  id: string;
  sent_at: string;
  text: string;
  sender: string;
  person_id: string;
  self_id: string | null;
  type: "im" | "mpim" | "channel";
  name: string | null;
  conv_ref: string;
  ts: string;
}

const DAY_MS = 86_400_000;

/** Same labels as the urgency prompts. */
export const conversationLabel = (
  type: "im" | "mpim" | "channel",
  name: string | null,
  ref: string,
) => (type === "im" ? "a DM" : type === "mpim" ? "a group DM" : `#${name ?? ref}`);

/**
 * The collected, unexpired Slack messages that describe how `slackUserId` works with the user, from
 * the last `days`: the person's own messages anywhere, the user's messages in a DM with the person,
 * and every message in a thread both posted in. Newest `maxMessages`, returned oldest first.
 */
export function selectHistory(db: Db, slackUserId: string, opts: HistoryOptions): HistoryItem[] {
  const since = new Date(opts.now.getTime() - opts.days * DAY_MS).toISOString();
  const rows = db.all<Row>(sql`
    WITH p(id) AS (SELECT id FROM slack_users WHERE external_id = ${slackUserId}),
    s(id) AS (SELECT id FROM slack_users WHERE external_id = ${opts.selfUserId}),
    -- A thread is keyed by its root ts: replies carry thread_ts, a root message its own ts.
    p_threads(conversation_id, thread_key) AS (
      SELECT conversation_id, thread_ts FROM slack_messages
        WHERE sender_user_id IN (SELECT id FROM p) AND thread_ts IS NOT NULL
      UNION
      SELECT conversation_id, ts FROM slack_messages WHERE sender_user_id IN (SELECT id FROM p)
    ),
    shared_threads(conversation_id, thread_key) AS (
      SELECT conversation_id, thread_ts FROM slack_messages
        WHERE sender_user_id IN (SELECT id FROM s) AND thread_ts IS NOT NULL
      UNION
      SELECT conversation_id, ts FROM slack_messages WHERE sender_user_id IN (SELECT id FROM s)
    ),
    both(conversation_id, thread_key) AS (
      SELECT conversation_id, thread_key FROM p_threads
        WHERE (conversation_id, thread_key) IN (SELECT conversation_id, thread_key FROM shared_threads)
    )
    SELECT m.id, m.sent_at, m.text, m.sender_user_id AS sender, p.id AS person_id,
           (SELECT id FROM s) AS self_id, c.type, c.name, c.external_id AS conv_ref, m.ts
    FROM slack_messages m
    JOIN slack_conversations c ON c.id = m.conversation_id
    JOIN p
    WHERE m.sent_at >= ${since} AND m.text IS NOT NULL AND m.content_expired_at IS NULL
      AND (
        m.sender_user_id = p.id
        OR (c.type = 'im' AND m.sender_user_id IN (SELECT id FROM s)
            AND m.conversation_id IN (SELECT conversation_id FROM p_threads))
        OR EXISTS (
          SELECT 1 FROM both b
          WHERE b.conversation_id = m.conversation_id
            AND (b.thread_key = m.thread_ts OR b.thread_key = m.ts))
      )
    ORDER BY m.sent_at DESC, m.rowid DESC
    LIMIT ${Math.max(1, Math.floor(opts.maxMessages))}
  `);
  return rows.reverse().map((r) => ({
    messageId: r.id,
    sentAt: r.sent_at,
    author: r.sender === r.person_id ? "them" : r.sender === r.self_id ? "self" : "other",
    conversationLabel: conversationLabel(r.type, r.name, r.conv_ref),
    text: r.text,
    sourceRef: `${r.conv_ref}:${r.ts}`,
  }));
}
