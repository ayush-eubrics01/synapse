import type { SettingsService } from "../../core/config/settings";
import type { HandlerRegistration } from "../../core/jobs/worker";
import type { SchedulerService } from "../../core/scheduler/scheduler";
import type { ClaudeActivityService } from "../../modules/claude-activity/service";

export const CLAUDE_ACTIVITY_SCAN_JOB = "claude_activity.scan";
const HANDLER_TIMEOUT_MS = 60_000;

export interface ClaudeActivityJobDeps {
  handlers: Map<string, HandlerRegistration>;
  scheduler: SchedulerService;
  settings: SettingsService;
  service: Pick<ClaudeActivityService, "scan">;
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
}
