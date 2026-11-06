import type { JiraIssueView } from "@synapse/contracts";
import type { PaletteItem } from "./palette";

const PROJECT_KEY = /^[A-Z][A-Z0-9_]+$/;
const DAY_MS = 86_400_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export type JiraGroupId = "attention" | "progress" | "todo" | "done";
export interface JiraGroup {
  id: JiraGroupId;
  label: string;
  issues: JiraIssueView[];
}

/** In-scope issues in the four display groups (spec B12); a done issue never needs attention. */
export function groupIssues(issues: JiraIssueView[]): JiraGroup[] {
  const groups: JiraGroup[] = [
    { id: "attention", label: "Needs attention", issues: [] },
    { id: "progress", label: "In progress", issues: [] },
    { id: "todo", label: "To do", issues: [] },
    { id: "done", label: "Done recently", issues: [] },
  ];
  const by = (id: JiraGroupId) => groups.find((g) => g.id === id) as JiraGroup;
  for (const i of issues) {
    if (!i.inScope) continue;
    if (i.statusCategory === "done") by("done").issues.push(i);
    else if (i.attention !== null) by("attention").issues.push(i);
    else if (i.statusCategory === "indeterminate") by("progress").issues.push(i);
    else by("todo").issues.push(i);
  }
  return groups;
}

/** The attention chip's text; null when the issue has none. Stale needs the clock for its days. */
export function attentionLabel(i: JiraIssueView, now: Date | null): string | null {
  switch (i.attention) {
    case null:
      return null;
    case "overdue":
      return "Overdue";
    case "blocked":
      return "Blocked";
    case "due_soon":
      return "Due soon";
    case "stale": {
      const t = Date.parse(i.updatedAt);
      if (now === null || Number.isNaN(t)) return "Stale";
      const days = Math.max(0, Math.floor((now.getTime() - t) / DAY_MS));
      return `No update in ${days} ${days === 1 ? "day" : "days"}`;
    }
  }
}

function localDate(ymd: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

/** "Due Fri 7 Nov", or "Overdue by 2 days" (red) once past, for an open issue. */
export function dueLabel(
  i: JiraIssueView,
  now: Date | null,
): { text: string; overdue: boolean } | null {
  if (i.dueDate === null) return null;
  const due = localDate(i.dueDate);
  if (due === null) return null;
  if (now !== null && i.statusCategory !== "done") {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const days = Math.round((today.getTime() - due.getTime()) / DAY_MS);
    if (days > 0)
      return { text: `Overdue by ${days} ${days === 1 ? "day" : "days"}`, overdue: true };
  }
  const text = `Due ${WEEKDAYS[due.getDay()]} ${due.getDate()} ${MONTHS[due.getMonth()]}`;
  return { text, overdue: false };
}

/**
 * The server's `jqlBalanced` (packages/contracts/src/jira.ts), mirrored so the web bundle does not
 * pull in the contracts runtime: parentheses balance outside quoted strings, and every
 * string is closed (a backslash escapes the next character inside one).
 */
function jqlBalanced(jql: string): boolean {
  let depth = 0;
  // JQL strings use double or single quotes; parentheses inside either kind don't count.
  let quote: string | null = null;
  for (let i = 0; i < jql.length; i++) {
    const ch = jql[i];
    if (quote !== null) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth < 0) return false;
  }
  return depth === 0 && quote === null;
}

/** Fixed hints for status `lastError` values a person must act on; other kinds show as they are. */
const ERROR_HINTS: Record<string, string> = {
  multiple_sites: "Several Jira sites are available — set jira.cloudId in settings",
  no_sites: "No Jira site is available to this Claude account",
  output_too_large: "Jira page too large — lower jira.pageSize",
};

/** The status line text for `JiraStatusDto.lastError`; null when there is none. */
export function jiraErrorLabel(lastError: string | null): string | null {
  if (lastError === null) return null;
  return ERROR_HINTS[lastError] ?? lastError;
}

export type JiraSetupResult =
  | { ok: true; scopeJql: string; excludedProjects: string[] }
  | { ok: false; scopeError: string | null; excludedError: string | null };

/** The server's rules (routes/jira.ts), checked first so the user sees the problem inline. */
export function validateJiraSetup(scope: string, excluded: string): JiraSetupResult {
  const scopeJql = scope.trim();
  let scopeError: string | null = null;
  if (scopeJql === "") scopeError = "Scope can't be empty.";
  else if (scopeJql.length > 500) scopeError = "Scope is limited to 500 characters.";
  else if (/[\r\n]/.test(scopeJql)) scopeError = "Scope must be one line.";
  else if (/\border\s+by\b/i.test(scopeJql)) scopeError = "Scope can't contain ORDER BY.";
  else if (!jqlBalanced(scopeJql)) scopeError = "Scope has unbalanced parentheses or quotes.";
  const projects = excluded
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "");
  const bad = projects.filter((p) => !PROJECT_KEY.test(p));
  const excludedError =
    bad.length > 0
      ? `Not a project key: ${bad.join(", ")}. Use capitals, digits and _, starting with a letter (e.g. DEMO).`
      : null;
  if (scopeError || excludedError) return { ok: false, scopeError, excludedError };
  return { ok: true, scopeJql, excludedProjects: [...new Set(projects)] };
}

export const jiraRowId = (key: string) => `jira-issue-${key}`;

const LABEL_MAX = 60;

/** "Sync Jira now" plus one entry per open issue; nothing while Jira is off. */
export function jiraPaletteItems(
  issues: JiraIssueView[],
  enabled: boolean,
  on: { sync: () => void; open: (key: string) => void },
): PaletteItem[] {
  if (!enabled) return [];
  const open = issues.filter((i) => i.inScope && i.statusCategory !== "done");
  return [
    { id: "act-jira-sync", label: "Sync Jira now", group: "action", run: on.sync },
    ...open.map(
      (i): PaletteItem => ({
        id: `jira-${i.key}`,
        label: `${i.key} · ${i.summary.length > LABEL_MAX ? `${i.summary.slice(0, LABEL_MAX)}…` : i.summary}`,
        group: "jira",
        run: () => on.open(i.key),
      }),
    ),
  ];
}
