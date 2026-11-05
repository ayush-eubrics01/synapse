import type { DomainEvent, EventType } from "@synapse/contracts";
import { type Db, schema, type Tx } from "@synapse/database";
import type { Clock } from "@synapse/shared";
import { eq } from "drizzle-orm";
import type { SettingsService } from "../../core/config/settings";
import type { JobQueue } from "../../core/jobs/queue";
import { interactsWithUser } from "../people/interaction";
import { COMMITMENTS_CONCURRENCY_GROUP } from "./store";

export const EXTRACT_JOB = "commitments.extract";
export const EXTRACT_PRIORITY = 50;

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const { slackMessages, slackUsers, slackConversations } = schema;

export interface ExtractionQueueDeps {
  db: Db;
  clock: Clock;
  settings: SettingsService;
  queue: JobQueue;
}

/**
 * `commitments.queue` consumer of `message.received`: queues one debounced extraction job per time
 * bucket when a recent message belongs to a conversation involving the user. `handle` never throws
 * and logs ids only.
 */
export class ExtractionQueue {
  constructor(private readonly deps: ExtractionQueueDeps) {}

  handle(event: DomainEvent<EventType>, tx: Tx): void {
    const messageId = (event.payload as { messageId?: unknown }).messageId;
    if (typeof messageId !== "string") return;
    try {
      // Savepoint: a failure rolls back this consumer's writes only.
      tx.transaction((sp) => this.consider(messageId, sp));
    } catch {
      console.error(`commitment extraction queueing failed for message ${messageId}`);
    }
  }

  private consider(messageId: string, tx: Tx): void {
    const { clock, settings, queue } = this.deps;
    const selfId = settings.get("slack.selfUserId");
    if (!selfId) return; // Without an identity "the user's conversation" is undefined.
    const m = tx
      .select({
        sentAt: slackMessages.sentAt,
        text: slackMessages.text,
        expiredAt: slackMessages.contentExpiredAt,
        extractedAt: slackMessages.commitmentsExtractedAt,
        senderRef: slackUsers.externalId,
        conversationId: slackMessages.conversationId,
        conversationType: slackConversations.type,
        ts: slackMessages.ts,
        threadTs: slackMessages.threadTs,
      })
      .from(slackMessages)
      .innerJoin(slackUsers, eq(slackUsers.id, slackMessages.senderUserId))
      .innerJoin(slackConversations, eq(slackConversations.id, slackMessages.conversationId))
      .where(eq(slackMessages.id, messageId))
      .get();
    if (!m || m.text === null || m.expiredAt !== null || m.extractedAt !== null) return;
    const now = clock.now().getTime();
    const sentMs = Date.parse(m.sentAt);
    // Old backfill messages are never extracted.
    if (Number.isNaN(sentMs) || sentMs < now - settings.get("people.history.days") * DAY_MS) return;
    // The user's own messages count: they make promises too.
    if (m.senderRef !== selfId && !interactsWithUser(tx, m, selfId)) return;

    const bucketMs = settings.get("commitments.extract.debounceMinutes") * MINUTE_MS;
    const bucket = Math.floor(now / bucketMs);
    queue.enqueue(tx, {
      type: EXTRACT_JOB,
      idempotencyKey: `${EXTRACT_JOB}:${bucket}`,
      runAfter: new Date((bucket + 1) * bucketMs).toISOString(),
      concurrencyGroup: COMMITMENTS_CONCURRENCY_GROUP,
      priority: EXTRACT_PRIORITY,
    });
  }
}
