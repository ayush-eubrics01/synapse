export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  jitter?: number;
  random?: () => number;
}

const DEFAULT_BASE_MS = 30_000;
const DEFAULT_MAX_MS = 1_800_000;
const DEFAULT_JITTER = 0.2;

/**
 * Exponential backoff for a 1-based attempt number: base * 2^(attempt - 1),
 * capped at maxMs, then scaled by a jitter factor in [1 - jitter, 1 + jitter].
 */
export function backoffMs(attempt: number, opts: BackoffOptions = {}): number {
  const baseMs = opts.baseMs ?? DEFAULT_BASE_MS;
  const maxMs = opts.maxMs ?? DEFAULT_MAX_MS;
  const jitter = opts.jitter ?? DEFAULT_JITTER;
  const random = opts.random ?? Math.random;

  const capped = Math.min(baseMs * 2 ** (attempt - 1), maxMs);
  const factor = 1 - jitter + 2 * jitter * random();
  return Math.round(capped * factor);
}
