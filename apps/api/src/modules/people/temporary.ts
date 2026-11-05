import type { DomainEvent, EventType } from "@synapse/contracts";
import { type Db, schema, type Tx } from "@synapse/database";
import { type Clock, newId } from "@synapse/shared";
import { and, eq, lt, notExists, sql } from "drizzle-orm";
import type { SettingsService } from "../../core/config/settings";
import type { EventPublisher } from "../../core/events/publisher";

export interface TemporaryContactsDeps {
  db: Db;
  clock: Clock;
  settings: SettingsService;
  events: EventPublisher;
}

const DAY_MS = 86_400_000;
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
    if (Date.parse(m.sentAt) < now - settings.get("people.history.days") * DAY_MS) return;
    const known = tx
      .select({ id: people.id })
      .from(people)
      .where(eq(people.slackUserId, m.senderRef))
      .get();
    if (known) return;

    const nowIso = new Date(now).toISOString();
    const expiresAt = new Date(
      now + settings.get("people.temporaryContact.ttlDays") * DAY_MS,
    ).toISOString();
    const existing = tx
      .select({ id: temporaryContacts.id })
      .from(temporaryContacts)
      .where(eq(temporaryContacts.slackUserId, m.senderRef))
      .get();
    if (existing) {
      tx.update(temporaryContacts)
        .set({
          messageCount: sql`${temporaryContacts.messageCount} + 1`,
          lastSeenAt: nowIso,
          expiresAt,
        })
        .where(eq(temporaryContacts.id, existing.id))
        .run();
      return;
    }
    tx.insert(temporaryContacts)
      .values({
        id: newId(),
        slackUserId: m.senderRef,
        firstSeenAt: nowIso,
        lastSeenAt: nowIso,
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
