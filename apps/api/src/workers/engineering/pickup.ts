import type { HandlerRegistration } from "../../core/jobs/worker";
import type { SchedulerService } from "../../core/scheduler/scheduler";
import type { EngineeringLock } from "../../modules/engineering-tasks/lock";
import {
  type EngineeringTaskService,
  LOCK_RENEW_JOB,
  PICKUP_JOB,
} from "../../modules/engineering-tasks/service";

/** Preflight runs a handful of local git calls, each with its own 60 s timeout. */
const PICKUP_TIMEOUT_MS = 5 * 60_000;
const RENEW_TIMEOUT_MS = 30_000;

export interface PickupJobDeps {
  service: Pick<EngineeringTaskService, "pickupNext">;
  lock: Pick<EngineeringLock, "renew">;
  scheduler: Pick<SchedulerService, "upsert">;
  handlers: Map<string, HandlerRegistration>;
}

/**
 * E6 schedules:
 * - `engineering.pickup` every minute: when the lock is free, the next queued task (highest
 *   priority, then oldest) takes it, passes preflight (E7) and moves to `in_progress`, and an
 *   `engineering.step` job `{taskId, step: "branch"}` is enqueued. That job type belongs to the
 *   step runner (Task 5); nothing here handles it.
 * - `engineering.lock_renew` every 2 minutes: extends the lease while the holder is active.
 * Both coalesce, so a slow tick never builds a backlog.
 */
export function registerPickupJobs(deps: PickupJobDeps): void {
  deps.handlers.set(PICKUP_JOB, {
    handler: async () => deps.service.pickupNext(),
    timeoutMs: PICKUP_TIMEOUT_MS,
  });
  deps.handlers.set(LOCK_RENEW_JOB, {
    handler: async () => ({ renewed: deps.lock.renew() }),
    timeoutMs: RENEW_TIMEOUT_MS,
  });
  deps.scheduler.upsert({
    name: PICKUP_JOB,
    jobType: PICKUP_JOB,
    intervalSeconds: 60,
    coalesce: true,
  });
  deps.scheduler.upsert({
    name: LOCK_RENEW_JOB,
    jobType: LOCK_RENEW_JOB,
    intervalSeconds: 120,
    coalesce: true,
  });
}
