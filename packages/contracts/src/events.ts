import { z } from "zod";
import { holdReasonSchema } from "./auto-reply";
import { factStatusSchema } from "./brain";
import { codeAnswerStatusSchema } from "./code-answers";
import {
  engineeringStepSchema,
  engineeringStepStatusSchema,
  engineeringTaskStatusSchema,
} from "./engineering";
import { errorKindSchema } from "./errors";
import { jiraAttentionSchema } from "./jira";
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
  "person.discovered": z.object({ slackUserId: z.string() }),
  "person.profile_recommendation_created": z.object({
    recommendationId: z.string(),
    personId: z.string(),
    kind: z.enum(["initial", "update", "suggest_evaluation"]),
  }),
  "person.profile_approved": z.object({ personId: z.string(), version: z.number().int() }),
  "person.recommendation_decided": z.object({ recommendationId: z.string(), status: z.string() }),
  "commitment.detected": z.object({ commitmentId: z.string() }),
  "commitment.reviewed": z.object({
    commitmentId: z.string(),
    reviewStatus: z.enum(["pending_review", "accepted", "rejected"]),
  }),
  "commitment.status_changed": z.object({
    commitmentId: z.string(),
    status: z.enum(["open", "in_progress", "blocked", "completed", "cancelled"]),
  }),
  "commitment.stalled": z.object({ commitmentId: z.string() }),
  "commitment.overdue": z.object({ commitmentId: z.string() }),
  "followup.draft_created": z.object({ followupId: z.string() }),
  "followup.status_changed": z.object({ followupId: z.string(), status: z.string() }),
  "followup.sent": z.object({ followupId: z.string(), outgoingId: z.string() }),
  "outgoing.status_changed": z.object({ outgoingId: z.string(), status: z.string() }),
  "autoreply.sent": z.object({ autoReplyId: z.string() }),
  "autoreply.held": z.object({ autoReplyId: z.string(), reason: holdReasonSchema }),
  "away.changed": z.object({ on: z.boolean() }),
  "claude_session.activity_changed": z.object({
    active: z.boolean(),
    lastActiveAt: z.string().nullable(),
  }),
  "code_answer.status_changed": z.object({
    codeAnswerId: z.string(),
    messageId: z.string(),
    status: codeAnswerStatusSchema,
  }),
  "jira.issue_updated": z.object({ key: z.string() }),
  "jira.issue_attention": z.object({ key: z.string(), attention: jiraAttentionSchema }),
  "repo.registered": z.object({ repositoryId: z.string() }),
  "repo.drift_detected": z.object({ repositoryId: z.string() }),
  "brain.facts_proposed": z.object({ projectId: z.string(), count: z.number().int() }),
  "brain.fact_decided": z.object({ factId: z.string(), status: factStatusSchema }),
  "engineering.task_created": z.object({ taskId: z.string() }),
  "engineering.task_status_changed": z.object({
    taskId: z.string(),
    status: engineeringTaskStatusSchema,
  }),
  "engineering.step_changed": z.object({
    taskId: z.string(),
    step: engineeringStepSchema,
    status: engineeringStepStatusSchema,
  }),
  "engineering.lock_changed": z.object({ held: z.boolean() }),
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
