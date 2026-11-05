# Engineering Operations Manager
## Technical Architecture & Implementation Specification

**Document type:** Technical Architecture Blueprint  
**Version:** 1.1 (updated with Phase 0 results, 2026-11-05 — see `phase0-results.md`)  
**Target environment:** Local Linux machine  
**Application model:** Single-user, local-first, persistent background service  
**Primary development agent:** Claude Code  
**Frontend:** Next.js + TypeScript  
**Backend:** NestJS + TypeScript  
**Database:** SQLite + Drizzle ORM  

---

# 1. Product Vision

Build a local Engineering Operations Manager that operates across Slack, Jira, Git repositories and Claude Code.

The application should act as an intelligent operational layer above the user's existing engineering tools.

Its responsibilities include:

- Collecting and organizing important conversations.
- Identifying urgent messages and pending responses.
- Maintaining profiles of selected people.
- Detecting commitments made by the user and colleagues.
- Managing follow-ups and reminders.
- Maintaining a centralized Engineering Brain.
- Monitoring Jira tasks and project progress.
- Using Claude Code to investigate engineering problems and prepare solutions.
- Managing AI execution, approvals, permissions and resource consumption.
- Providing a customizable central dashboard.

The application should continue operating independently of the browser.

## 1.1 Core philosophy

The application owns orchestration, persistence, scheduling, operational state and intelligence records.

External services remain authoritative for their original data:

- Slack owns Slack messages.
- Jira owns Jira issue status.
- Git repositories own source code.
- The application owns approved People Memory, commitments, Engineering Brain records, approvals and execution history.

Claude Code is an execution and intelligence provider. It must not become the application's database, scheduler or source of truth.

## 1.2 Foundational principles

1. Local-first architecture.
2. Modular monolith, not microservices initially.
3. TypeScript-first development.
4. Replaceable integrations.
5. Replaceable AI providers.
6. Event-driven processing.
7. Persistent and resumable jobs.
8. Human approval for external writes.
9. Traceable AI recommendations.
10. Strict separation between presentation and business logic.
11. Resource-aware Claude Code execution.
12. Documentation-driven development.

---

# 2. Technology Stack

| Layer | Technology | Responsibility |
|---|---|---|
| Frontend | Next.js + TypeScript | Dashboard and application interface |
| Backend | NestJS + TypeScript | APIs, orchestration and business logic |
| Database | SQLite | Local persistent storage |
| ORM | Drizzle ORM | Type-safe database access |
| Validation | Zod | Shared schemas and runtime validation |
| Background processing | Database-backed job queue | Persistent jobs and retries |
| AI execution | Claude Code CLI adapter | Intelligence and engineering work |
| API communication | REST + Server-Sent Events | API requests and live updates |
| Process management | systemd user services | Persistent Linux processes |
| Testing | Jest/Vitest and integration tests | Reliability and correctness |

## 2.1 Why TypeScript

The project will use TypeScript throughout the frontend, backend and shared contracts.

Rust is not required for the initial implementation.

The objective is to minimize language and ecosystem complexity while maintaining a reliable architecture.

## 2.2 SQLite configuration

Use:

- WAL journal mode.
- Foreign key enforcement.
- Configured busy timeout.
- Explicit migrations.
- Indexed query paths.
- Transactional writes.
- Automated database backups.

SQLite is sufficient for the initial single-user application.

Do not introduce Redis or an external database unless an actual requirement justifies it.

---

# 3. High-Level System Architecture

The application will have six logical layers.

## 3.1 Presentation Layer

Responsibilities:

- Central dashboard.
- Configurable dashboard widgets.
- Urgent Inbox.
- Slack Inbox.
- Commitments Dashboard.
- People Memory management.
- Engineering Brain.
- Jira overview.
- Approval queue.
- Claude execution monitoring.
- Application settings.

Presentation components must consume backend APIs.

They must not directly communicate with Slack, Jira or Claude Code.

## 3.2 Application and Orchestration Layer

Responsibilities:

- Scheduling.
- Job management.
- Event dispatch.
- Workflow coordination.
- Approval management.
- Permission enforcement.
- Notifications.
- Retry and recovery logic.
- Resource management.

This layer coordinates the entire application.

## 3.3 Intelligence Layer

Responsibilities:

- Message classification.
- Urgency assessment.
- Commitment extraction.
- Follow-up recommendations.
- People Memory recommendations.
- Engineering Brain maintenance.
- Jira analysis.
- Technical investigation.
- Response generation.

AI providers must be accessed through an adapter interface.

## 3.4 Integration Layer

Initial integrations:

- Slack through existing Claude Code access.
- Jira through existing Claude Code access.
- Local Git repositories.
- Claude Code execution.

Future integrations must be independently replaceable.

## 3.5 Data Layer

Owns:

- Message history.
- People and contact records.
- People Memory.
- Commitments.
- Follow-ups.
- Projects.
- Engineering knowledge.
- Jira synchronization.
- Jobs and attempts.
- Approvals.
- Audit history.
- Dashboard configuration.

## 3.6 Runtime Layer

Responsibilities:

- Persistent local service.
- Process lifecycle.
- Crash recovery.
- Health checks.
- Logging.
- Resource management.
- Database recovery.
- Local notifications.

---

# 4. Repository Architecture

Use a TypeScript monorepo.

Recommended initial structure:

```text
engineering-operations/
│
├── CLAUDE.md
│
├── docs/
│   ├── product/
│   │   ├── vision.md
│   │   ├── requirements.md
│   │   └── workflows.md
│   │
│   ├── architecture/
│   │   ├── system-architecture.md
│   │   ├── module-boundaries.md
│   │   ├── database-design.md
│   │   ├── event-system.md
│   │   ├── integration-contracts.md
│   │   ├── security-model.md
│   │   └── runtime-design.md
│   │
│   ├── modules/
│   │   ├── slack.md
│   │   ├── jira.md
│   │   ├── people-memory.md
│   │   ├── commitments.md
│   │   ├── engineering-brain.md
│   │   ├── urgency-engine.md
│   │   └── claude-orchestrator.md
│   │
│   └── decisions/
│       └── ADR/
│
├── apps/
│   │
│   ├── web/
│   │   ├── src/
│   │   └── ...
│   │
│   └── api/
│       ├── src/
│       │   ├── core/
│       │   ├── modules/
│       │   ├── integrations/
│       │   ├── intelligence/
│       │   ├── workers/
│       │   └── infrastructure/
│       └── ...
│
├── packages/
│   ├── contracts/
│   ├── shared/
│   ├── config/
│   └── database/
│
└── scripts/
    ├── setup/
    ├── development/
    └── maintenance/
```

