import { z } from "zod";

const approvalPayload = z.object({ approvalId: z.string() });

export const eventCatalog = {
  "approval.requested": approvalPayload,
  "approval.approved": approvalPayload,
  "approval.rejected": approvalPayload,
  "approval.expired": approvalPayload,
  "approval.revoked": approvalPayload,
  "approval.executed": approvalPayload,
  "settings.changed": z.object({ key: z.string() }),
  "system.heartbeat": z.object({ at: z.string() }),
};

export type EventType = keyof typeof eventCatalog;

export type EventPayload<T extends EventType> = z.infer<(typeof eventCatalog)[T]>;

export interface NewDomainEvent<T extends EventType = EventType> {
  type: T;
  version?: number;
  aggregateType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  payload: EventPayload<T>;
}

export interface DomainEvent<T extends EventType = EventType> extends NewDomainEvent<T> {
  id: string;
  version: number;
  occurredAt: string;
}

export function parseEventPayload(type: string, payload: unknown): unknown {
  if (!Object.hasOwn(eventCatalog, type)) {
    throw new Error(`unknown event type: ${type}`);
  }
  return eventCatalog[type as EventType].parse(payload);
}
