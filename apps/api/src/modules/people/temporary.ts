import type { DomainEvent, EventType } from "@synapse/contracts";
import { type Db, schema, type Tx } from "@synapse/database";
import { type Clock, isoNow, newId } from "@synapse/shared";
import { and, eq, lt, notExists, sql } from "drizzle-orm";
import type { SettingsService } from "../../core/config/settings";
import type { EventPublisher } from "../../core/events/publisher";
import type { JobQueue } from "../../core/jobs/queue";
import {
  ASSESS_UNKNOWN_JOB,
  ASSESS_UNKNOWN_PRIORITY,
  PEOPLE_CONCURRENCY_GROUP,
} from "./recommendations";

export interface TemporaryContactsDeps {
  db: Db;
  clock: Clock;
  settings: SettingsService;
  events: EventPublisher;
  queue: JobQueue;
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const { slackMessages, slackUsers, people, temporaryContacts, peopleProfileRecommendations } =
  schema;

/**
 * Tracks senders Synapse has no person row for as temporary contacts (`people.temporary`
 * consumer of `message.received`). `handle` never throws and logs ids only.
 */
export class TemporaryContacts {
  constructor(private readonly deps: TemporaryContactsDeps) {}

  handle(event: DomainEvent<EventType>, tx: Tx): void {
    const messageId = (event.payload as { messageId?: unknown }).messageId;
    if (typeof messageId !== "string") return;
    try {
      // Savepoint: a failure rolls back this consumer's writes only.
      tx.transaction((sp) => this.track(messageId, event.correlationId, sp));
    } catch {
      console.error(`temporary contact tracking failed for message ${messageId}`);
    }
  }

  private track(messageId: string, correlationId: string, tx: Tx): void {
    const { clock, settings, events } = this.deps;
    const selfId = settings.get("slack.selfUserId");
    if (!selfId) return; // Without an identity the sender could be the user.
    const m = tx
      .select({ sentAt: slackMessages.sentAt, senderRef: slackUsers.externalId })
      .from(slackMessages)
      .innerJoin(slackUsers, eq(slackUsers.id, slackMessages.senderUserId))
      .where(eq(slackMessages.id, messageId))
      .get();
    if (!m || m.senderRef === selfId) return;
    const now = clock.now().getTime();
    // A backfill of old messages must not create stale temporary contacts.
    const sentMs = Date.parse(m.sentAt);
    if (Number.isNaN(sentMs)) return;
    if (sentMs < now - settings.get("people.history.days") * DAY_MS) return;
    const known = tx
      .select({ id: people.id })
      .from(people)
      .where(eq(people.slackUserId, m.senderRef))
      .get();
    if (known) return;

    const ttlMs = settings.get("people.temporaryContact.ttlDays") * DAY_MS;
    // Seen-at and expiry follow the message's own time, so a backfilled message never acts fresh.
    const seenAt = new Date(Math.min(sentMs, now)).toISOString();
    const expiresAt = new Date(sentMs + ttlMs).toISOString();
    const existing = tx
      .select({
        id: temporaryContacts.id,
        lastSeenAt: temporaryContacts.lastSeenAt,
        expiresAt: temporaryContacts.expiresAt,
        messageCount: temporaryContacts.messageCount,
      })
      .from(temporaryContacts)
      .where(eq(temporaryContacts.slackUserId, m.senderRef))
      .get();
    if (existing) {
      tx.update(temporaryContacts)
        .set({
          messageCount: sql`${temporaryContacts.messageCount} + 1`,
          lastSeenAt: seenAt > existing.lastSeenAt ? seenAt : existing.lastSeenAt,
          expiresAt: expiresAt > existing.expiresAt ? expiresAt : existing.expiresAt,
        })
        .where(eq(temporaryContacts.id, existing.id))
        .run();
      if (existing.messageCount + 1 === settings.get("people.unknown.minMessages")) {
        this.enqueueAssessment(tx);
      }
      return;
    }
    tx.insert(temporaryContacts)
      .values({
        id: newId(),
        slackUserId: m.senderRef,
        firstSeenAt: seenAt,
        lastSeenAt: seenAt,
        messageCount: 1,
        expiresAt,
      })
      .run();
    events.publish(tx, {
      type: "person.discovered",
      aggregateType: "person",
      aggregateId: m.senderRef,
      correlationId,
      payload: { slackUserId: m.senderRef },
    });
    if (settings.get("people.unknown.minMessages") <= 1) this.enqueueAssessment(tx);
  }

  /**
   * One assessment job per hour bucket, queued when a contact first reaches the threshold. It runs
   * at the end of the bucket, so every contact that crossed during the hour is in one batch.
   */
  private enqueueAssessment(tx: Tx): void {
    const { clock, queue } = this.deps;
    const bucket = isoNow(clock).slice(0, 13);
    const runAfter = new Date(Date.parse(`${bucket}:00:00.000Z`) + HOUR_MS).toISOString();
    queue.enqueue(tx, {
      type: ASSESS_UNKNOWN_JOB,
      idempotencyKey: `people.assess:${bucket}`,
      runAfter,
      concurrencyGroup: PEOPLE_CONCURRENCY_GROUP,
      priority: ASSESS_UNKNOWN_PRIORITY,
    });
  }

  /** Deletes expired temporary contacts that have no pending profile recommendation. */
  expire(): number {
    const { db, clock } = this.deps;
    const nowIso = clock.now().toISOString();
    return db.transaction(
      (tx) =>
        tx
          .delete(temporaryContacts)
          .where(
            and(
              lt(temporaryContacts.expiresAt, nowIso),
              notExists(
                tx
                  .select({ one: peopleProfileRecommendations.id })
                  .from(peopleProfileRecommendations)
                  .innerJoin(people, eq(people.id, peopleProfileRecommendations.personId))
                  .where(
                    and(
                      eq(people.slackUserId, temporaryContacts.slackUserId),
                      eq(peopleProfileRecommendations.status, "pending"),
                    ),
                  ),
              ),
            ),
          )
          .returning({ id: temporaryContacts.id })
          .all().length,
      { behavior: "immediate" },
    );
  }
}