The actual implementation may adjust this structure when justified, but must preserve the module boundaries.

---

# 5. Core Module Architecture

## 5.1 Core Platform

This module provides shared infrastructure.

Components:

- Module Registry.
- Event Bus.
- Job Scheduler.
- Job Queue.
- Permission Manager.
- Approval Engine.
- Notification Service.
- Configuration Manager.
- Audit Logger.
- Health Monitoring.

All other modules use these shared capabilities through defined interfaces.

## 5.2 Slack Integration Module

### Initial implementation

Use the existing Slack access available through Claude Code.

Do not require a new Slack application or independent Slack OAuth setup for the initial implementation.

### Collection scope

Collect human messages from all accessible:

- Personal DMs.
- Group DMs.
- Public channels.
- Private channels the user belongs to.

Exclude Slack applications and bot messages.

Inspect sender metadata when filtering messages.

### Collection mechanism (validated in Phase 0)

Use `slack_search_public_and_private` as the single collection primitive. One search covers DMs, group DMs, private channels, public channels and thread replies.

Required parameters for every collection call:

- `after`: the last checkpoint as a Unix timestamp (inclusive, precise). Do not rely on the `after:YYYY-MM-DD` query modifier for checkpoints; it is day-level only.
- `sort: "timestamp"`, `sort_dir: "asc"` for backfill and incremental sync.
- `include_bots: false`. Bot filtering relies on Slack's server-side filter; no bot flag is exposed in the output.
- `include_context: false` to roughly halve result size.
- `limit: 20` (the maximum per page). Follow the returned cursor for further pages.

Output format: markdown inside a JSON envelope (`{ results, pagination_info }`). Each result has channel name and ID, participants, sender name/email/user ID, `Time`, `Message_ts`, permalink and text. The parser must extract these fields from the markdown.

- Deduplication key: channel ID + `Message_ts`.
- Thread replies: there is no `thread_ts` field. Read the parent ts from the permalink's `?thread_ts=` parameter.
- Use `slack_read_thread` when a full thread is needed; it returns a ts per reply.
- Do **not** use `slack_read_channel` for collection: it has no per-message ts.
- Do **not** use `response_format: "concise"`: it drops all IDs and timestamps.
- Group DM IDs may start with `C`, not `G`. Classify conversation type from the result, not the ID prefix.
- Search returns current message state only. Edits and deletions after collection are not reported.

### Collection frequency

Default: 10 minutes.

Every poll requires a Claude invocation, because the Slack credential lives in the claude.ai connector. An empty poll costs about as much as a small one (≈ $0.005 API-equivalent on Haiku; ≈ $0.70/day at 10-minute polling). Polling frequency is therefore the main steady-state cost lever.

Frequency must be configurable through application settings.

The scheduler must support independent integration schedules in the future.

### Collection requirements

- Retrieve new messages.
- Read thread replies.
- Maintain collection checkpoints.
- Deduplicate messages.
- Preserve original Slack IDs and timestamps.
- Handle pagination.
- Handle inaccessible conversations.
- Recover after interrupted collection.
- Track synchronization failures.

### Historical collection

Initial backfill: last 90 days.

Observed volume is about 25–60 messages per day, so the backfill is roughly 115–270 pages (≈ $0.25–0.60 API-equivalent on Haiku). Run it as many short jobs of about 5 pages each, checkpointing after every page. Context grows with each page inside a single Claude run, so long runs are disproportionately expensive.

Collect conversation data independently of People Memory selection.

The application must not build permanent People Memory profiles for every sender.

### Future implementation

A native Slack integration may replace the initial Claude-based collector.

The rest of the application must remain unchanged.

## 5.3 Jira Integration Module

Initial implementation uses the existing Jira access available through Claude Code.

Responsibilities:

- Collect assigned issues.
- Collect relevant issues involving colleagues.
- Track issue status and priority.
- Track due dates.
- Retrieve relevant comments and updates.
- Identify blockers.
- Detect issues that have not received attention.
- Correlate issues with Slack conversations and commitments.

Jira remains the authoritative source for issue status.

The application maintains a synchronized local representation.

The exact initial Jira backfill scope should be configurable.

Phase 0 confirmed `searchJiraIssuesUsingJql` works from the background service and returns structured JSON (`key`, `status`, `priority`, `updated`, `assignee`, etc.) with cursor pagination via `pageInfo.endCursor`. `duedate` is not returned by default and must be requested explicitly. A `cloudId` is required; resolve it once with `getAccessibleAtlassianResources` and store it.

Future native Jira integration must implement the same integration contract.

## 5.4 Repository Integration Module

Responsibilities:

- Discover configured repositories.
- Inspect source code and documentation.
- Read Git history.
- Identify projects and modules.
- Associate repositories with project profiles.
- Support code investigation.
- Track repository metadata.

Repositories must be explicitly registered or included through an approved discovery process.

Never execute arbitrary commands against unknown repository paths.

Read-only repository access is the default.

---

# 6. People Memory

People Memory stores structured, approved knowledge about individual colleagues and contacts.

## 6.1 Initial collection

During initial setup:

1. Discover accessible individual Slack contacts.
2. Present the list to the user.
3. Let the user select which individuals to evaluate.
4. Analyze their available conversation history from the initial 90-day period.
5. Generate profile recommendations.
6. Present the recommendations for approval.
7. Save approved profiles.

Group profiles and group-level analysis are excluded from the initial scope.

Messages in group conversations can still be collected for the normal inbox.

## 6.2 Profile structure

A profile should contain:

### Identity

