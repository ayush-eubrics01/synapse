import { type ClassifiedError, type JobStatus, retryDecision } from "@synapse/contracts";
import { backoffMs } from "@synapse/shared";

export const QUOTA_DEFER_MS = 15 * 60_000;

/** lastError of an external-write job whose outcome is uncertain (timeout, stop, crash). */
export const UNCERTAIN_EXTERNAL_ERROR: ClassifiedError = {
  kind: "unknown",
  message: "verify external outcome before retry",
};

/** The column, or the legacy `input.externalWrite` flag used before the column existed. */
export function isExternalWrite(job: { externalWrite: boolean; input: unknown }): boolean {
  return (
    job.externalWrite || (job.input as { externalWrite?: unknown } | null)?.externalWrite === true
  );
}

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
