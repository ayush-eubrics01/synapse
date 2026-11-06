import type { Db } from "@synapse/database";
import type { Clock } from "@synapse/shared";
import { z } from "zod";
import type { SettingsService } from "../../core/config/settings";
import type { JobQueue } from "../../core/jobs/queue";
import type { HandlerRegistration } from "../../core/jobs/worker";
import type { ClaudeOrchestrator } from "../../core/orchestrator/orchestrator";
import type { SchedulerService } from "../../core/scheduler/scheduler";
import type { HistoryItem } from "../../intelligence/people/history";
import type { ProfileRecommendations } from "../../modules/people/recommendations";
import type { TemporaryContacts } from "../../modules/people/temporary";
import type { SecurityFlagsService } from "../../modules/security-flags/service";
import { flaggedMessageOf, flagTargetOf } from "../intelligence-shared";

export interface PeopleJobDeps {
  db: Db;
  clock: Clock;
  settings: SettingsService;
  scheduler: SchedulerService;
  queue: JobQueue;
  temporary: TemporaryContacts;
  recommendations: ProfileRecommendations;
  orchestrator: Pick<ClaudeOrchestrator, "run">;
  securityFlags: SecurityFlagsService;
  handlers: Map<string, HandlerRegistration>;
}

export const EXPIRY_TIMEOUT_MS = 60_000;
export const INITIAL_TIMEOUT_MS = 420_000;
export const UPDATE_TIMEOUT_MS = 300_000;
export const UNKNOWN_TIMEOUT_MS = 300_000;
export const SECTION_NAMES = [
  "professionalContext",
  "communication",
  "responseGuidelines",
] as const;
export const UNKNOWN_BATCH = 10;
export const UNKNOWN_MESSAGES = 5;
export const HOUR_MS = 3_600_000;
export const MIN_HISTORY_ITEMS = 3;

export const inputSchema = z.object({ personId: z.string().min(1) });

/**
 * R5: the message a people run's flags attach to: the newest provided item by the person, else the
 * newest non-self item (a bystander in a shared thread). Never the user's own message (a flag on it
 * would create a people row for the user and a "Red flag: message from <me>" popup); null when only
 * the user's messages were provided, and then no flag is recorded.
 */
export function flagTarget(items: HistoryItem[]): string | null {
  return flagTargetOf(items);
}

export const flaggedMessage = flaggedMessageOf;
