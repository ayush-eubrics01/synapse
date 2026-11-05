# Module Boundaries

Synapse is a modular monolith using ports and adapters. This document defines every module, what it owns, and which dependencies are allowed. Code that violates these boundaries should not be merged.

## Layers and dependency direction

```text
apps/web ──HTTP/SSE──▶ apps/api (controllers)
                           │
                           ▼
                    modules/*  (domain logic)
                    workers/*  (job handlers)
                           │ depend on
                           ▼
              packages/contracts  (ports, DTOs, events, schemas)
                           ▲ implemented by
                           │
        integrations/*   infrastructure/*   core/*
```

Rules:

- `packages/contracts` depends on nothing but Zod and TypeScript types.
- Domain modules depend on `packages/contracts` and on `core` services through their public interfaces. They never import from `integrations/*` or `infrastructure/*` directly; adapters are injected through NestJS providers bound to port tokens.
- Domain modules never import each other's internals. Cross-module communication uses domain events (`docs/architecture/event-system.md`) or a module's exported public service interface.
- Only `core/orchestrator` may use the `AIProvider` port. Everything else submits `ClaudeJob`s to the orchestrator.
- Adapters that collect data through Claude connectors (Slack, Jira) get their Claude runs from the orchestrator. They never spawn processes.
- `apps/web` never talks to Slack, Jira, Git or Claude.

## Core platform (`apps/api/src/core`)

| Component | Owns | Public interface |
|---|---|---|
| `config` | App settings, typed config, settings persistence | `ConfigService` |
| `events` | Event bus, transactional outbox, consumer offsets | `EventPublisher`, `@OnEvent` consumers |
| `jobs` | Durable job queue, attempts, checkpoints, retries, backoff | `JobQueue`, `JobHandler` registry |
| `scheduler` | Recurring schedules (`scheduled_tasks`) that enqueue jobs | `SchedulerService` |
| `leases` | Named leases with expiry (job claims, engineering lock) | `LeaseService` |
| `permissions` | Permission policy and capability scoping | `PermissionManager` |
| `approvals` | Approval requests, decisions, expiry, revalidation | `ApprovalEngine` |
| `audit` | Append-only audit log | `AuditLogger` |
| `notifications` | In-app + desktop notifications via adapter | `NotificationService` |
| `health` | Liveness, readiness, integration health, auth expiry checks | `HealthService` |
| `orchestrator` | All Claude Code execution: queueing, concurrency, quota gate, budgets, timeouts, cancellation, run log | `ClaudeOrchestrator` |
| `module-registry` | Registered modules, enabled state, declared dependencies | `ModuleRegistry` |

## Domain modules (`apps/api/src/modules`)

| Module | Owns (tables) | Consumes | Emits |
|---|---|---|---|
| `inbox` | `slack_conversations`, `slack_messages`, `slack_users`, `slack_attachments`, `slack_message_references`, urgency state | `MessageSource` port, urgency results | `message.*` |
| `people` | `people`, `temporary_contacts`, `people_profiles*`, `people_priority_settings` | `message.received`, approvals | `person.*` |
| `commitments` | `commitments`, `commitment_sources`, `commitment_updates`, `followups`, `followup_history` | messages, Jira updates, approvals | `commitment.*`, `followup.*` |
| `jira-tracking` | `jira_*` tables | `IssueSource` port | `jira.*` |
| `engineering-brain` | `projects`, `project_*` tables | `RepositoryProvider` port, messages, Jira | `project.*` |
| `engineering-tasks` | `engineering_tasks`, `engineering_task_steps` | approvals, orchestrator, `RepositoryProvider` | `engineering.*` |
| `dashboard` | `dashboard_*` tables | read APIs of other modules | — |
| `settings` | user-facing settings over `app_settings` | `ConfigService` | `settings.changed` |

## Intelligence (`apps/api/src/intelligence`)

Prompt builders and Zod output schemas for each AI task: screening (rules only, no AI), urgency assessment, commitment extraction, people profile recommendations, knowledge recommendations, response and follow-up drafting, Jira analysis.

Intelligence code is pure: it builds `ClaudeJob` requests and validates results. It doesn't persist anything or call adapters. Modules own persistence.

## Integrations (`apps/api/src/integrations`)

| Adapter | Implements | Mechanism |
|---|---|---|
| `slack/claude-connector` | `MessageSource`, `MessageSink` | Collector runs via orchestrator → `slack_search_public_and_private`, `slack_read_thread`; sends via `slack_send_message` (approval required) |
| `jira/claude-connector` | `IssueSource`, `IssueSink` | Collector runs via orchestrator → `searchJiraIssuesUsingJql` etc. |
| `repository/local-git` | `RepositoryProvider` | Local `git` on registered paths only |
| `claude-code/cli` | `AIProvider` | `claude -p` subprocess, `stream-json` parsing |

Future native Slack/Jira adapters implement the same ports. Nothing else changes.

## Workers (`apps/api/src/workers`)

Job handlers that connect a job type to a module service. One handler per job type. Handlers are thin: load input, call the module, record the result. Retries and checkpoints are handled by `core/jobs`.

## Infrastructure (`apps/api/src/infrastructure`)

SQLite connection and Drizzle setup, process runner (spawn, kill, stream reading), credential-store abstraction, desktop notification adapter, file system access restricted to configured repository paths.
