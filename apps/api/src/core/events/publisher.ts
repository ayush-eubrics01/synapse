import { type EventType, type NewDomainEvent, parseEventPayload } from "@synapse/contracts";
import { type DbOrTx, schema } from "@synapse/database";
import { type Clock, isoNow, newId } from "@synapse/shared";

export class EventPublisher {
  constructor(private readonly clock: Clock) {}

  publish<T extends EventType>(tx: DbOrTx, e: NewDomainEvent<T>): string {
    const payload = parseEventPayload(e.type, e.payload);
    const id = newId();
    tx.insert(schema.domainEvents)
      .values({
        id,
        type: e.type,
        version: e.version ?? 1,
        aggregateType: e.aggregateType,
        aggregateId: e.aggregateId,
        correlationId: e.correlationId,
        causationId: e.causationId,
        payload,
        occurredAt: isoNow(this.clock),
      })
      .run();
    return id;
  }
}