- Slack user ID.
- Full name.
- Email, if available.
- Job title, if known.
- Team and department, if known.
- Relevant project associations.

### Professional context

- Responsibilities.
- Areas of ownership.
- Relevant technical knowledge.
- Working relationship.
- Expectations and responsibilities involving the user.

### Communication understanding

- Observed communication preferences.
- Preferred response detail.
- Typical communication patterns.
- Recurring professional interactions.
- Relevant expectations.

### Response guidelines

- Preferred tone.
- Technical detail level.
- Conciseness preference.
- Clarifications commonly needed.
- Relevant do's and don'ts.

### Priority

- Manually assigned priority.
- Priority rationale.
- Whether messages require additional attention.

Priority must not be silently changed by Claude.

### Evidence and provenance

Every meaningful AI-generated observation should have:

- Supporting source references.
- Confidence level.
- Date observed.
- Last reviewed date.

Do not make unsupported psychological or personality judgments.

Focus on observable professional behaviour and communication preferences.

## 6.3 Profile update workflow

Claude may recommend profile changes after analyzing new conversations.

Workflow:

1. Analyze relevant new context.
2. Compare with the current profile.
3. Generate proposed changes.
4. Attach evidence.
5. Present changes in a review queue.
6. User approves or rejects.
7. Save approved changes.
8. Preserve profile version history.

No permanent profile update should happen without approval.

## 6.4 Unknown people

Unknown contacts must not automatically become permanent People Memory profiles.

Create a temporary contact record containing only the information needed to handle the interaction.

Claude assesses whether a permanent profile would be useful.

If useful, generate a profile recommendation for user approval.

Do not automatically assign priority.

## 6.5 New recipient when completing a task

When the user completes a task and wants to notify someone who has no People Memory profile:

1. Identify the intended recipient.
2. Retrieve available identity and conversation context.
3. Create temporary communication context.
4. Generate a contextual message draft.
5. Obtain message approval.
6. Send the message.
7. Verify successful sending.
8. Only after successful sending, initiate permanent profile registration/recommendation.

Permanent People Memory changes remain subject to the established approval policy.

A failed or cancelled send must not create a permanent profile.

---

# 7. Message Processing and Urgency Engine

The system uses a hybrid processing strategy.

## 7.1 Collection and processing separation

Collection and intelligence analysis are independent.

The application must not invoke Claude for every incoming message.

The intended pipeline:

```text
Slack Collection
       |
       v
Message Normalization
       |
       v
Deduplication
       |
       v
Persistent Storage
       |
       v
Cheap Initial Screening
       |
       +---------------------+
       |                     |
       v                     v
Potentially Urgent      Normal Messages
       |                     |
       v                     v
Urgency Assessment      Batch Analysis
       |                     |
       v                     v
Urgent Inbox             Intelligence Workflows
```

## 7.2 Urgency assessment

Use three signals:

1. People priority.
2. Message urgency.
3. Engineering/work context.

People priority alone must not automatically make a message urgent.

Examples of message urgency:

- Production incidents.
- Explicit blockers.
- Immediate deadlines.
- Time-sensitive requests.

Examples of work context:

- Release blockers.
- Deployment problems.
- Delivery dependencies.
- Work blocking another colleague.

Use inexpensive initial rules to identify candidates.

Claude should perform contextual urgency assessment on relevant candidates rather than every message.

## 7.3 Urgency levels

| Level | Meaning | Behaviour |
|---|---|---|
| Critical | Production incident or severe immediate impact | Immediate notification |
| High | Time-sensitive request or important blocker | Immediate notification |
| Medium | Needs attention but can wait | Normal processing |
| Low | Informational or routine | Normal processing |

## 7.4 Urgent Inbox

For Critical and High messages:

- Add to Urgent Inbox immediately.
- Notify through the local application.
- Display the urgency reason.
- Show sender and conversation context.
- Generate suggested response or action.
- Allow acknowledgement and status tracking.

Never automatically send a response.

Never automatically execute an engineering task.

All external actions require approval.

---

# 8. Commitments and Follow-ups

The application must track commitments made by both the user and other people.

## 8.1 Commitment detection

Examples:

- A colleague promises to share documentation.
- The user promises to fix a bug.
- Someone requests an investigation.
- A delivery is expected by a particular date.
- A Jira issue is assigned and awaiting action.

## 8.2 Commitment data

Each commitment should contain:

- Commitment ID.
- Description.
- Owner.
- Person or team it is owed to.
- Source conversation.
- Source message or Jira issue.
- Creation date.
- Due date, if known.
- Priority.
- Status.
- Next action.
- Completion evidence.
- Closure date.

## 8.3 Status lifecycle

Initial statuses:

- Open.
- In Progress.
- Blocked.
- Completed.
- Cancelled.

Do not assume completion simply because someone says they will do something.

A commitment should close when completion is confirmed or the user explicitly marks it complete.

## 8.4 Follow-up engine

Responsibilities:

- Upcoming commitment reminders.
- Overdue reminders.
- Follow-up recommendations.
- Contextual Slack draft generation.
- Follow-up history.
- Escalation recommendations.

Automatic reminders are permitted.

Sending Slack messages requires approval.

Escalation is recommended, not automatically executed.

## 8.5 Commitments Dashboard

Provide searchable views:

- All commitments.
- Assigned to me.
- Owed by others.
- Open.
- In Progress.
- Blocked.
- Overdue.
- Due soon.
- Closed.

Maintain complete follow-up history.

---

# 9. Engineering Brain

The application maintains one centralized Engineering Brain with individual project profiles.

Example structure:

```text
Engineering Brain
│
├── Sales Product
├── OD Product
├── Internal Tools
└── Personal Projects
```

These are illustrative initial categories, not hardcoded project names.

## 9.1 Initial discovery

Use Claude Code's existing project understanding as a starting point.

Then inspect accessible:

- Repositories.
- Documentation.
- Source code.
- Git history.
- Slack conversations.
- Jira issues.

Do not invent missing information.

Mark uncertain information as unknown or requiring review.

## 9.2 Project profile

Each project should contain:

