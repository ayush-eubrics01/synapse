import type { Db } from "@synapse/database";
import type { Clock } from "@synapse/shared";
import type { AuditLogger } from "../../core/audit/audit";
import type { SettingsService } from "../../core/config/settings";
import type { EventPublisher } from "../../core/events/publisher";
import type { JobQueue } from "../../core/jobs/queue";
import type { HandlerRegistration } from "../../core/jobs/worker";
import type { ClaudeOrchestrator } from "../../core/orchestrator/orchestrator";
import type { SchedulerService } from "../../core/scheduler/scheduler";
import type { StallService } from "../../modules/commitments/stall";
import type { CommitmentStore } from "../../modules/commitments/store";
import type { SecurityFlagsService } from "../../modules/security-flags/service";

export const SWEEP_JOB = "commitments.extract_sweep";

export interface CommitmentJobDeps {
  db: Db;
  clock: Clock;
  settings: SettingsService;
  scheduler: SchedulerService;
  audit: AuditLogger;
  queue: JobQueue;
  orchestrator: Pick<ClaudeOrchestrator, "run">;
  securityFlags: SecurityFlagsService;
  store: CommitmentStore;
  events: EventPublisher;
  stall: StallService;
  /** Approved response guidelines of the person with this Slack user id (drafting runs only, H1). */
  guidelinesFor?: (slackUserId: string) => { name: string; texts: string[] } | null;
  handlers: Map<string, HandlerRegistration>;
}

export const EXTRACT_TIMEOUT_MS = 420_000;
export const DRAFT_TIMEOUT_MS = 420_000;
export const DRAFT_MAX_CHARS = 4000;
export const SPEC_TIMEOUT_MS = 300_000;
export const SPEC_LEAD = "A few questions so I can pick this up:";
export const CONTEXT_POOL = 200;
export const DAY_MS = 86_400_000;
export const PAGE = 200;

export interface Row {
  id: string;
  text: string;
  sentAt: string;
  ts: string;
  threadTs: string | null;
  conversationId: string;
  type: "im" | "mpim" | "channel";
  name: string | null;
  convRef: string;
  senderRef: string;
}
