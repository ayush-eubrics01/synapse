import type { DomainEvent, EventType } from "@synapse/contracts";
import { type Db, schema, type Tx } from "@synapse/database";
import { backoffMs, type Clock, isoNow, newId } from "@synapse/shared";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { LiveBus } from "./live-bus.ts";

export type EventHandler = (event: DomainEvent<EventType>, tx: Tx) => void;

interface Subscription {
  consumer: string;
  handler: EventHandler;
}

export class OutboxDispatcher {
  private readonly subscriptions = new Map<string, Subscription[]>();
  private readonly maxAttempts: number;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly live: LiveBus,
    opts: { maxAttempts?: number } = {},
  ) {
    this.maxAttempts = opts.maxAttempts ?? 3;
  }

  subscribe(type: EventType, consumer: string, handler: EventHandler): void {
    const list = this.subscriptions.get(type) ?? [];
    list.push({ consumer, handler });
    this.subscriptions.set(type, list);
  }

  /** `delivered` counts handler runs that succeeded, `failed` counts handler runs that threw. */
  dispatchOnce(limit = 100): { delivered: number; failed: number } {
    // Order: occurred_at, then rowid (insertion order) so same-millisecond events keep publish order.
    const rows = this.db
      .select()
      .from(schema.domainEvents)
      .where(isNull(schema.domainEvents.dispatchedAt))
      .orderBy(asc(schema.domainEvents.occurredAt), sql`rowid`)
      .limit(limit)
      .all();

    let delivered = 0;
    let failed = 0;
    for (const row of rows) {
      const event = {
        id: row.id,
        type: row.type as EventType,
        version: row.version,
        aggregateType: row.aggregateType,
        aggregateId: row.aggregateId,
        correlationId: row.correlationId ?? "",
        causationId: row.causationId ?? undefined,
        payload: row.payload,
        occurredAt: row.occurredAt,
      } as DomainEvent<EventType>;

      let settled = true;
      for (const sub of this.subscriptions.get(row.type) ?? []) {
        const outcome = this.deliver(event, sub);
        if (outcome === "done") delivered++;
        else if (outcome === "retry" || outcome === "failed") {
          failed++;
          if (outcome === "retry") settled = false;
        } else if (outcome === "waiting") settled = false;
      }
      if (!settled) continue;

      this.db
        .update(schema.domainEvents)
        .set({ dispatchedAt: isoNow(this.clock) })
        .where(eq(schema.domainEvents.id, row.id))
        .run();
      this.live.publish({ type: row.type, data: event });
    }
    return { delivered, failed };
  }

  private deliver(
    event: DomainEvent<EventType>,
    sub: Subscription,
  ): "done" | "retry" | "failed" | "skipped" | "waiting" {
    const existing = this.db
      .select()
      .from(schema.eventConsumptions)
      .where(
        and(
          eq(schema.eventConsumptions.consumer, sub.consumer),
          eq(schema.eventConsumptions.eventId, event.id),
        ),
      )
      .get();
    if (existing?.status === "done" || existing?.status === "failed") return "skipped";
    if (existing?.nextAttemptAt && existing.nextAttemptAt > isoNow(this.clock)) return "waiting";

    try {
      this.db.transaction((tx) => {
        sub.handler(event, tx);
        tx.insert(schema.eventConsumptions)
          .values({
            id: existing?.id ?? newId(),
            consumer: sub.consumer,
            eventId: event.id,
            status: "done",
            attempts: (existing?.attempts ?? 0) + 1,
          })
          .onConflictDoUpdate({
            target: [schema.eventConsumptions.consumer, schema.eventConsumptions.eventId],
            set: {
              status: "done",
              attempts: (existing?.attempts ?? 0) + 1,
              lastError: null,
              nextAttemptAt: null,
            },
          })
          .run();
      });
      return "done";
    } catch (err) {
      const attempts = (existing?.attempts ?? 0) + 1;
      const status = attempts >= this.maxAttempts ? "failed" : "pending";
      const nextAttemptAt =
        status === "failed"
          ? null
          : new Date(
              this.clock.now().getTime() + backoffMs(attempts, { baseMs: 5_000, maxMs: 300_000 }),
            ).toISOString();
      const lastError = { message: err instanceof Error ? err.message : String(err) };
      this.db
        .insert(schema.eventConsumptions)
        .values({
          id: newId(),
          consumer: sub.consumer,
          eventId: event.id,
          status,
          attempts,
          lastError,
          nextAttemptAt,
        })
        .onConflictDoUpdate({
          target: [schema.eventConsumptions.consumer, schema.eventConsumptions.eventId],
          set: { status, attempts, lastError, nextAttemptAt },
        })
        .run();
      return status === "failed" ? "failed" : "retry";
    }
  }
}
