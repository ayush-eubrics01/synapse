import { z } from "zod";

export type ErrorKind =
  | "transient_network"
  | "connector_not_ready"
  | "rate_limited"
  | "quota_exhausted"
  | "auth_failed"
  | "auth_paused"
  | "permission_denied"
  | "invalid_input"
  | "incomplete_ai_output"
  | "parse_failed"
  | "provider_error"
  | "timeout"
  | "unknown";

export const errorKindSchema = z.enum([
  "transient_network",
  "connector_not_ready",
  "rate_limited",
  "quota_exhausted",
  "auth_failed",
  "auth_paused",
  "permission_denied",
  "invalid_input",
  "incomplete_ai_output",
  "parse_failed",
  "provider_error",
  "timeout",
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
  invalid_input: "fail",
  quota_exhausted: "defer",
  auth_paused: "defer",
};

export function retryDecision(kind: ErrorKind): RetryDecision {
  return DECISIONS[kind];
}
