import { JobError, type RawToolResult } from "@synapse/contracts";

const RATE_RE = /ratelimit|rate.limit|\b429\b/i;
const MAX_RETRY_SECONDS = 24 * 60 * 60;

/**
 * Throws a `rate_limited` JobError when an error tool result looks like a rate limit.
 * The message is fixed by the caller (no tool content); retryAfter comes from a daily limit
 * (next UTC midnight) or a retry-after value (capped at a day), else 60 seconds.
 */
export function throwIfRateLimited(results: RawToolResult[], now: Date, message: string): void {
  const hit = results.find((r) => r.isError && RATE_RE.test(r.content));
  if (!hit) return;
  let at: Date;
  if (/daily/i.test(hit.content)) {
    at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  } else {
    const secs = /retry-after\D{0,5}(\d+)/i.exec(hit.content)?.[1];
    at = new Date(now.getTime() + (secs ? Math.min(Number(secs), MAX_RETRY_SECONDS) : 60) * 1000);
  }
  throw new JobError({ kind: "rate_limited", message, retryAfter: at.toISOString() });
}