- Purpose.
- Current status.
- Repositories.
- Technical architecture.
- Important modules.
- Active features.
- Known bugs.
- Technical debt.
- Dependencies.
- Blockers.
- Technical decisions.
- Release milestones.
- Go-live dates.
- Relevant Jira issues.
- Relevant Slack discussions.

## 9.3 Maintenance

Claude periodically recommends updates.

The system should:

- Detect new technical decisions.
- Update feature progress.
- Identify new blockers.
- Track release milestones.
- Detect conflicting information.
- Identify outdated knowledge.
- Associate conversations with projects.
- Preserve knowledge history.

Important engineering knowledge updates should be reviewable and traceable.

The application database owns approved Engineering Brain records.

---

# 10. Claude Orchestrator

This is one of the most important modules.

All Claude Code invocations must pass through a centralized orchestration service.

Do not let individual modules launch independent Claude processes.

## 10.1 Worker profiles

### Intelligence Worker

Responsibilities:

- Slack analysis.
- Urgency assessment.
- People Memory recommendations.
- Commitment extraction.
- Follow-up recommendations.
- Engineering Brain maintenance.
- Jira analysis.
- Response drafting.

### Engineering Worker

Responsibilities:

- Repository investigation.
- Bug analysis.
- Log investigation.
- Technical recommendations.
- Implementation plans.
- Approved code changes.
- Testing and validation.

## 10.2 Resource management

The orchestrator must manage:

- Claude invocation count.
- Configurable resource budgets.
- Concurrency.
- Queue priorities.
- Execution timeouts.
- Failure recovery.
- Task cancellation.
- Usage estimates where available.

Avoid unnecessary Claude invocations.

Batch related intelligence work.

Never launch an unrestricted number of simultaneous Claude Code processes.

### Quota gate (validated in Phase 0)

Every `claude -p` run with `--output-format stream-json` emits a `rate_limit_event` containing the real `five_hour` and `seven_day` utilization (0–1), status and reset time. The orchestrator must:

- Record the latest utilization after every run.
- Refuse to start non-urgent jobs above a configurable threshold, and resume after the reported reset time.
- Reserve headroom for the user's own interactive Claude Code work.
- Track `total_cost_usd` and token usage from each `result` event. This is an API-equivalent figure, not the subscription quota; use it for relative cost tracking only.

Use Haiku (`--model haiku`) for collection and screening. Reserve larger models for analysis and engineering work.

## 10.2.1 Claude Code invocation profile (validated in Phase 0)

The background service invokes the Claude Code CLI under the user's claude.ai login. Connectors require this OAuth login, so `--bare` cannot be used (it accepts only an API key).

Standard flags for every worker run:

```bash
claude -p "<prompt with exact tool names and arguments>" \
  --setting-sources "" --disable-slash-commands \
  --system-prompt "<short worker-specific prompt>" \
  --allowedTools "ToolSearch,<only the tools this job needs>" \
  --disallowedTools "<explicit denylist, including all write/send tools not needed>" \
  --model <model> --max-turns <expected calls + 3> --no-session-persistence \
  --output-format stream-json --verbose < /dev/null
```

Rules:

- `--setting-sources ""`, `--disable-slash-commands` and a short `--system-prompt` cut the per-run context from ~134k to ~36k tokens by skipping the user's plugins, hooks and skills.
- Restrict tools with `--allowedTools` / `--disallowedTools`. Do **not** use `--tools`: it also hides MCP connector tools.
- `ToolSearch` must always be allowed. Connector tools are deferred and can only be loaded through it.
- Name exact tool names in prompts. Vague prompts cause wasted tool-search turns.
- Redirect stdin from `/dev/null` to avoid a startup wait.
- Connectors connect asynchronously and are often `pending` at start. Treat "server not connected" as a retryable error.

### Raw tool results are the only trusted data

The application must parse data only from real `tool_result` events in the stream. It must never treat the model's text reply as data.

In Phase 0 a misconfigured run caused Haiku to write fake tool calls and fabricated Slack messages as plain text, and then report success. Therefore:

- A collection job that produced no real `tool_result` for the expected tool has failed, whatever the model's reply says.
- Validate every parsed record (IDs, timestamps, required fields) before storing it.

## 10.3 Permission policy

| Operation | Default |
|---|---|
| Read Slack | Allowed |
| Read Jira | Allowed |
| Read repositories | Allowed |
| Analyze conversations | Allowed |
| Generate recommendations | Allowed |
| Update People Memory | Approval required |
| Send Slack message | Approval required |
| Modify Jira | Approval required |
| Modify source code | Approval required |
| Git commit | Approval required |
| Git push | Approval required |
| Merge | Approval required |
| Deploy | Explicit approval required |

Permissions must be centrally enforced.

A worker must receive only the capabilities required for its task.

## 10.4 Engineering execution lifecycle

```text
Issue Detected
      |
      v
Automatic Investigation
      |
      v
Analysis and Proposed Fix
      |
      v
Implementation Plan
      |
      v
User Approval
      |
      v
Scoped Code Modification
      |
      v
Testing
      |
      v
Review and Results
      |
      v
User Approval for Commit / Push / Merge
```

Approval must be scoped to a specific task and repository.

Approval to investigate is not permission to modify code.

Approval to modify code is not permission to deploy.

## 10.5 Engineering task serialization

**Only one engineering task may be active at any time.** The orchestrator must never pick up a second engineering task while one is in progress, in any repository.

Reason: every task follows the Git workflow in §10.6, which merges into the parent branch and raises a PR. Two tasks running at once would collide on the parent branch, the merge and the PR.

Rules:

- Engineering jobs take a single global engineering lock, held in the database as a lease with an expiry.
- The lock is held from task pickup until the PR is merged, or until the task is cancelled, rejected or failed and its local branch is cleaned up. Waiting for a user approval does **not** release the lock.
- Other engineering tasks stay `PENDING` in priority order until the lock is released.
- Intelligence jobs (collection, screening, summaries, drafts) are not affected and may run alongside the active engineering task.
- On restart, an expired engineering lease is not released automatically if the repository has uncommitted changes or a half-finished merge. That task becomes `NEEDS_ATTENTION`.

