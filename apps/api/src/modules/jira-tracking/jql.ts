/** Spec B7: only keys of this shape ever reach JQL. */
export const PROJECT_KEY_RE = /^[A-Z][A-Z0-9_]+$/;

const MIN_PER_DAY = 1440;
/** Spec B5: overlap that absorbs clock skew between Synapse and Jira. */
const OVERLAP_MINUTES = 5;

/** `(<scope>)`, plus `AND project not in (...)` when any project is excluded (spec B7). */
export function withExclusions(scope: string, excluded: readonly string[]): string {
  for (const k of excluded) {
    if (!PROJECT_KEY_RE.test(k)) throw new Error("invalid jira project key");
  }
  const base = `(${scope})`;
  return excluded.length > 0 ? `${base} AND project not in (${excluded.join(", ")})` : base;
}

/** Spec B5: relative minutes avoid JQL time-zone ambiguity. */
export function incrementalJql(
  scope: string,
  excluded: readonly string[],
  minutes: number,
): string {
  if (!Number.isInteger(minutes) || minutes < 1) throw new Error("invalid sync window");
  return `${withExclusions(scope, excluded)} AND updated >= -${minutes}m ORDER BY updated ASC`;
}

/** Spec B6: the full scope, every page. */
export function reconcileJql(scope: string, excluded: readonly string[]): string {
  return `${withExclusions(scope, excluded)} ORDER BY updated ASC`;
}

/**
 * Spec B5: `ceil(minutes since checkpoint) + 5`, capped at `windowDays*1440`; the full window when
 * there is no checkpoint. Never below 1 (a checkpoint ahead of the local clock still overlaps).
 */
export function syncMinutes(checkpoint: string | null, now: Date, windowDays: number): number {
  const cap = Math.max(1, Math.floor(windowDays * MIN_PER_DAY));
  if (checkpoint === null) return cap;
  const t = Date.parse(checkpoint);
  if (Number.isNaN(t)) return cap;
  const elapsed = Math.max(0, Math.ceil((now.getTime() - t) / 60_000));
  return Math.max(1, Math.min(cap, elapsed + OVERLAP_MINUTES));
}
