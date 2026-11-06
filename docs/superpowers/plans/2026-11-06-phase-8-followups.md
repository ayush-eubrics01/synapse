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
- **Smaller items.** A route to set `jira.cloudId`; `jira.analyze`-free Engineering Brain links; offering issues as engineering-task candidates (requirement 7); applying interval and page-budget changes without a restart.

## Real-connector smoke

TBD (the controller runs `bun scripts/dev/jira-smoke.ts` and records the counts here).