## 10.6 Engineering Git workflow

Every engineering task follows this sequence:

```text
1. Create a local task branch from the parent branch
2. Develop and test on the task branch
3. Update the parent branch:
     git pull origin <parent-branch> && git pull upstream <parent-branch>
4. Merge the task branch locally into the parent branch
5. Raise a PR
6. Merge the PR
```

Rules:

- Before starting, verify the working tree is clean and the expected `origin` and `upstream` remotes exist. Otherwise stop and raise `NEEDS_ATTENTION`.
- If step 3 or step 4 produces a merge conflict, stop and raise `NEEDS_ATTENTION`. Never resolve conflicts automatically without approval.
- Approvals from §10.3 still apply: modifying code, commit, push, raising the PR and merging each need approval.
- Record the task branch, parent branch, commits, PR link and final status in the task's execution history.

---

# 11. Integration Contracts

All integrations must implement stable interfaces.

The application must depend on these contracts, not provider-specific implementations.

## 11.1 Message source contract

Conceptual interface:

```typescript
interface MessageSource {
  connect(): Promise<void>;

  disconnect(): Promise<void>;

  getCapabilities(): Promise<IntegrationCapability[]>;

  listConversations(
    options: ConversationQuery
  ): Promise<Conversation[]>;

  fetchMessages(
    options: MessageQuery
  ): Promise<MessagePage>;

  fetchThread(
    conversationId: string,
    threadId: string
  ): Promise<Message[]>;

  getSyncState(): Promise<SyncState>;
}
```

The Slack implementation uses the existing Claude Code integration initially.

A future native Slack adapter implements the same contract.

## 11.2 Issue source contract

```typescript
interface IssueSource {
  connect(): Promise<void>;

  disconnect(): Promise<void>;

  listIssues(
    options: IssueQuery
  ): Promise<IssuePage>;

  getIssue(
    externalId: string
  ): Promise<Issue>;

  getComments(
    externalId: string
  ): Promise<IssueComment[]>;

  getSyncState(): Promise<SyncState>;
}
```

## 11.3 AI provider contract

```typescript
interface AIProvider {
  execute(
    request: AIExecutionRequest
  ): Promise<AIExecutionResult>;

  getCapabilities(): Promise<AICapability[]>;

  getHealth(): Promise<ProviderHealth>;
}
```

Claude Code is the first provider.

Future providers must be replaceable without changing business modules.

## 11.4 Repository provider contract

```typescript
interface RepositoryProvider {
  discoverRepositories(): Promise<Repository[]>;

  inspectRepository(
    repositoryId: string,
    request: RepositoryInspectionRequest
  ): Promise<RepositoryInspectionResult>;

  getHistory(
    repositoryId: string,
    options: GitHistoryQuery
  ): Promise<GitCommit[]>;
}
```

These interfaces are initial design contracts. Final schemas must be validated and documented before implementation.

---

# 12. Event-Driven Architecture

Modules should communicate through domain events rather than tightly coupled service calls.

Example events:

```text
message.received
message.thread_updated
message.urgent_detected

person.discovered
person.profile_recommendation_created
person.profile_approved

commitment.detected
commitment.approved
commitment.overdue
commitment.completed

followup.recommended
followup.draft_created
followup.sent

jira.issue_updated
jira.issue_blocked

project.discovered
project.knowledge_recommendation_created
project.knowledge_approved

claude.job_created
claude.job_started
claude.job_completed
claude.job_failed

approval.requested
approval.approved
approval.rejected
```

Use a typed event contract.

For important events, persist the event or an equivalent transactional outbox record so a process restart cannot silently lose work.

Consumers must be idempotent.

---

# 13. Database Architecture

Use SQLite with Drizzle ORM.

The database must support migrations, transactions, indexing and referential integrity.

The following is the proposed logical schema. It is not yet a final SQL migration.

## 13.1 Platform tables

- `app_settings`
- `integrations`
- `integration_capabilities`
- `integration_sync_states`
- `modules`
- `module_dependencies`
- `scheduled_tasks`
- `jobs`
- `job_attempts`
- `job_checkpoints`
- `domain_events`
- `audit_events`
- `notifications`
- `approvals`
- `permissions`

## 13.2 Slack tables

- `slack_conversations`
- `slack_messages`
- `slack_attachments`
- `slack_users`
- `slack_message_references`

Preserve external IDs.

Use unique constraints to prevent duplicate imports.

## 13.3 People Memory tables

- `people`
- `temporary_contacts`
- `people_profiles`
- `people_profile_versions`
- `people_profile_recommendations`
- `people_profile_evidence`
- `people_priority_settings`

Keep identity separate from approved knowledge.

A person may exist as a temporary contact without having a permanent profile.

## 13.4 Commitments tables

- `commitments`
- `commitment_sources`
- `commitment_updates`
- `followups`
- `followup_history`

Support multiple source references per commitment.

## 13.5 Engineering Brain tables

- `projects`
- `project_repositories`
- `project_facts`
- `project_decisions`
- `project_milestones`
- `project_dependencies`
- `project_knowledge_recommendations`
- `project_knowledge_evidence`

Preserve the origin of important facts.

## 13.6 Jira tables

- `jira_projects`
- `jira_issues`
- `jira_issue_comments`
- `jira_issue_links`
- `jira_sync_history`

Jira status remains externally authoritative.

## 13.7 Dashboard tables

- `dashboard_layouts`
- `dashboard_widgets`
- `dashboard_widget_settings`

Widgets must read application services through APIs.

## 13.8 Data modeling rules

- Use internal UUIDs for application records.
- Store external identifiers separately.
- Preserve source timestamps.
- Use UTC internally.
- Store source timezone information where relevant.
- Use foreign keys.
- Add indexes for frequent lookup and filtering paths.
- Use soft deletion only where justified.
- Avoid storing duplicate copies of derived knowledge unnecessarily.

---

# 14. Data Retention

Slack message content retention: **180 days**.

The period must be configurable.

## 14.1 Cleanup workflow

A scheduled maintenance worker should:

