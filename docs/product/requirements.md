# Requirements

Source: `pre-project-concept-document/requirements.md` (the user's own list) and `concept.md` v1.1. IDs are stable; reference them in code, tests and docs.

## User requirements (from the user's own list)

| ID | Requirement | Covered by |
|---|---|---|
| UR-1 | Connect to the user's Slack | `docs/modules/slack.md` (claude.ai connector, ADR-025) |
| UR-2 | Connect to the user's Claude Code | `docs/modules/claude-orchestrator.md` |
| UR-3 | Collect new messages from DMs and groups; exclude app messages | `slack.md`, ADR-027 |
| UR-4 | On a set frequency, summarize what is going on in each conversation with new messages. Don't call Claude for conversations with nothing new | `slack.md`, `urgency-engine.md` |
| UR-5a | One central place for everything that needs attention | Dashboard, Urgent Inbox |
| UR-5b | Clear priority for important people | `people-memory.md` (manual priority) |
| UR-5c | Answer specific questions from the codebase while the user is away | `claude-orchestrator.md` (intelligence worker); **sending blocked by OQ-1** |
| UR-5d | Detect reported bugs/tasks; fix small ones on a separate branch, ready for approval | `claude-orchestrator.md`, engineering tasks, ADR-030 |
| UR-5e | When a task spec is unclear, draft follow-up questions to the reporter | `commitments.md` |
| UR-5f | Track stalled conversations ("I'll check and let you know") and remind the other person | `commitments.md`; **sending blocked by OQ-1** |
| UR-6 | Engineering Brain tracking what the user builds, with go-live dates | `engineering-brain.md` |
| UR-7 | Monitor Jira tasks and act as admin/operations manager of Claude Code | `jira.md`, `claude-orchestrator.md`; **scope in OQ-5** |

Note on UR-4: with the connector-based collector, Synapse can't know whether anything is new without one Claude run per poll. "Don't call Claude" therefore applies to the *intelligence* step: no analysis run when collection finds nothing new. See `slack.md`.

## Functional requirements

| ID | Requirement |
|---|---|
| FR-1 | Collect human messages from all accessible DMs, group DMs, public and private channels, including thread replies |
| FR-2 | Default collection interval 10 minutes, configurable; independent schedules per integration |
| FR-3 | Initial backfill of 90 days, resumable after interruption |
| FR-4 | Deduplicate messages on (conversation, Slack ts); keep original IDs and timestamps |
| FR-5 | Rule-based screening of every new message; contextual urgency assessment only for candidates |
| FR-6 | Urgency levels Critical/High/Medium/Low; Critical and High go to the Urgent Inbox with an immediate notification |
| FR-7 | People Memory for user-selected individuals, built from approved recommendations with evidence |
| FR-8 | Temporary contacts for unknown people; no automatic permanent profiles |
| FR-9 | Commitment extraction for both the user and others, with lifecycle and follow-ups |
| FR-10 | Engineering Brain with project profiles, decisions, milestones and go-live dates |
| FR-11 | Jira sync of assigned and relevant issues, blockers and stale issues |
| FR-12 | Engineering investigation and approved code changes following the fixed Git workflow, one task at a time |
| FR-13 | Approval queue for all external writes, with scoped and expiring approvals |
| FR-14 | Customizable dashboard (add, remove, reorder, resize, configure, save layouts) |
| FR-15 | Retention: Slack message content deleted after 180 days (configurable); derived knowledge kept |

## Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-1 | Runs as systemd user services; keeps running with the browser closed and after logout (linger) |
| NFR-2 | Durable jobs survive restarts; interrupted jobs recover from checkpoints |
| NFR-3 | No duplicate messages, commitments or sent Slack messages after retries or restarts |
| NFR-4 | Claude usage gated on real five-hour/seven-day utilization; configurable budgets and concurrency |
| NFR-5 | Bound to localhost only; no secrets in code, prompts or logs |
| NFR-6 | Every external action and AI recommendation is auditable |
| NFR-7 | Integrations and AI provider replaceable without changing domain modules |
| NFR-8 | Critical workflows covered by unit, contract, integration and failure-path tests |
