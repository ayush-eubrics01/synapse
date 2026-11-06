import type { HandlerRegistration } from "../../core/jobs/worker";
import type { SchedulerService } from "../../core/scheduler/scheduler";
import { DriftCheck, type DriftCheckDeps } from "../../modules/engineering-brain/drift";

export const BRAIN_DRIFT_JOB = "brain.drift_check";
const DAY_SECONDS = 86_400;
/** Each repository costs a handful of git calls with a 10 s timeout each. */
const HANDLER_TIMEOUT_MS = 10 * 60_000;

export interface DriftJobDeps extends DriftCheckDeps {
  scheduler: SchedulerService;
  handlers: Map<string, HandlerRegistration>;
}

/** Registers `brain.drift_check` (C5: no AI, read-only git) and schedules it daily, coalesced. */
export function registerDriftCheck(deps: DriftJobDeps): DriftCheck {
  const check = new DriftCheck(deps);
  deps.handlers.set(BRAIN_DRIFT_JOB, {
    handler: async () => check.run(),
    timeoutMs: HANDLER_TIMEOUT_MS,
  });
  deps.scheduler.upsert({
    name: BRAIN_DRIFT_JOB,
    jobType: BRAIN_DRIFT_JOB,
    intervalSeconds: DAY_SECONDS,
    coalesce: true,
  });
  return check;
}