1. Identify messages older than the configured retention period.
2. Delete expired full message content.
3. Delete expired locally stored attachments.
4. Clean up orphaned local records.
5. Preserve independently stored approved knowledge.
6. Record cleanup execution.

## 14.2 Independent retention

The following must not be automatically deleted just because their source message expires:

- Approved People Memory.
- Approved Engineering Brain records.
- Commitments.
- Follow-up history.
- Important technical decisions.
- Approval records.
- Audit history.

Retain source identifiers where possible.

If the original message is no longer available locally, make that limitation visible.

Before deleting a message, ensure important derived information is preserved with appropriate provenance.

---

# 15. Job Queue and Reliability

Implement a database-backed durable job queue.

Do not require Redis for the initial application.

## 15.1 Job structure

Every job should contain:

- Unique ID.
- Job type.
- Priority.
- Status.
- Input reference.
- Output reference.
- Retry count.
- Maximum attempts.
- Checkpoint.
- Idempotency key.
- Creation time.
- Start time.
- Completion time.
- Error information.

## 15.2 Job lifecycle

```text
PENDING
   |
   v
RUNNING
   |
   +-----------> COMPLETED
   |
   v
FAILED
   |
   v
RETRY
   |
   +-----------> RUNNING
   |
   v
NEEDS_ATTENTION
```

## 15.3 Retry policy

Maximum: 3 automatic retries.

Use exponential backoff.

Differentiate:

- Temporary network failures.
- Authentication failures.
- Invalid input.
- Provider errors.
- Permanent permission failures.
- Incomplete AI output.

Permanent errors should not be retried blindly.

## 15.4 Recovery

On restart:

- Identify interrupted jobs.
- Recover eligible jobs from checkpoints.
- Release expired execution leases.
- Verify uncertain external operations before retrying.
- Preserve failed job history.

For external operations such as Slack message sending, verify whether the action succeeded before retrying.

Prevent duplicate messages and duplicate commitments.

---

# 16. Local Runtime and Process Management

The application must continue operating when the browser is closed.

## 16.1 Processes

Initially run:

1. NestJS backend and background workers.
2. Next.js frontend server.

They should be independently managed.

The NestJS backend must continue operating without the frontend.

## 16.2 Linux service management

Use systemd user services.

Requirements:

- Start on user login.
- Restart on unexpected failure.
- Graceful shutdown.
- Process health checks.
- Persistent logs.
- Controlled restart.
- Explicit manual stop/start.

Do not implement a custom process supervisor.

Phase 0 findings:

- Enable lingering (`loginctl enable-linger <user>`). Otherwise user services stop at logout.
- The systemd user environment does not inherit the interactive shell's PATH (for example, `node` was missing). Set PATH and any required environment explicitly in the unit file.
- The machine must be awake for background work. A suspended laptop stops all collection.

## 16.2.1 Claude Code authentication health

The service uses the Claude Code credentials in `~/.claude/.credentials.json`. The access token lasts a few hours and is refreshed automatically. In Phase 0 the refresh token had an expiry about 7 days out. It is not yet confirmed whether that expiry slides forward on refresh.

The health monitor must:

- Read only the `expiresAt` and `refreshTokenExpiresAt` metadata, never the tokens.
- Notify the user when the refresh expiry is less than 48 hours away.
- Surface authentication failures as `NEEDS_ATTENTION`, not as retryable errors.

The service and the user's interactive sessions share one credentials file. A refresh-rotation race between concurrent processes is plausible but has not been observed. Monitor for it.

## 16.3 Local security

Default to:

- Bind backend and frontend to localhost.
- No public network exposure.
- No remote access unless explicitly configured.
- Store credentials using an OS credential-store abstraction.
- Never log access tokens or secrets.
- Validate all external data.
- Restrict repository access to configured paths.

Desktop notifications should use a replaceable notification adapter.

---

# 17. Dashboard Architecture

The dashboard is a customizable consumer of application data.

No business logic belongs inside widgets.

## 17.1 Initial widget capabilities

- Urgent Inbox.
- Slack Inbox.
- Pending responses.
- Open commitments.
- Overdue commitments.
- Follow-ups due.
- People Memory recommendations.
- Engineering Brain updates.
- Jira blockers.
- Upcoming releases.
- Claude job activity.
- Claude resource usage.
- Pending approvals.

## 17.2 Customization

Users must be able to:

- Add widgets.
- Remove widgets.
- Reorder widgets.
- Resize widgets.
- Configure widget settings.
- Save layouts.

Support the possibility of multiple dashboard layouts in the future.

Widget configuration belongs in the application database.

---

# 18. Security and Approval Engine

All external writes require approval by default.

The application must enforce permissions centrally.

## 18.1 Approval workflow

```text
Action Proposed
      |
      v
Permission Check
      |
      v
Approval Required?
      |
      +------ No ------> Execute
      |
      v
Create Approval Request
      |
      v
User Reviews
      |
      +------ Reject --> Cancel
      |
      v
Approve
      |
      v
Revalidate Permissions
      |
      v
Execute
      |
      v
Audit Result
```

## 18.2 Approval scope

Approvals must identify:

- Proposed action.
- Target integration.
- Target entity.
- Exact intended changes.
- Relevant repository or conversation.
- Risk level.
- Expiry.
- Approval identity.
- Execution result.

Approval for one task must not grant unrestricted permission for future unrelated actions.

## 18.3 Audit

Record:

- Who initiated an action.
- Which module proposed it.
- Which AI worker generated it.
- What was approved.
- When it was executed.
- Whether it succeeded.
- What external record was affected.

---

# 19. Synchronization and Source-of-Truth Rules

| Information | Authoritative source |
|---|---|
| Slack messages | Slack |
| Jira issue status | Jira |
| Source code | Git repositories |
| People Memory | Application database, approved by user |
| Commitments | Application database, supported by evidence |
| Engineering Brain | Application database, maintained through approved knowledge updates |
| Job execution history | Application database |
| Dashboard settings | Application database |

The application must not overwrite authoritative external data based solely on AI interpretation.

Synchronization should be incremental.

Use checkpoints and external identifiers.

---

# 20. Initial Setup Workflow

