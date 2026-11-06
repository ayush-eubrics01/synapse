import type { SettingsService } from "../../core/config/settings";
import type { HandlerRegistration } from "../../core/jobs/worker";
import type { SchedulerService } from "../../core/scheduler/scheduler";
import { REMINDERS_JOB, type WipReminders } from "../../modules/claude-activity/reminders";
import type { ClaudeActivityService } from "../../modules/claude-activity/service";

export const CLAUDE_ACTIVITY_SCAN_JOB = "claude_activity.scan";
const HANDLER_TIMEOUT_MS = 60_000;
const REMINDERS_TIMEOUT_MS = 120_000;

export interface ClaudeActivityJobDeps {
  handlers: Map<string, HandlerRegistration>;
  scheduler: SchedulerService;
  settings: SettingsService;
  service: Pick<ClaudeActivityService, "scan">;
  reminders?: Pick<WipReminders, "runIfDue">;
}

/**
 * Registers `claude_activity.scan` (A7: no Claude, read-only). Coalescing plus the service's
 * in-process guard give concurrency 1.
 */
export function registerClaudeActivityJobs(deps: ClaudeActivityJobDeps): void {
  deps.handlers.set(CLAUDE_ACTIVITY_SCAN_JOB, {
    handler: async () => {
      try {
        return await deps.service.scan();
      } catch (e) {
        // Fixed form only: no path, title or session content may reach logs or job errors.
        console.error(`claude-activity: scan failed ${e instanceof Error ? e.name : "Error"}`);
        throw new Error("claude_activity scan failed");
      }
    },
    timeoutMs: HANDLER_TIMEOUT_MS,
  });
  deps.scheduler.upsert({
    name: CLAUDE_ACTIVITY_SCAN_JOB,
    jobType: CLAUDE_ACTIVITY_SCAN_JOB,
    intervalSeconds: deps.settings.get("claudeActivity.scanIntervalSeconds"),
    coalesce: true,
  });
  const reminders = deps.reminders;
  if (reminders) {
    deps.handlers.set(REMINDERS_JOB, {
      handler: async () => {
        try {
          return await reminders.runIfDue();
        } catch (e) {
          console.error(
            `claude-activity: reminders failed ${e instanceof Error ? e.name : "Error"}`,
          );
          throw new Error("claude_activity reminders failed");
        }
      },
      timeoutMs: REMINDERS_TIMEOUT_MS,
    });
    // 15 minutes covers "09:30 local, and once at startup if missed": the scheduler's cron runs in UTC.
    deps.scheduler.upsert({
      name: REMINDERS_JOB,
      jobType: REMINDERS_JOB,
      intervalSeconds: 900,
      coalesce: true,
    });
  }
}
