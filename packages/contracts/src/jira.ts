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
  webUrl: z.string(),
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
});
export type JiraStatusDto = z.infer<typeof jiraStatusDtoSchema>;
