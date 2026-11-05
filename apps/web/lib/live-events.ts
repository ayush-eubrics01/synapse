import type { EventType } from "@synapse/contracts";

// Domain events forwarded to SSE by the dispatcher. system.heartbeat is never published.
const DOMAIN_EVENTS = [
  "approval.requested",
  "approval.approved",
  "approval.rejected",
  "approval.expired",
  "approval.revoked",
  "approval.executed",
  "settings.changed",
  "claude.job_started",
  "claude.job_completed",
  "claude.job_failed",
  "quota.threshold_reached",
  "auth.expiry_warning",
  "message.received",
  "message.thread_updated",
  "collection.completed",
  "collection.failed",
  "message.screened",
  "message.urgent_detected",
  "security.injection_suspected",
  "security.flag_reviewed",
  "urgency.status_changed",
] as const satisfies readonly EventType[];

// LiveBus-only messages: job settles (worker) and notifications (NotificationService).
export const LIVE_EVENT_TYPES = [...DOMAIN_EVENTS, "job.updated", "notification"] as const;
