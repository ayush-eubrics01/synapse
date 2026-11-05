# Architecture Decision Records

This folder records the significant architecture decisions for Synapse. Each ADR captures one decision: the context, the decision itself, and its consequences.

- **Accepted** decisions are binding. Changing one requires a new ADR that supersedes it. Don't silently edit an accepted decision.
- **Proposed** decisions are recommendations awaiting the user's confirmation. Don't build on them as if they were final without checking.
- ADR-001 to ADR-024 come from the original specification (`pre-project-concept-document/concept.md` §24). ADR-025 onward come from the Phase 0 feasibility tests and later user decisions.

## Template

```markdown
# ADR-NNN: <Title>
- **Status:** Proposed | Accepted | Superseded by ADR-XXX
- **Date:** YYYY-MM-DD
- **Source:** <spec section / test result / user decision>

## Context
What problem or constraint led to this decision.

## Decision
What we decided, stated concretely.

## Consequences
Positive and negative effects, and follow-ups.

## Related
Links to other ADRs and docs.
```

File naming: `ADR/ADR-NNN-kebab-case-title.md`. Number sequentially; never reuse a number.

## Index

| ID | Title | Status | File |
|---|---|---|---|
| ADR-001 | Next.js + TypeScript Frontend | Accepted | [ADR-001-nextjs-frontend.md](ADR/ADR-001-nextjs-frontend.md) |
| ADR-002 | NestJS + TypeScript Backend | Superseded by ADR-038 | [ADR-002-nestjs-backend.md](ADR/ADR-002-nestjs-backend.md) |
| ADR-003 | SQLite + Drizzle ORM | Accepted | [ADR-003-sqlite-drizzle.md](ADR/ADR-003-sqlite-drizzle.md) |
| ADR-004 | Modular Monolith | Accepted | [ADR-004-modular-monolith.md](ADR/ADR-004-modular-monolith.md) |
| ADR-005 | Local-First Architecture | Accepted | [ADR-005-local-first-architecture.md](ADR/ADR-005-local-first-architecture.md) |
| ADR-006 | Persistent Background Runtime | Accepted | [ADR-006-persistent-background-runtime.md](ADR/ADR-006-persistent-background-runtime.md) |
| ADR-007 | systemd User Services on Linux | Accepted | [ADR-007-systemd-user-services.md](ADR/ADR-007-systemd-user-services.md) |
| ADR-008 | Database-Backed Job Processing | Accepted | [ADR-008-database-backed-job-processing.md](ADR/ADR-008-database-backed-job-processing.md) |
| ADR-009 | Claude Code as Initial AI Execution Provider | Accepted | [ADR-009-claude-code-initial-ai-provider.md](ADR/ADR-009-claude-code-initial-ai-provider.md) |
| ADR-010 | Replaceable Integration Adapters | Accepted | [ADR-010-replaceable-integration-adapters.md](ADR/ADR-010-replaceable-integration-adapters.md) |
| ADR-011 | Replaceable AI Provider | Accepted | [ADR-011-replaceable-ai-provider.md](ADR/ADR-011-replaceable-ai-provider.md) |
| ADR-012 | Hybrid Message Processing | Accepted | [ADR-012-hybrid-message-processing.md](ADR/ADR-012-hybrid-message-processing.md) |
| ADR-013 | Manual Approval for External Writes | Accepted | [ADR-013-manual-approval-for-external-writes.md](ADR/ADR-013-manual-approval-for-external-writes.md) |
| ADR-014 | People Memory Requires Approved Recommendations | Accepted | [ADR-014-people-memory-requires-approval.md](ADR/ADR-014-people-memory-requires-approval.md) |
| ADR-015 | Commitments Track Both User and Colleagues | Accepted | [ADR-015-commitments-track-both-sides.md](ADR/ADR-015-commitments-track-both-sides.md) |
| ADR-016 | Central Engineering Brain with Project Profiles | Accepted | [ADR-016-central-engineering-brain.md](ADR/ADR-016-central-engineering-brain.md) |
| ADR-017 | Initial Slack History — 90 Days | Accepted | [ADR-017-initial-slack-history-90-days.md](ADR/ADR-017-initial-slack-history-90-days.md) |
| ADR-018 | Full Slack Message Retention — 180 Days | Accepted | [ADR-018-slack-message-retention-180-days.md](ADR/ADR-018-slack-message-retention-180-days.md) |
| ADR-019 | People Memory Initial Profiles Are User-Selected | Accepted | [ADR-019-user-selected-initial-profiles.md](ADR/ADR-019-user-selected-initial-profiles.md) |
| ADR-020 | Group-Level People Memory Is Deferred | Accepted | [ADR-020-group-people-memory-deferred.md](ADR/ADR-020-group-people-memory-deferred.md) |
| ADR-021 | Unknown Contacts Use Temporary Records | Accepted | [ADR-021-unknown-contacts-temporary-records.md](ADR/ADR-021-unknown-contacts-temporary-records.md) |
| ADR-022 | Job Retry Limit — 3 Automatic Retries | Accepted | [ADR-022-job-retry-limit.md](ADR/ADR-022-job-retry-limit.md) |
| ADR-023 | Customizable Dashboard Widgets | Accepted | [ADR-023-customizable-dashboard-widgets.md](ADR/ADR-023-customizable-dashboard-widgets.md) |
| ADR-024 | External Source Systems Retain Authority Over Original Data | Accepted | [ADR-024-external-systems-retain-authority.md](ADR/ADR-024-external-systems-retain-authority.md) |
| ADR-025 | Slack Collection via Search with a Unix-Timestamp Checkpoint | Accepted | [ADR-025-slack-collection-via-search.md](ADR/ADR-025-slack-collection-via-search.md) |
| ADR-026 | Only Raw Tool Results Are Trusted Data | Accepted | [ADR-026-raw-tool-results-only.md](ADR/ADR-026-raw-tool-results-only.md) |
| ADR-027 | Bot Filtering Relies on Slack's `include_bots: false` | Accepted | [ADR-027-bot-filtering-via-slack.md](ADR/ADR-027-bot-filtering-via-slack.md) |
| ADR-028 | Haiku Is the Default Model for Collection and Screening | Accepted | [ADR-028-haiku-default-for-collection.md](ADR/ADR-028-haiku-default-for-collection.md) |
| ADR-029 | Quota Gate on `rate_limit_event` Utilization | Accepted | [ADR-029-quota-gate-on-rate-limit-event.md](ADR/ADR-029-quota-gate-on-rate-limit-event.md) |
| ADR-030 | One Engineering Task at a Time and a Fixed Git Workflow | Accepted | [ADR-030-single-engineering-task-and-git-workflow.md](ADR/ADR-030-single-engineering-task-and-git-workflow.md) |
| ADR-031 | Collector Worker Profile | Accepted | [ADR-031-collector-worker-profile.md](ADR/ADR-031-collector-worker-profile.md) |
| ADR-032 | Untrusted Content Isolation | Accepted | [ADR-032-untrusted-content-isolation.md](ADR/ADR-032-untrusted-content-isolation.md) |
| ADR-033 | Away-Mode Auto-Replies to Priority People | Accepted | [ADR-033-away-mode-auto-replies.md](ADR/ADR-033-away-mode-auto-replies.md) |
| ADR-034 | Prompt-Injection Detection and Red Flags | Accepted | [ADR-034-injection-detection-red-flags.md](ADR/ADR-034-injection-detection-red-flags.md) |
| ADR-035 | Repository Branch Registry and Branch Confirmation | Accepted | [ADR-035-repository-branch-registry.md](ADR/ADR-035-repository-branch-registry.md) |
| ADR-036 | Observe Interactive Claude Code Sessions (Metadata Only) | Accepted | [ADR-036-interactive-session-observation.md](ADR/ADR-036-interactive-session-observation.md) |
| ADR-037 | Keep the Claude Code Login Alive Without Repeated Re-Login | Accepted | [ADR-037-claude-auth-renewal.md](ADR/ADR-037-claude-auth-renewal.md) |
| ADR-038 | Hono + TypeScript Backend (supersedes ADR-002) | Accepted | [ADR-038-hono-backend.md](ADR/ADR-038-hono-backend.md) |
| ADR-039 | Bun as Runtime, Package Manager and Test Runner | Accepted | [ADR-039-bun-runtime.md](ADR/ADR-039-bun-runtime.md) |
