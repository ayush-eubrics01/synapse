import { z } from "zod";

export type ErrorKind =
  | "transient_network"
  | "connector_not_ready"
  | "rate_limited"
  | "quota_exhausted"
  /** The user is active in Claude Code: background work is deferred, not spawned (ADR-036). */
  | "user_active"
  | "auth_failed"
  | "auth_paused"
  | "permission_denied"
  | "invalid_input"
  | "incomplete_ai_output"
  | "parse_failed"
  | "needs_attention"
  | "provider_error"
  | "timeout"
  /** A run option's `beforeSpawn` refused just before the provider ran: nothing was spawned. */
  | "cancelled_before_spawn"
  /**
   * The CLI replaced a tool result too large for it with a notice ("exceeds maximum allowed
   * tokens" / `<persisted-output>`). Retrying the same request cannot help: a person must shrink it.
   */
  | "output_too_large"
  | "unknown";

export const errorKindSchema = z.enum([
  "transient_network",
  "connector_not_ready",
  "rate_limited",
  "quota_exhausted",
  "user_active",
  "auth_failed",
  "auth_paused",
  "permission_denied",
  "invalid_input",
  "incomplete_ai_output",
  "parse_failed",
  "needs_attention",
  "provider_error",
  "timeout",
  "cancelled_before_spawn",
  "output_too_large",
  "unknown",
] as const satisfies readonly ErrorKind[]);

export interface ClassifiedError {
  kind: ErrorKind;
  message: string;
  retryAfter?: string;
  details?: Record<string, unknown>;
}

export class JobError extends Error {
  readonly classified: ClassifiedError;

  constructor(error: ClassifiedError) {
    super(error.message);
    this.name = "JobError";
    this.classified = error;
  }
}

/**
 * An approval executor's refusal or failure, as a fixed code. The approval engine stores only the
 * code (never free text), so an executor throws this for anything the user should see by name.
 */
export class ExecutorError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ExecutorError";
  }
}

export type RetryDecision = "retry" | "needs_attention" | "fail" | "defer";

const DECISIONS: Record<ErrorKind, RetryDecision> = {
  transient_network: "retry",
  connector_not_ready: "retry",
  rate_limited: "retry",
  incomplete_ai_output: "retry",
  provider_error: "retry",
  timeout: "retry",
  unknown: "retry",
  auth_failed: "needs_attention",
  permission_denied: "needs_attention",
  parse_failed: "needs_attention",
  needs_attention: "needs_attention",
  output_too_large: "needs_attention",
  invalid_input: "fail",
  cancelled_before_spawn: "fail",
  quota_exhausted: "defer",
  user_active: "defer",
  auth_paused: "defer",
};

export function retryDecision(kind: ErrorKind): RetryDecision {
  return DECISIONS[kind];
}