The first application launch should guide the user through initialization.

## Step 1: Runtime initialization

- Initialize local database.
- Run migrations.
- Validate configuration.
- Verify local services.
- Initialize module registry.

## Step 2: Claude Code integration verification

- Detect Claude Code availability.
- Verify authentication.
- Verify non-interactive execution.
- Verify access to required integrations.
- Validate structured input/output.
- Validate timeout and failure behaviour.

## Step 3: Slack initialization

- Validate Slack connector access.
- Discover accessible conversations.
- Collect the most recent 90 days.
- Filter bots and apps.
- Initialize synchronization checkpoints.

## Step 4: People Memory selection

- Discover individual contacts.
- Ask the user which people to evaluate.
- Exclude group-level profile generation.
- Analyze selected individuals.
- Present recommendations.
- Save approved profiles.

## Step 5: Jira initialization

- Verify Jira access.
- Discover relevant projects and issues.
- Initialize synchronization.
- Maintain Jira as the authoritative issue source.

## Step 6: Engineering Brain initialization

- Discover accessible repositories.
- Inspect existing documentation and code.
- Use Claude's existing project knowledge.
- Identify projects and their relationships.
- Generate initial knowledge recommendations.
- Present important recommendations for review.

## Step 7: Start background operation

- Enable configurable collection schedules.
- Start the durable job processor.
- Enable notifications.
- Activate the application health monitor.

---

# 21. Implementation Roadmap

Build the application incrementally.

Do not implement every feature in one large operation.

## Phase 0 — Technical Proof of Concept

**Status: complete (2026-11-05). No blockers. Results are in `phase0-results.md`.**

Validated:

1. Claude Code CLI is installed and accessible.
2. Non-interactive execution works.
3. Existing Slack access can be invoked.
4. Existing Jira access can be invoked.
5. Structured outputs can be reliably parsed.
6. Long-running tasks can be monitored.
7. Timeouts and failures can be handled.
8. Resource consumption can be observed.

Outcome: all eight items passed. A `claude -p` process run as a systemd user service can invoke the claude.ai Slack and Atlassian connectors. Resource consumption is observable through `rate_limit_event`.

The adapter boundary remains in place so a native Slack or Jira collector can replace the connector later without changes elsewhere.

## Phase 1 — Core Platform

Implement:

- Monorepo.
- Next.js frontend skeleton.
- NestJS backend.
- SQLite database.
- Drizzle migrations.
- Module registry.
- Event contracts.
- Persistent job queue.
- Scheduler.
- Permission manager.
- Approval engine.
- Audit logging.
- Health monitoring.

Deliverable: A running local application with persistent background processing.

## Phase 2 — Claude Orchestrator

Implement:

- Claude Code adapter.
- Intelligence worker.
- Engineering worker.
- Job lifecycle.
- Execution logs.
- Resource limits.
- Concurrency management.
- Structured result validation.

Deliverable: Reliable, controlled Claude execution from the background service.

## Phase 3 — Slack Integration

Implement:

- Connector adapter.
- Conversation discovery.
- Historical backfill.
- Incremental collection.
- Thread retrieval.
- Message normalization.
- Bot filtering.
- Deduplication.
- Sync checkpoints.
- Inbox storage.

Deliverable: A persistent local Slack intelligence data source.

## Phase 4 — Urgency Engine and Inbox

Implement:

- Initial screening.
- People priority integration.
- Contextual urgency assessment.
- Urgent Inbox.
- Notifications.
- Suggested responses.
- Normal batch processing.

Deliverable: Actionable message management.

## Phase 5 — People Memory

Implement:

- Contact discovery.
- User-selected initial evaluation.
- Profile generation.
- Evidence references.
- Approval workflow.
- Profile version history.
- Temporary contacts.
- Unknown-contact recommendations.

Deliverable: Approved, useful People Memory.

## Phase 6 — Commitments and Follow-ups

Implement:

- Commitment extraction.
- Owner identification.
- Due date detection.
- Commitment approval.
- Status lifecycle.
- Reminders.
- Follow-up recommendations.
- Draft generation.
- Sending approval.

Deliverable: Complete commitment lifecycle management.

## Phase 7 — Jira Integration

Implement:

- Jira collector.
- Incremental synchronization.
- Issue tracking.
- Comment tracking.
- Blocker detection.
- Project association.
- Cross-source correlation.

Deliverable: Local Jira intelligence.

## Phase 8 — Engineering Brain

Implement:

- Repository discovery.
- Initial project discovery.
- Project profiles.
- Technical decisions.
- Milestones.
- Dependencies.
- Knowledge recommendations.
- Approval and history.

Deliverable: Centralized engineering knowledge.

## Phase 9 — Engineering Automation

Implement:

- Automatic repository investigation.
- Bug analysis.
- Implementation plans.
- Scoped approvals.
- Approved source modifications.
- Testing.
- Execution history.

Deliverable: Controlled engineering automation.

## Phase 10 — Dashboard and Runtime Hardening

Implement:

- Configurable widgets.
- Dashboard layouts.
- Approval UI.
- Settings.
- Linux service installation.
- Crash recovery.
- Retention cleanup.
- Backup and restore.
- Operational monitoring.

Deliverable: Complete local Engineering Operations Manager.

---

# 22. Testing Requirements

Each module must have:

- Unit tests.
- Contract tests.
- Integration tests.
- Failure-path tests.

Important scenarios:

1. Duplicate Slack message retrieval.
2. Interrupted historical backfill.
3. Slack authentication failure.
4. Jira unavailable during synchronization.
5. Claude process crash.
6. Invalid structured AI output.
7. Duplicate commitment extraction.
8. Profile recommendation rejected.
9. Slack send timeout with uncertain result.
10. Database restart during a job.
11. Expired message cleanup.
12. Approval revoked before execution.
13. Dashboard frontend closed while backend continues running.
14. Multiple workers attempting to claim the same job.
15. Claude run returns a success reply but no real tool result (fabricated output).
16. Connector still `pending` / not connected when a job starts.
17. Claude Code refresh token near expiry or expired.
18. Five-hour quota above threshold when a job is due.
19. Search results with thread replies whose parent was never collected.
20. A second engineering task becomes eligible while one is active (must stay pending).
21. Merge conflict when updating or merging into the parent branch.
22. Service restart while an engineering task holds the lock mid-merge.

