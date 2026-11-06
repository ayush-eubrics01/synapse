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
- Domain modules depend on `packages/contracts` and on `core` services through their public interfaces. They never import from `integrations/*` or `infrastructure/*` directly; adapters are wired to ports in the composition root (`apps/api/src/container.ts`) and passed in by constructor/factory injection, with no DI framework (ADR-038). A lint rule forbids `modules/*` from importing `integrations/*` or `infrastructure/*`.
- Domain modules never import each other's internals. Cross-module communication uses domain events (`docs/architecture/event-system.md`) or a module's exported public service interface.
- Only `core/orchestrator` may use the `AIProvider` port. Everything else submits `ClaudeJob`s to the orchestrator.
- Adapters that collect data through Claude connectors (Slack, Jira) get their Claude runs from the orchestrator. They never spawn processes.
- `apps/web` never talks to Slack, Jira, Git or Claude.

## Core platform (`apps/api/src/core`)

| Component | Owns | Public interface |
|---|---|---|
| `config` | App settings, typed config, settings persistence | `ConfigService` |
| `events` | Event bus, transactional outbox, consumer offsets | `EventPublisher`, consumer registration (`events.subscribe(type, consumerName, handler)`) |
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
| `auto-reply` | `away_sessions`, `auto_replies`; writes `auto_replies.{decision,reason,text,outgoing_id,approval_id}` (the last two through `OutgoingService.requestAutoSend`) | `message.urgent_detected`, `followup.draft_created`, people priority, security flags, settings; requests sends only via `OutgoingService` | `away.changed`, `autoreply.*` |
| `jira-tracking` | `jira_issues`; sync state streams `jira.issues` / `jira.reconcile` (through `SyncStateService`); settings `jira.*`. Computes attention and Slack mentions (reads `slack_messages` / `slack_conversations` read-only, never writes them) | `JiraIssueSource` port (read-only), settings | `jira.issue_updated`, `jira.issue_attention`, `collection.*` (streams `jira.*`) |
| `engineering-brain` | `repositories`, `repository_environments`, `projects`, `project_repositories`, `project_facts`, `project_milestones` (migration 0016). Owns the registry (`RepositoryRegistry`), drift check, inspection bookkeeping (`InspectionService`) and `BrainService` (fact review, milestones, Jira summary). Reads `jira_issues` read-only for the project Jira summary, and settings `brain.*` | `RepositoryProvider` port (`LocalGitProvider`), the orchestrator (only through the `brain.inspect_repository` worker), notifications, `jira_issues` (read) | `repo.registered`, `repo.drift_detected`, `brain.facts_proposed`, `brain.fact_decided` |
| `engineering-tasks` | `engineering_tasks`, `engineering_task_steps`; the `engineering` lease (through `LeaseService`, `EngineeringLock`); writes `repositories.test_command` on plan approval and the tracked branch only through `RepositoryRegistry.update`. Reads `jira_issues` (summary) and `slack_messages` (text) read-only to prefill a draft, and repository environments for the protected-branch checks | approvals, orchestrator (only through the `engineering.investigate` and step workers), `RepositoryProvider`, `GitWorkflow` | `engineering.*` |
| `security-flags` | `security_flags`, `security_flag_rules` | `message.received`, intelligence results, `claude.job_*` | `security.*` |
| `claude-activity` | `claude_sessions`, `claude_session_prs` | `~/.claude/projects` session metadata (read-only, registered repos only) | `claude_session.*` |
| `dashboard` | `dashboard_*` tables | read APIs of other modules | — |
| `settings` | user-facing settings over `app_settings` | `ConfigService` | `settings.changed` |

`auto-reply` never imports adapters or the orchestrator, and never sends: it asks `OutgoingService` for a policy-approved send, which runs through the approval engine and `SlackSender`. `AUTO_REPLY_TAG` lives in `packages/contracts` so the module, the outgoing service and the web share one constant.

## Intelligence (`apps/api/src/intelligence`)

Every intelligence output schema includes a `suspectedInjection` field (ADR-034). Prompt builders tag each input part with its provenance (ADR-032).

**Explicit exception (ADR-034 note, Phase 9).** The repository inspection schema (`intelligence/brain/inspect-prompt.ts`) has **no `suspectedInjection` field**. The run reads only the registered repository, with path-scoped `Read`, `Grep` and `Glob` and no write, network or connector tool; it receives no untrusted prompt part; its output is code-verified (evidence must resolve to real files inside the repository, secrets and internal URLs are dropped) and stored as `needs_review`, so the user reads every fact before it is kept. A flag would add nothing the review does not already provide. If inspection ever gains a write or send capability, or receives Slack or Jira text, this exception ends.

Prompt builders and Zod output schemas for each AI task: screening (rules only, no AI), urgency assessment, commitment extraction, people profile recommendations, knowledge recommendations, response and follow-up drafting, Jira analysis.

Intelligence code is pure: it builds `ClaudeJob` requests and validates results. It doesn't persist anything or call adapters. Modules own persistence.

## Integrations (`apps/api/src/integrations`)

| Adapter | Implements | Mechanism |
|---|---|---|
| `slack/claude-connector` | `MessageSource`, `MessageSink` | Collector runs via orchestrator → `slack_search_public_and_private`, `slack_read_thread`; sends via `slack_send_message` (approval required) |
| `jira/claude-connector` | `JiraIssueSource` (read-only; `IssueSink` deferred) | One collector run per call via orchestrator → `getAccessibleAtlassianResources`, `searchJiraIssuesUsingJql`; arguments checked against the raw tool_use |
| `repository/local-git` | `RepositoryProvider` | Local `git` on registered paths only |
| `claude-code/cli` | `AIProvider` | `claude -p` subprocess, `stream-json` parsing |

Future native Slack/Jira adapters implement the same ports. Nothing else changes.

## Workers (`apps/api/src/workers`)

Job handlers that connect a job type to a module service. One handler per job type. Handlers are thin: load input, call the module, record the result. Retries and checkpoints are handled by `core/jobs`.

## Infrastructure (`apps/api/src/infrastructure`)

SQLite connection and Drizzle setup, process runner (spawn, kill, stream reading), credential-store abstraction, desktop notification adapter, file system access restricted to configured repository paths.
