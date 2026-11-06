# System Architecture

## Overview

Synapse is a **modular monolith** with **ports and adapters**, running locally as two systemd user services:

```text
┌──────────────── user's Linux machine (localhost only) ────────────────┐
│                                                                        │
│  synapse-web.service          synapse-api.service                      │
│  ┌──────────────┐  REST/SSE  ┌─────────────────────────────────────┐   │
│  │  Next.js UI  │──────────▶│ Hono on Bun                          │   │
│  └──────────────┘           │  controllers ─▶ domain modules       │   │
│                              │  core: jobs, scheduler, events,      │   │
│                              │        approvals, permissions,       │   │
│                              │        audit, health, orchestrator   │   │
│                              │  integrations (adapters)             │   │
│                              └───────┬──────────────┬──────────────┘   │
│                                      │              │                  │
│                              SQLite (WAL)     claude -p subprocesses   │
│                              synapse.db       (via orchestrator only)  │
│                                                     │                  │
│                                   registered Git repositories          │
└─────────────────────────────────────────────────────┼──────────────────┘
                                                      │ claude.ai login (OAuth)
                                       claude.ai connectors ─▶ Slack, Jira
```

The API service keeps running without the web service. All background work lives in the API process.

## Logical layers

| Layer | Responsibility | Location |
|---|---|---|
| Presentation | Dashboard, inboxes, approvals, settings. No business logic (layout: `docs/modules/web-dashboard.md`) | `apps/web` |
| Application / orchestration | Scheduling, jobs, events, approvals, permissions, notifications, recovery, Claude orchestration | `apps/api/src/core`, `workers` |
| Domain | Inbox, people, commitments, Jira tracking, Engineering Brain, engineering tasks, dashboard config | `apps/api/src/modules` |
| Intelligence | Prompt builders and output schemas for AI tasks | `apps/api/src/intelligence` |
| Integration | Adapters implementing ports | `apps/api/src/integrations` |
| Data | SQLite + Drizzle schema and migrations | `packages/database`, `infrastructure` |
| Runtime | systemd, health, logging, backups, notifications | `infrastructure`, `scripts/` |

Allowed dependencies: `module-boundaries.md`.

## Key architectural facts from Phase 0

1. **Collection runs through Claude.** The Slack and Jira credentials live in claude.ai connectors, so each collection is a short `claude -p` run. The adapter extracts data from raw tool results. This is why the orchestrator sits in front of every integration that uses a connector.
2. **Raw tool results only.** The model can fabricate tool output in its text. Only `tool_result` events are data (ADR-026).
3. **Quota is observable.** Each run reports five-hour and seven-day utilization; the orchestrator gates work on it (ADR-029).
4. **Per-run context is large by default.** The invocation profile trims it from ~134k to ~36k tokens (ADR-031).
5. **One search call covers all Slack conversation types** with a precise timestamp checkpoint (ADR-025).

## Source-of-truth rules

| Information | Authoritative source |
|---|---|
| Slack messages | Slack |
| Jira issue status | Jira |
| Source code | Git repositories |
| People Memory | Synapse database (user-approved) |
| Commitments | Synapse database (with evidence) |
| Engineering Brain | Synapse database (approved updates) |
| Jobs, Claude runs, approvals, audit | Synapse database |
| Dashboard settings | Synapse database |

Synapse never overwrites external data based only on AI interpretation. Sync is incremental, using checkpoints and external IDs.

## Processing model

- **Scheduled collection** (Slack every 10 min, Jira on its own interval) → durable jobs.
- **Events** from stored data → consumers enqueue analysis jobs. No heavy work inside consumers.
- **Hybrid intelligence:** cheap rules first; Claude only for candidates and batched analysis.
- **Approval-gated actions** for every external write.
- **Serialized engineering:** one engineering task at a time (ADR-030).

## Related documents

- `module-boundaries.md`: modules, ownership, dependency rules
- `integration-contracts.md`: ports, DTOs, error model
- `event-system.md`: event envelope, outbox, catalog
- `database-design.md`: logical schema
- `security-model.md`: permissions, approvals, untrusted content, local security
- `runtime-design.md`: processes, systemd, jobs, recovery, health
