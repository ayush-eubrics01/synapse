import type { PriorityClass } from "@synapse/contracts";

/** Minimum deferral for user_active, so a stale or past `until` can never cause a spawn loop. */
export const YIELD_MIN_RETRY_MS = 2 * 60_000;

/**
 * ADR-036 amendment: only background work yields to an active user. Urgent, send and collection
 * never yield; engineering yields only when the user opted in (`yieldEngineering`).
 */
export function shouldYield(
  cls: PriorityClass,
  s: { yieldWhenActive: boolean; yieldEngineering: boolean },
  active: boolean,
): boolean {
  if (!active || !s.yieldWhenActive) return false;
  if (cls === "batch" || cls === "backfill") return true;
  return cls === "engineering" && s.yieldEngineering;
}

/** max(until, now + 2 min); an absent or unparseable `until` counts as now + 2 min. */
export function yieldRetryAfter(until: string | null, now: Date): string {
  const floor = now.getTime() + YIELD_MIN_RETRY_MS;
  const t = until === null ? Number.NaN : Date.parse(until);
  return new Date(Number.isNaN(t) ? floor : Math.max(t, floor)).toISOString();
}
