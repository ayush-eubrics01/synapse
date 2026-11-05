import type { ClassifiedError } from "./errors";

export const JOB_STATUSES = [
  "PENDING",
  "RUNNING",
  "RETRY",
  "COMPLETED",
  "FAILED",
  "NEEDS_ATTENTION",
  "CANCELLED",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export interface Job {
  id: string;
  type: string;
  priority: number;
  status: JobStatus;
  input: unknown;
  attempts: number;
  maxAttempts: number;
  idempotencyKey: string;
  concurrencyGroup: string | null;
  runAfter: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  lastError: ClassifiedError | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
