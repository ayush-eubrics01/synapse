# Phase 8: Follow-ups

Phase 8 delivered read-only Jira tracking (`docs/modules/jira.md`, spec `docs/superpowers/specs/2026-11-06-phase-8-jira.md`). This file records what was deliberately deferred and the real-connector smoke result.

## Deferred

- **Writes through approval.** Comment on or transition an issue only through the permission manager and approval engine, with the exact change in the approval payload, a single write tool in one approved `jira.write` run, and verify-before-retry for uncertain results. Fits Phase 10 (engineering automation). Needs the `IssueSink` port.
- **Jira-sourced commitments.** Let a commitment cite an issue (`jira:<key>`) as its source, and extract commitments from issue changes. Needs a decision on trust (issue text is untrusted, ADR-032).
- **AI analysis (`jira.analyze`).** Batched, recommendation-only: likely blocker reason, related Slack threads, suggested next action. Needs a prompt builder and output schema in `intelligence/`, and the untrusted-content rules for summaries.
- **Comments and descriptions.** Both are left out of `JIRA_FIELDS` on purpose (less untrusted text, smaller pages). Adding them needs a per-issue read, provenance tags and size limits.
- **Multi-site.** One site only today; more than one parks `jira.resolve_cloud_id` with `multiple_sites` and the user sets `jira.cloudId` by hand (there is no route for it yet). Supporting several sites needs per-site settings, streams and checkpoints.
- **Inbox chips for issue keys.** Show a chip on Slack messages that mention a tracked issue key, linking to the issue. Today the correlation runs one way (issue to messages, at read time).
- **Count-only list view for performance.** `GET /api/jira/issues` computes Slack mentions per issue (a `LIKE` scan of `slack_messages` each). Add a view that returns counts only, or index or cache mentions, before the issue count or message volume grows.
- **Per-issue mention scan on every list.** Part of the item above: each `list`/`get` runs one `LIKE` scan per issue. Parked by the final review; the count-only view is the fix.
- **Lookup by `jira_id`.** A project move is matched by `jira_id`, which has no index. That's fine at today's issue counts; add an index (with a migration) if the table grows.
- **Smaller items.** A route to set `jira.cloudId`; `jira.analyze`-free Engineering Brain links; offering issues as engineering-task candidates (requirement 7); applying interval and page-budget changes without a restart.

## Real-connector smoke

Run by the controller on 2026-11-06 against the real connector, with the user's scope passed via `--jql`. Only counts were recorded, and the temp DB was deleted.

- **First run: `parse_failed`.** A page of 50 issues comes back as about 119 KB of tool output, so Claude Code replaced it with an "exceeds maximum allowed tokens / saved to file" notice.
  - Setting `MAX_MCP_OUTPUT_TOKENS` only moves the failure to a second limit: a `<persisted-output>` notice at roughly 100 KB.
  - Fix: `jira.pageSize` now defaults to 20 (about 49 KB, measured) with a maximum of 30, and `jira.maxPagesPerRun` defaults to 6.
- **After the fix:** `sites: 1`, `issues: 20`, `hasNextPage: true`, `statusCategory: new=6 indeterminate=7 done=7`, `projects: 1`.
  - The argument check and the parser passed on real data.
- **Follow-up (done in the final-review fix wave):** the adapter detects the CLI's oversized-output notice and reports it as `output_too_large` (parked as needs-attention, never retried into a loop); the web shows "Jira page too large — lower jira.pageSize".
