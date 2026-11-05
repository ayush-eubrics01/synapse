import { z } from "zod";
import { errorKindSchema } from "./errors";
import { flagSeveritySchema, urgencyStatusSchema } from "./urgency";

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
  "claude.job_started": z.object({ runId: z.string(), jobId: z.string().nullable() }),
  "claude.job_completed": z.object({ runId: z.string() }),
  "claude.job_failed": z.object({ runId: z.string(), kind: errorKindSchema }),
  "quota.threshold_reached": z.object({
    window: z.enum(["five_hour", "seven_day"]),
    level: z.enum(["soft", "hard", "stop"]),
    resetsAt: z.string(),
  }),
  "auth.expiry_warning": z.object({ refreshExpiresAt: z.string() }),
  "message.received": z.object({ messageId: z.string() }),
  "message.thread_updated": z.object({ messageId: z.string() }),
  "collection.completed": z.object({
    stream: z.string(),
    pages: z.number().int(),
    inserted: z.number().int(),
    duplicates: z.number().int(),
    rejected: z.number().int(),
  }),
  "collection.failed": z.object({ stream: z.string(), kind: errorKindSchema }),
  "message.screened": z.object({
    messageId: z.string(),
    candidate: z.boolean(),
    score: z.number(),
    securityFlag: z.boolean(),
  }),
  "message.urgent_detected": z.object({
    messageId: z.string(),
    level: z.enum(["critical", "high"]),
    assessed: z.boolean(),
  }),
  "security.injection_suspected": z.object({
    flagId: z.string(),
    messageId: z.string().nullable(),
    severity: flagSeveritySchema,
  }),
  "security.flag_reviewed": z.object({ flagId: z.string(), status: z.string() }),
  "urgency.status_changed": z.object({ messageId: z.string(), status: urgencyStatusSchema }),
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
