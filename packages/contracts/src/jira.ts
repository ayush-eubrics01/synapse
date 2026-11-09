import { z } from "zod";

export const JIRA_TOOL_SEARCH = "mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql";
export const JIRA_TOOL_RESOURCES = "mcp__claude_ai_Atlassian__getAccessibleAtlassianResources";

/** Spec B2: a code constant. No description and no comments (less untrusted text). */
export const JIRA_FIELDS = [
  "summary",
  "status",
  "priority",
  "issuetype",
  "project",
  "labels",
  "duedate",
  "created",
  "updated",
] as const;

/**
 * True when every `(` outside a quoted string has its `)` and every quote is closed (a
 * backslash escapes the next character inside a string). The code wraps the scope as `(<scope>)`
 * and appends its own clauses, so an unbalanced scope (`a) OR (b`) or an open string could escape
 * that wrapping and swallow the project exclusion.
 */
export function jqlBalanced(jql: string): boolean {
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

/**
 * The user's scope JQL (`jira.scope.jql`, `PUT /api/jira/settings`). Messages are fixed: a
 * validation error never echoes the scope.
 */
export const jiraScopeJqlSchema = z
  .string()
  .min(1)
  .max(500)
  .refine((v) => !/[\r\n]/.test(v), "no newlines")
  // The code wraps the scope in parentheses and appends its own ordering.
  .refine((v) => !/\border\s+by\b/i.test(v), "no ORDER BY")
  .refine(jqlBalanced, "unbalanced parentheses or quotes");

export const jiraStatusCategorySchema = z.enum(["new", "indeterminate", "done"]);
export type JiraStatusCategory = z.infer<typeof jiraStatusCategorySchema>;

export const jiraAttentionSchema = z.enum(["overdue", "blocked", "due_soon", "stale"]);
export type JiraAttention = z.infer<typeof jiraAttentionSchema>;

/** A parsed issue as read from a raw connector tool_result. Timestamps are UTC ISO instants. */
export const sourceIssueSchema = z.object({
  key: z.string().min(1),
  jiraId: z.string().min(1),
  projectKey: z.string().min(1),
  summary: z.string(),
  statusName: z.string(),
  statusCategory: jiraStatusCategorySchema,
  priority: z.string().nullable(),
  issueType: z.string(),
  labels: z.array(z.string()),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** The issue's Jira link, only when it is `https://`; null otherwise (never rendered). */
  webUrl: z.string().nullable(),
});
export type SourceIssue = z.infer<typeof sourceIssueSchema>;

export const jiraSlackMentionsSchema = z.object({
  count: z.number().int().nonnegative(),
  latest: z.array(
    z.object({
      messageId: z.string(),
      conversationLabel: z.string(),
      sentAt: z.string(),
      permalink: z.string().nullable(),
    }),
  ),
});
export type JiraSlackMentions = z.infer<typeof jiraSlackMentionsSchema>;

export const jiraIssueViewSchema = sourceIssueSchema.extend({
  attention: jiraAttentionSchema.nullable(),
  inScope: z.boolean(),
  slackMentions: jiraSlackMentionsSchema,
});
export type JiraIssueView = z.infer<typeof jiraIssueViewSchema>;

export const jiraStatusDtoSchema = z.object({
  enabled: z.boolean(),
  cloudIdSet: z.boolean(),
  lastSyncAt: z.string().nullable(),
  lastReconcileAt: z.string().nullable(),
  issueCount: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  /** The stored `jira.scope.jql` and `jira.excludedProjects` (local settings, never logged). */
  scopeJql: z.string(),
  excludedProjects: z.array(z.string()),
  /** Candidate sites to choose from while no cloudId is set (id and display name only). */
  sites: z.array(z.object({ id: z.string(), name: z.string() })),
});
export type JiraStatusDto = z.infer<typeof jiraStatusDtoSchema>;

/**
 * The read port the Jira workers use (the `jira/claude-connector` adapter implements it). One call
 * is one page or one resource lookup; each is a separate collector run.
 */
export interface JiraIssueSource {
  resolveCloudId(signal: AbortSignal): Promise<{ id: string; url: string; name: string }[]>;
  searchPage(
    args: { cloudId: string; jql: string; maxResults: number; nextPageToken?: string },
    signal: AbortSignal,
  ): Promise<{ issues: SourceIssue[]; nextPageToken: string | null; total: number | null }>;
}

export const jiraIssueViewKindSchema = z.enum(["attention", "open", "done", "all"]);
export type JiraIssueViewKind = z.infer<typeof jiraIssueViewKindSchema>;
