import type { Tx } from "@synapse/database";
import { sql } from "drizzle-orm";
import { INTERACTIVE_CONVERSATION_TYPES, selfMentionNeedles } from "./discovery";

/**
 * R7 M-2, discovery's signals: a DM or group DM, a mention of the user, or a reply in a thread the
 * user posted in. Checked on the message itself plus, for a thread reply only, one query with two
 * index probes for a message of the user in that thread.
 */
export function interactsWithUser(
  tx: Tx,
  m: {
    conversationId: string;
    conversationType: string;
    ts: string;
    threadTs: string | null;
    text: string | null;
  },
  selfId: string,
): boolean {
  if (INTERACTIVE_CONVERSATION_TYPES.includes(m.conversationType)) return true;
  const text = m.text ?? "";
  if (selfMentionNeedles(selfId).some((n) => text.includes(n))) return true;
  if (m.threadTs === null || m.threadTs === m.ts) return false;
  // Two EXISTS so each probe uses a full index key: the root by (conversation_id, ts), the
  // replies by (conversation_id, thread_ts).
  const [row] = tx.all<{ hit: number }>(sql`
    WITH s(id) AS (SELECT id FROM slack_users WHERE external_id = ${selfId})
    SELECT EXISTS (SELECT 1 FROM slack_messages WHERE conversation_id = ${m.conversationId}
                     AND ts = ${m.threadTs} AND sender_user_id IN (SELECT id FROM s))
        OR EXISTS (SELECT 1 FROM slack_messages WHERE conversation_id = ${m.conversationId}
                     AND thread_ts = ${m.threadTs} AND sender_user_id IN (SELECT id FROM s)) AS hit
  `);
  return row?.hit === 1;
}
