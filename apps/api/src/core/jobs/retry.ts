import { type ClassifiedError, type JobStatus, retryDecision } from "@synapse/contracts";
import { backoffMs } from "@synapse/shared";

export const QUOTA_DEFER_MS = 15 * 60_000;

export type FailureOutcome =
  | { status: "RETRY" | "DEFER"; runAfter: string }
  | { status: Exclude<JobStatus, "RETRY" | "PENDING" | "RUNNING" | "COMPLETED" | "CANCELLED"> };

/** Decides what happens to a job after a classified failure. `attempts` is 1-based (after the claim). */
export function decideFailure(
  error: ClassifiedError,
  attempts: number,
  maxAttempts: number,
  now: Date,
  random?: () => number,
): FailureOutcome {
  switch (retryDecision(error.kind)) {
    case "fail":
      return { status: "FAILED" };
    case "needs_attention":
      return { status: "NEEDS_ATTENTION" };
    case "defer":
      return {
        status: "DEFER",
        runAfter: error.retryAfter ?? new Date(now.getTime() + QUOTA_DEFER_MS).toISOString(),
      };
    case "retry": {
      if (attempts >= maxAttempts) return { status: "NEEDS_ATTENTION" };
      const delay = backoffMs(attempts, random ? { random } : {});
      return {
        status: "RETRY",
        runAfter: error.retryAfter ?? new Date(now.getTime() + delay).toISOString(),
      };
    }
  }
}
