import type { ContactCandidate } from "@synapse/contracts";
import type { Db } from "@synapse/database";
import type { Clock } from "@synapse/shared";
import { sql } from "drizzle-orm";
import type { SettingsService } from "../../core/config/settings";

export interface ContactDiscoveryDeps {
  db: Db;
  clock: Clock;
  settings: SettingsService;
}

const DAY_MS = 86_400_000;
const DEFAULT_LIMIT = 50;

interface Row {
  slack_user_id: string;
  name: string | null;
  score: number;
  message_count: number;
  has_profile: number;
  has_pending: number;
  is_temporary: number;
}

/**
 * Ranks people for evaluation from stored Slack messages, without AI. One aggregate query per call:
 * message texts are only inspected in SQL (`instr`) for mentions of the user, never loaded.
 */
export class ContactDiscovery {
  constructor(private readonly deps: ContactDiscoveryDeps) {}

  /**
   * score = 3 x DM messages + 2 x group-DM messages + 2 x messages mentioning self
   *       + 1 x replies in threads self also posted in, over the last `people.history.days`.
   * Needs `slack.selfUserId`; returns [] without it.
   */
  listContactCandidates(opts: { limit?: number } = {}): ContactCandidate[] {
    const { db, clock, settings } = this.deps;
    const selfId = settings.get("slack.selfUserId");
    if (!selfId) return [];
    const limit = Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIMIT));
    const since = new Date(
      clock.now().getTime() - settings.get("people.history.days") * DAY_MS,
    ).toISOString();
    // Plain, `<@U|name>` and Slack-escaped forms of a mention of self.
    const m1 = `<@${selfId}>`;
    const m2 = `<@${selfId}|`;
    const m3 = `&lt;@${selfId}&gt;`;
    const rows = db.all<Row>(sql`
      WITH self_user(id) AS (SELECT id FROM slack_users WHERE external_id = ${selfId}),
      -- Threads self took part in: self's replies (thread_ts) and self's own messages as roots (ts).
      self_threads(conversation_id, thread_key) AS (
        SELECT conversation_id, thread_ts FROM slack_messages
          WHERE sender_user_id IN (SELECT id FROM self_user) AND thread_ts IS NOT NULL
        UNION
        SELECT conversation_id, ts FROM slack_messages
          WHERE sender_user_id IN (SELECT id FROM self_user)
      )
      SELECT u.external_id AS slack_user_id,
        u.name AS name,
        SUM(CASE WHEN c.type = 'im' THEN 3 ELSE 0 END)
          + SUM(CASE WHEN c.type = 'mpim' THEN 2 ELSE 0 END)
          + SUM(CASE WHEN instr(coalesce(m.text, ''), ${m1}) > 0
                       OR instr(coalesce(m.text, ''), ${m2}) > 0
                       OR instr(coalesce(m.text, ''), ${m3}) > 0 THEN 2 ELSE 0 END)
          + SUM(CASE WHEN m.thread_ts IS NOT NULL AND m.thread_ts <> m.ts
                       AND (m.conversation_id, m.thread_ts) IN (SELECT conversation_id, thread_key FROM self_threads)
                     THEN 1 ELSE 0 END) AS score,
        COUNT(*) AS message_count,
        EXISTS (SELECT 1 FROM people p JOIN people_profiles pp ON pp.person_id = p.id
                WHERE p.slack_user_id = u.external_id) AS has_profile,
        EXISTS (SELECT 1 FROM people p JOIN people_profile_recommendations pr ON pr.person_id = p.id
                WHERE p.slack_user_id = u.external_id AND pr.status = 'pending') AS has_pending,
        EXISTS (SELECT 1 FROM temporary_contacts t
                WHERE t.slack_user_id = u.external_id) AS is_temporary
      FROM slack_messages m
      JOIN slack_users u ON u.id = m.sender_user_id
      JOIN slack_conversations c ON c.id = m.conversation_id
      WHERE m.sent_at >= ${since} AND u.external_id <> ${selfId}
      GROUP BY u.external_id
      ORDER BY score DESC, u.external_id ASC
      LIMIT ${limit}
    `);
    return rows.map((r) => ({
      slackUserId: r.slack_user_id,
      name: r.name,
      score: r.score,
      messageCount: r.message_count,
      hasProfile: r.has_profile === 1,
      hasPendingRecommendation: r.has_pending === 1,
      isTemporary: r.is_temporary === 1,
    }));
  }
}
