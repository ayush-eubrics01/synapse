import { JIRA_JOB } from "../../modules/jira-tracking/service";
import { reconcileHandler } from "./reconcile";
import { resolveCloudIdHandler } from "./resolve-cloud-id";
import type { JiraJobDeps } from "./shared";
import { syncHandler } from "./sync";

export type { JiraJobDeps } from "./shared";

/** Headroom over the per-run collector timeouts for storage and bookkeeping. */
const HANDLER_SLACK_SECONDS = 60;

/**
 * Registers `jira.resolve_cloud_id`, `jira.sync_incremental` and `jira.reconcile`, and schedules
 * the last two (coalesced, R58). Every handler returns early while `jira.enabled` is false, and
 * sync and reconcile while no cloudId is set, so a schedule never runs Claude for a disabled
 * integration. The cloudId lookup has no schedule: enabling Jira or a manual sync queues it.
 * Intervals and the page budget are read at startup (a change applies after a restart).
 */
export function registerJiraJobs(deps: JiraJobDeps): void {
  const { settings, scheduler, handlers } = deps;
  const runSeconds = settings.get("orchestrator.timeouts.collector");
  const pagedTimeoutMs =
    (settings.get("jira.maxPagesPerRun") * runSeconds + HANDLER_SLACK_SECONDS) * 1000;

  handlers.set(JIRA_JOB.resolveCloudId, {
    handler: resolveCloudIdHandler(deps),
    timeoutMs: (runSeconds + HANDLER_SLACK_SECONDS) * 1000,
  });
  handlers.set(JIRA_JOB.sync, { handler: syncHandler(deps), timeoutMs: pagedTimeoutMs });
  handlers.set(JIRA_JOB.reconcile, { handler: reconcileHandler(deps), timeoutMs: pagedTimeoutMs });

  scheduler.upsert({
    name: JIRA_JOB.sync,
    jobType: JIRA_JOB.sync,
    intervalSeconds: settings.get("jira.sync.intervalMinutes") * 60,
    coalesce: true,
  });
  scheduler.upsert({
    name: JIRA_JOB.reconcile,
    jobType: JIRA_JOB.reconcile,
    intervalSeconds: settings.get("jira.reconcile.hours") * 3600,
    coalesce: true,
  });
}
