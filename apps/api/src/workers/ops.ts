import { JobError } from "@synapse/contracts";
import { type Db, schema } from "@synapse/database";
import type { Clock } from "@synapse/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { SettingsService } from "../core/config/settings";
import type { JobQueue } from "../core/jobs/queue";
import type { HandlerRegistration } from "../core/jobs/worker";
import type { BackupResult, BackupService } from "../core/ops/backup";
import { dailyDue, type LocalTime } from "../core/ops/daily";
import { BACKUP_WORKER_TIMEOUT_MS } from "../core/ops/db-task";
import type { RetentionService } from "../core/ops/retention";
import type { SchedulerService } from "../core/scheduler/scheduler";

export const OPS_BACKUP_JOB = "ops.backup";
export const OPS_RETENTION_JOB = "ops.retention";
const BACKUP_TIMEOUT_MS = BACKUP_WORKER_TIMEOUT_MS + 60_000;
const RETENTION_TIMEOUT_MS = 600_000;

export interface OpsJobDeps {
  db: Db;
  handlers: Map<string, HandlerRegistration>;
  scheduler: SchedulerService;
  queue: JobQueue;
  settings: SettingsService;
  clock: Clock;
  backup: BackupService;
  retention: RetentionService;
  localTime?: LocalTime;
}

export async function runBackupTick(
  deps: OpsJobDeps,
): Promise<
  { skipped: "not_due" | "done_today" } | { date: string; backup: BackupResult | "disabled" }
> {
  const { settings, clock } = deps;
  const due = dailyDue(
    clock.now(),
    settings.get("ops.backup.hour"),
    settings.get("ops.backup.lastRunDate"),
    deps.localTime,
  );
  if (!due.due) return { skipped: due.reason ?? "not_due" };
  const backup = settings.get("ops.backup.enabled")
    ? await deps.backup.run(settings.get("ops.backup.keep"))
    : "disabled";
  // Another backup is in flight: nothing was attempted, so the date stays unrecorded and the
  // next tick tries again.
  if (typeof backup === "object" && !backup.ok && backup.failure === "already_running") {
    return { date: due.date, backup };
  }
  // Recorded whether it worked or not, so a failure does not retry on every 15-minute tick.
  settings.set("ops.backup.lastRunDate", due.date, { emit: false });
  // Retention follows the backup attempt (including a disabled one); the key makes it once a day.
  deps.queue.enqueue(deps.db, {
    type: OPS_RETENTION_JOB,
    input: { date: due.date },
    idempotencyKey: `ops.retention:${due.date}`,
  });
  return { date: due.date, backup };
}

export function backupJobLive(db: Db): boolean {
  const rows = db
    .select({ id: schema.jobs.id })
    .from(schema.jobs)
    .where(
      and(
        eq(schema.jobs.type, OPS_BACKUP_JOB),
        inArray(schema.jobs.status, ["PENDING", "RETRY", "RUNNING"]),
      ),
    )
    .all();
  return rows.length > 0;
}

export function registerOpsJobs(deps: OpsJobDeps): void {
  deps.handlers.set(OPS_BACKUP_JOB, {
    handler: async (job) => {
      const manual = (job.input as { manual?: unknown } | null)?.manual === true;
      // A manual run goes ahead even when daily backups are disabled: the user asked.
      const out = manual
        ? await deps.backup.run(deps.settings.get("ops.backup.keep"))
        : await runBackupTick(deps);
      const failed =
        "ok" in out ? out : "backup" in out && typeof out.backup === "object" ? out.backup : null;
      if (failed && !failed.ok && failed.failure === "already_running") {
        // Not a failure: another backup is running. No alarm, no recorded date.
        return { skipped: "already_running" };
      }
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
  deps.handlers.set(OPS_RETENTION_JOB, {
    handler: async (job, ctx) => {
      const date = (job.input as { date?: unknown } | null)?.date;
      if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new JobError({ kind: "invalid_input", message: "retention_bad_input" });
      }
      if (deps.settings.get("ops.retention.lastRun")?.date === date) {
        return { skipped: "done_today" };
      }
      return deps.retention.run(date, ctx.signal);
    },
    timeoutMs: RETENTION_TIMEOUT_MS,
  });
  // 15 minutes covers "at or after the hour, and once at startup if missed" (cron runs in UTC).
  deps.scheduler.upsert({
    name: OPS_BACKUP_JOB,
    jobType: OPS_BACKUP_JOB,
    intervalSeconds: 900,
    coalesce: true,
  });
}
