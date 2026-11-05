import { REMINDERS_JOB, STALL_JOB } from "../../modules/commitments/stall";
import type { CommitmentJobDeps } from "./shared";

export function registerStallAndReminders(deps: CommitmentJobDeps): void {
  const { scheduler } = deps;

  deps.handlers.set(STALL_JOB, {
    handler: async () => deps.stall.checkStalled(),
    timeoutMs: 60_000,
  });
  scheduler.upsert({ name: STALL_JOB, jobType: STALL_JOB, intervalSeconds: 3_600, coalesce: true });
  deps.handlers.set(REMINDERS_JOB, {
    handler: async () => deps.stall.sendReminders(),
    timeoutMs: 60_000,
  });
  scheduler.upsert({
    name: REMINDERS_JOB,
    jobType: REMINDERS_JOB,
    intervalSeconds: 900,
    coalesce: true,
  });
}
