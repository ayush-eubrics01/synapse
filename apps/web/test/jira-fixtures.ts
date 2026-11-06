import type { JiraIssueView } from "@synapse/contracts";

export const issue = (o: Partial<JiraIssueView> = {}): JiraIssueView => ({
  key: "DEMO-1",
  jiraId: "10001",
  projectKey: "DEMO",
  summary: "Fix the demo",
  statusName: "To Do",
  statusCategory: "new",
  priority: "High",
  issueType: "Task",
  labels: [],
  dueDate: null,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-05T00:00:00.000Z",
  webUrl: "https://example.atlassian.net/browse/DEMO-1",
  attention: null,
  inScope: true,
  slackMentions: { count: 0, latest: [] },
  ...o,
});
