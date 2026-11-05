import type { UrgencyLevel } from "@synapse/contracts";
import type { Db } from "@synapse/database";
import type { Clock } from "@synapse/shared";
import type { SettingsService } from "../../core/config/settings";
import type { EventPublisher } from "../../core/events/publisher";
import type { JobQueue } from "../../core/jobs/queue";
import type { HandlerRegistration } from "../../core/jobs/worker";
import type { NotificationService } from "../../core/notifications/notifications";
import type { ClaudeOrchestrator } from "../../core/orchestrator/orchestrator";
import type { AssessBatchItem } from "../../intelligence/urgency/assess-prompt";
import type { SecurityFlagsService } from "../../modules/security-flags/service";

export interface UrgencyJobDeps {
  db: Db;
  clock: Clock;
  settings: SettingsService;
  events: EventPublisher;
  queue: JobQueue;
  notifications: NotificationService;
  orchestrator: Pick<ClaudeOrchestrator, "run">;
  securityFlags: SecurityFlagsService;
  handlers: Map<string, HandlerRegistration>;
  /** Approved response guidelines of the person with this Slack user id; null without a profile. */
  guidelinesFor?: (slackUserId: string) => { name: string; texts: string[] } | null;
}

export const ASSESS_TIMEOUT_MS = 360_000;
export const SUGGEST_TIMEOUT_MS = 360_000;
export const DRAFT_MAX_CHARS = 2000;
export const FALLBACK_REASON = "Rule-based (assessment unavailable)";
export const LEVEL_TITLE: Record<UrgencyLevel, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

export interface BatchRow extends AssessBatchItem {
  conversationType: "im" | "mpim" | "channel";
}

export const conversationLabel = (
  type: "im" | "mpim" | "channel",
  name: string | null,
  ref: string,
) => (type === "im" ? "a DM" : type === "mpim" ? "a group DM" : `#${name ?? ref}`);

export const isUrgent = (l: UrgencyLevel): l is "critical" | "high" =>
  l === "critical" || l === "high";
