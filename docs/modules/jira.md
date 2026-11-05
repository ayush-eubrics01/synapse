# Jira Tracking

Covers the `jira-tracking` domain module (`apps/api/src/modules/jira-tracking`) and the `jira/claude-connector` adapter.

## Purpose

Keep a local, incrementally synced view of the Jira issues that matter to the user, so assigned work doesn't go unmonitored. Detect blockers and neglected issues, and correlate issues with Slack conversations, commitments and projects. Jira stays authoritative for issue status.

## Responsibilities / Non-responsibilities

Responsibilities:

- Collect issues assigned to the user and relevant issues involving colleagues (configurable JQL).
- Track status, priority, due dates, comments and updates.
- Detect blockers and issues that haven't received attention.
- Correlate issues with Slack messages, commitments and Engineering Brain projects.
- Offer issues as candidates for engineering tasks (requirement 7).

Non-responsibilities:

- Changing Jira based on AI interpretation. Every write needs approval.
- Running Claude directly. The adapter submits collector jobs to the orchestrator.

## Owned data (tables)

`jira_projects`, `jira_issues`, `jira_issue_comments`, `jira_issue_links`, `jira_sync_history`, plus `integration_sync_states` stream `jira.issues`. The `cloudId` is stored in `integrations.config`.

## Ports used / provided

- Provides `IssueSource` (and `IssueSink` for approved writes) via `jira/claude-connector`.
- Tools: `mcp__claude_ai_Atlassian__getAccessibleAtlassianResources` (once, for `cloudId`), `mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql` (collection), plus issue and comment reads as needed.
- Output is structured JSON: `issues.nodes[]` with `key`, `id`, `fields` (`status`, `priority`, `assignee`, `reporter`, `updated`, `created`, `summary`, `labels`, `project`, …) and `issues.pageInfo.endCursor` / `hasNextPage`.
- `duedate` isn't returned by default. Always request it in `fields`.

## Jobs

| Job type | Trigger | Profile / model | Idempotency key | Retry |
|---|---|---|---|---|
| `jira.resolve_cloud_id` | setup, or when missing | collector / haiku | `jira.cloud_id` | 3 attempts |
| `jira.sync_incremental` | scheduled (default 15 min) | collector / haiku | `jira.sync:<slot>` | 3 attempts, backoff |
| `jira.backfill` | setup | collector / haiku | `jira.backfill:<cursor>` | resumes from cursor |
| `jira.analyze` | after sync with changes (batched) | intelligence / haiku or sonnet | `jira.analyze:<sync id>` | 3 attempts |
| `jira.write` | `approval.approved` | collector, single write tool | approval idempotency key | verify before retry |

Incremental JQL shape: `(<configured scope>) AND updated >= "<checkpoint>" ORDER BY updated ASC`. The checkpoint is the newest `updated` stored. Overlap is absorbed by unique `key`.

## Events

Emitted: `jira.issue_updated`, `jira.issue_blocked`, `collection.completed`, `collection.failed`.

Consumed: `approval.approved` / `rejected` / `expired`, `settings.changed`, `claude.job_completed` / `failed`.

## Workflows

Sync:

```text
scheduler → jira.sync_incremental
 → orchestrator collector run (JQL page(s) via cursor)
 → parse RawToolResults only → Zod validate SourceIssue
 → upsert jira_issues (by key) → record jira_sync_history
 → jira.issue_updated per changed issue → checkpoint commit
```

Attention detection (rules first, AI for context):

- **Blocked:** status/labels/links that indicate a block (exact status names are configurable per Jira project, since workflows differ) → `jira.issue_blocked`.
- **Stale:** assigned to the user, not Done, not updated for N days (default 5) → `attention_state = stale`.
- **Due soon / overdue:** from `due_date`.
- `jira.analyze` (batched) adds context: likely blocker reason, related Slack threads, suggested next action. Recommendations only.

Correlation: issue keys mentioned in Slack text (e.g. `PROJ-123`) create `slack_message_references` and `jira_issue_links`. Commitments can cite an issue as a source.

## Permissions and approvals

Read Jira: allowed. Comment, transition, edit or create an issue: approval required, with the exact change shown in the approval payload. Collector runs only get the read tools they need. Write tools are disallowed except in the single approved `jira.write` run.

## Failure handling

| Situation | Handling |
|---|---|
| Jira unavailable / connector not ready | retry with backoff; checkpoint unchanged |
| No real tool_result | `incomplete_ai_output`, retry |
| Missing `cloudId` | enqueue `jira.resolve_cloud_id` first |
| Unexpected JSON shape | `parse_failed` → `NEEDS_ATTENTION` |
| Auth failure | `auth_failed` → `NEEDS_ATTENTION` |
| Write with uncertain result | re-read the issue to verify before retry |

## Configuration

| Key | Default |
|---|---|
| `jira.sync.intervalMinutes` | `15` |
| `jira.scope.jql` | `assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()` (user-editable) |
| `jira.backfill.days` | configurable (concept leaves scope open) |
| `jira.fields` | `summary,status,priority,assignee,reporter,duedate,labels,created,updated,project,issuetype` |
| `jira.stale.days` | `5` |
| `jira.blockedStatuses` | `[]` (per project, user-configured) |

The default scope JQL above is a starting proposal. Confirm it with the user.

## Tests

- Jira unavailable during sync → retried, no partial checkpoint advance.
- Overlapping incremental windows → no duplicate issues.
- `duedate` present when requested; absent field handled.
- Cursor pagination across pages.
- Stale/blocked detection rules.
- Slack message mentioning an issue key → reference created.
- Approval revoked before a write executes → no write.
- Fabricated output (no tool_result) → failure.

## Open questions

- Default Jira scope and backfill window aren't fixed by the concept. Confirm during setup.
- OQ-5: whether "monitor my Claude Code" (requirement 7) also means watching interactive sessions; affects how Jira tasks feed engineering work.

See `docs/product/open-questions.md`.