Never treat successful compilation as proof of correct functionality.

---

# 23. Claude Code Engineering Instructions

The repository must contain a comprehensive `CLAUDE.md`.

Claude Code must follow these rules:

1. Read the root `CLAUDE.md` before starting development.
2. Read relevant product and architecture documentation.
3. Respect established module boundaries.
4. Use TypeScript consistently.
5. Keep business logic outside frontend components.
6. Never bypass the central permission manager.
7. Never bypass the approval engine.
8. Never launch Claude jobs directly from feature modules.
9. Use shared contracts for integration boundaries.
10. Write migrations for schema changes.
11. Add tests for new workflows.
12. Update architecture documentation when necessary.
13. Record important architectural changes in ADRs.
14. Avoid unnecessary abstractions and dependencies.
15. Never silently change established behaviour.
16. Preserve existing working functionality during refactoring.
17. Do not introduce microservices without an explicit architectural decision.
18. Do not introduce Redis unless justified by demonstrated requirements.
19. Do not store secrets in source code, prompts or ordinary logs.
20. Explain unresolved assumptions rather than inventing answers.

Before implementing a feature, Claude should produce a concise implementation plan that identifies:

- Relevant modules.
- Existing contracts.
- Database changes.
- Events involved.
- Permissions required.
- Tests needed.
- Documentation affected.

---

# 24. Initial Architecture Decisions

The following decisions are considered agreed:

| ID | Decision |
|---|---|
| ADR-001 | Next.js + TypeScript frontend |
| ADR-002 | NestJS + TypeScript backend |
| ADR-003 | SQLite + Drizzle |
| ADR-004 | Modular monolith |
| ADR-005 | Local-first architecture |
| ADR-006 | Persistent background runtime |
| ADR-007 | systemd user services on Linux |
| ADR-008 | Database-backed job processing |
| ADR-009 | Claude Code as initial AI execution provider |
| ADR-010 | Replaceable integration adapters |
| ADR-011 | Replaceable AI provider |
| ADR-012 | Hybrid message processing |
| ADR-013 | Manual approval for external writes |
| ADR-014 | People Memory requires approved recommendations |
| ADR-015 | Commitments track both user and colleagues |
| ADR-016 | Central Engineering Brain with project profiles |
| ADR-017 | Initial Slack history: 90 days |
| ADR-018 | Full Slack message retention: 180 days |
| ADR-019 | People Memory initial profiles are user-selected |
| ADR-020 | Group-level People Memory is deferred |
| ADR-021 | Unknown contacts use temporary records |
| ADR-022 | Job retry limit: 3 automatic retries |
| ADR-023 | Customizable dashboard widgets |
| ADR-024 | External source systems retain authority over original data |
| ADR-025 | Slack collection uses `slack_search_public_and_private` with a Unix-timestamp `after` checkpoint |
| ADR-026 | Only raw `tool_result` events are trusted as data; model text is never stored as source data |
| ADR-027 | Bot filtering relies on Slack's server-side `include_bots: false` |
| ADR-028 | Haiku is the default model for collection and screening jobs |
| ADR-029 | The orchestrator gates jobs on the five-hour/seven-day utilization reported by `rate_limit_event` |
| ADR-030 | Only one engineering task is active at a time (global lock until PR merge); fixed Git workflow per §10.6 |

---

# 25. Open Technical Validations

These are not reasons to abandon the architecture. They are implementation gates.

### A. Claude Code and connector availability — ✅ Resolved

A systemd-launched `claude -p` process can invoke the Slack and Jira connectors. See §10.2.1.

### B. Claude Code resource management — ✅ Resolved

`rate_limit_event` reports real five-hour and seven-day utilization and reset times. See §10.2 Quota gate.

### C. Slack and Jira connector capabilities — ✅ Mostly resolved

Pagination, thread access, precise checkpoints and Jira search are verified. See §5.2 and §5.3.

Remaining:

- Sustained Slack rate limits (only a 5-page burst was tested).
- Write behaviour (not tested; all Phase 0 tests were read-only).
- Bot filter correctness. Not proven, because no bot messages appeared in the tested windows; accepted per ADR-027.

### C.1 Claude Code authentication lifetime — ⚠️ Open

Confirm whether `refreshTokenExpiresAt` slides on refresh. If it is fixed, the user must re-login about weekly. See §16.2.1.

### D. Local credential storage

Validate the available Linux credential-store mechanism.

### E. Data retention and provenance

Ensure expired messages can be removed without destroying independently approved knowledge and audit history.

### F. Background execution — ✅ Partly resolved

Claude jobs run headless under systemd and can be monitored through `stream-json` events. Interruption and recovery are still to be verified in Phase 2.

---

# 26. Definition of Done

The application is not complete merely because its dashboard renders.

It is complete when:

- It starts automatically as a local service.
- It continues running with the browser closed.
- It collects Slack and Jira information through working adapters.
- It persists data safely.
- It handles interrupted jobs.
- It respects Claude Code resource limits.
- It identifies urgent messages.
- It manages approved People Memory.
- It tracks commitments and follow-ups.
- It maintains the Engineering Brain.
- It enforces approval requirements.
- It can recover after restarts.
- It cleans up expired message content.
- It provides reliable audit history.
- Its modules can be replaced independently.
- Its tests validate the critical workflows.

---

# Final Engineering Direction

Build this as a reliable, local-first engineering operations platform.

Do not optimize for visual appearance during the initial development.

Prioritize:

1. Correct architecture.
2. Reliable background operation.
3. Persistent state.
4. Integration correctness.
5. AI execution control.
6. Permission enforcement.
7. Data integrity.
8. Modular extensibility.
9. Functional workflows.
10. UI/UX refinement later.

The first implementation milestone is the Claude Code integration proof of concept, followed by the core platform.

**The central rule: The application manages the work. Claude helps understand and execute the work. The user retains control over important decisions and external actions.**
