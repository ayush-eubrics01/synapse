import type { DomainEvent, EventType } from "@synapse/contracts";
import { type Db, schema, type Tx } from "@synapse/database";
import type { Clock } from "@synapse/shared";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { SettingsService } from "../../core/config/settings";
import type { JobQueue } from "../../core/jobs/queue";
import { looksLikeTaskRequest } from "../../intelligence/commitments/clarity-prompt";
import { selfMentionNeedles } from "../people/discovery";
import { interactsWithUser } from "../people/interaction";
import { COMMITMENTS_CONCURRENCY_GROUP } from "./store";

export const EXTRACT_JOB = "commitments.extract";
export const EXTRACT_PRIORITY = 50;
export const SPEC_JOB = "commitments.check_spec_clarity";
export const SPEC_PRIORITY = 45;

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const { slackMessages, slackUsers, slackConversations, followups, jobs } = schema;
const HOUR_MS = 3_600_000;
const OPEN_SPEC = ["draft", "awaiting_approval", "sending", "needs_attention"] as const;

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
        isBot: slackUsers.isBot,
      })
      .from(slackMessages)
      .innerJoin(slackUsers, eq(slackUsers.id, slackMessages.senderUserId))
      .innerJoin(slackConversations, eq(slackConversations.id, slackMessages.conversationId))
      .where(eq(slackMessages.id, messageId))
      .get();
    if (!m || m.text === null || m.expiredAt !== null) return;
    const now = clock.now().getTime();
    const sentMs = Date.parse(m.sentAt);
    // Old backfill messages are never extracted or checked.
    if (Number.isNaN(sentMs) || sentMs < now - settings.get("people.history.days") * DAY_MS) return;

    if (this.specWanted(tx, m, selfId, now, sentMs)) {
      queue.enqueue(tx, {
        type: SPEC_JOB,
        idempotencyKey: `commitments.spec:${messageId}`,
        input: { messageId, senderRef: m.senderRef },
        concurrencyGroup: COMMITMENTS_CONCURRENCY_GROUP,
        priority: SPEC_PRIORITY,
      });
    }

    if (m.extractedAt !== null) return;
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

  /** Spec clarity: a fresh task-like request from a non-bot someone, addressed to the user (R13). */
  private specWanted(
    tx: Tx,
    m: {
      text: string | null;
      senderRef: string;
      isBot: boolean | null;
      conversationId: string;
      conversationType: string;
      threadTs: string | null;
    },
    selfId: string,
    now: number,
    sentMs: number,
  ): boolean {
    const { settings } = this.deps;
    const text = m.text ?? "";
    if (m.senderRef === selfId || m.isBot === true) return false;
    if (sentMs < now - settings.get("commitments.spec.maxAgeHours") * HOUR_MS) return false;
    if (!looksLikeTaskRequest(text)) return false;
    if (m.conversationType !== "im" && !selfMentionNeedles(selfId).some((n) => text.includes(n))) {
      return false;
    }
    // One open draft per thread (per conversation when unthreaded); also stops clarify-reply loops.
    const open = tx
      .select({ id: followups.id })
      .from(followups)
      .where(
        and(
          eq(followups.origin, "spec_clarity"),
          eq(followups.conversationId, m.conversationId),
          inArray(followups.status, [...OPEN_SPEC]),
          m.threadTs ? eq(followups.threadTs, m.threadTs) : undefined,
        ),
      )
      .limit(1)
      .get();
    if (open) return false;
    // Daily caps, counted from the spec jobs queued today (UTC): per sender, and for everyone.
    const dayStart = new Date(now).toISOString().slice(0, 10);
    const today = (sender?: string) =>
      tx
        .select({ n: sql<number>`count(*)` })
        .from(jobs)
        .where(
          and(
            eq(jobs.type, SPEC_JOB),
            gte(jobs.createdAt, dayStart),
            sender === undefined
              ? undefined
              : sql`json_extract(${jobs.input}, '$.senderRef') = ${sender}`,
          ),
        )
        .get()?.n ?? 0;
    if (today() >= settings.get("commitments.spec.maxPerDay")) return false;
    return today(m.senderRef) < settings.get("commitments.spec.maxPerSenderPerDay");
  }
}
