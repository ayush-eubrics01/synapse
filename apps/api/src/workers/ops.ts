import { JobError } from "@synapse/contracts";
import { type Db, schema } from "@synapse/database";
import type { Clock } from "@synapse/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { SettingsService } from "../core/config/settings";
import type { JobQueue } from "../core/jobs/queue";
import type { HandlerRegistration } from "../core/jobs/worker";
import type { BackupResult, BackupService } from "../core/ops/backup";
import { dailyDue, type LocalTime } from "../core/ops/daily";
import type { SchedulerService } from "../core/scheduler/scheduler";

export const OPS_BACKUP_JOB = "ops.backup";
const BACKUP_TIMEOUT_MS = 600_000;

export interface OpsJobDeps {
  db: Db;
  handlers: Map<string, HandlerRegistration>;
  scheduler: SchedulerService;
  queue: JobQueue;
  settings: SettingsService;
  clock: Clock;
  backup: BackupService;
  localTime?: LocalTime;
}

export function runBackupTick(
  deps: OpsJobDeps,
): { skipped: "not_due" | "done_today" } | { date: string; backup: BackupResult | "disabled" } {
  const { settings, clock } = deps;
  const due = dailyDue(
    clock.now(),
    settings.get("ops.backup.hour"),
    settings.get("ops.backup.lastRunDate"),
    deps.localTime,
  );
  if (!due.due) return { skipped: due.reason ?? "not_due" };
  const backup = settings.get("ops.backup.enabled")
    ? deps.backup.run(settings.get("ops.backup.keep"))
    : "disabled";
  // Recorded whether it worked or not, so a failure does not retry on every 15-minute tick.
  settings.set("ops.backup.lastRunDate", due.date, { emit: false });
  return { date: due.date, backup };
}

export function backupJobLive(db: Db): boolean {
  const rows = db
    .select({ input: schema.jobs.input })
    .from(schema.jobs)
    .where(
      and(
        eq(schema.jobs.type, OPS_BACKUP_JOB),
        inArray(schema.jobs.status, ["PENDING", "RETRY", "RUNNING"]),
      ),
    )
    .all();
  return rows.some((r) => (r.input as { manual?: unknown } | null)?.manual === true);
}

export function registerOpsJobs(deps: OpsJobDeps): void {
  deps.handlers.set(OPS_BACKUP_JOB, {
    handler: async (job) => {
      const manual = (job.input as { manual?: unknown } | null)?.manual === true;
      // A manual run goes ahead even when daily backups are disabled: the user asked.
      const out = manual
        ? deps.backup.run(deps.settings.get("ops.backup.keep"))
        : runBackupTick(deps);
      const failed =
        "ok" in out ? out : "backup" in out && typeof out.backup === "object" ? out.backup : null;
      if (failed && !failed.ok) {
        // Fixed code only; non-retryable (the date is already recorded, so no 15-minute loop).
        throw new JobError({
          kind: "invalid_input",
          message: `backup_failed:${failed.failure}`,
          details: { code: failed.failure },
        });
      }
      return out;
    },
    timeoutMs: BACKUP_TIMEOUT_MS,
  });
  // 15 minutes covers "at or after the hour, and once at startup if missed" (cron runs in UTC).
  deps.scheduler.upsert({
    name: OPS_BACKUP_JOB,
    jobType: OPS_BACKUP_JOB,
    intervalSeconds: 900,
    coalesce: true,
  });
}
