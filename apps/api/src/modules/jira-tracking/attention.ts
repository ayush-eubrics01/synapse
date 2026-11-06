import type { JiraAttention, JiraStatusCategory } from "@synapse/contracts";
import { addDays, localDate } from "@synapse/shared";

export interface AttentionInput {
  inScope: boolean;
  statusCategory: JiraStatusCategory;
  statusName: string;
  labels: readonly string[];
  /** Calendar date `YYYY-MM-DD`. */
  dueDate: string | null;
  /** UTC ISO instant. */
  updatedAt: string;
}

export interface AttentionSettings {
  staleDays: number;
  dueSoonDays: number;
  blockedStatuses: readonly string[];
  /** IANA zone for "today"; undefined means the API process's zone. */
  timeZone?: string;
}

const DAY_MS = 86_400_000;

/** Shared with the engineering brain's milestone dates; re-exported for existing callers. */
export { localDate };

function isBlocked(issue: AttentionInput, configured: readonly string[]): boolean {
  const status = issue.statusName.toLowerCase();
  if (configured.some((s) => s.toLowerCase() === status)) return true;
  if (/block/i.test(issue.statusName)) return true;
  return issue.labels.some((l) => /^blocked$/i.test(l));
}

/**
 * Spec B9, first match wins: overdue, blocked, due_soon, stale. Only in-scope issues that are not
 * done get attention. Due dates compare as local calendar dates; staleness uses instants.
 */
export function attentionOf(
  issue: AttentionInput,
  now: Date,
  settings: AttentionSettings,
): JiraAttention | null {
  if (!issue.inScope || issue.statusCategory === "done") return null;
  const today = localDate(now, settings.timeZone);
  if (issue.dueDate !== null && issue.dueDate < today) return "overdue";
  if (isBlocked(issue, settings.blockedStatuses)) return "blocked";
  if (issue.dueDate !== null && issue.dueDate <= addDays(today, settings.dueSoonDays)) {
    return "due_soon";
  }
  const updated = Date.parse(issue.updatedAt);
  if (!Number.isNaN(updated) && now.getTime() - updated >= settings.staleDays * DAY_MS) {
    return "stale";
  }
  return null;
}
