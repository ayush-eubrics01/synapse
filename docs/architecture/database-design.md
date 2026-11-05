# Database Design

SQLite with Drizzle ORM. This is the logical schema. The Drizzle schema in `packages/database` is the implementation and must match this document; update both together.

## Configuration

- `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout` ≥ 5000 ms.
- Explicit, forward-only migrations. Never edit an applied migration.
- Writes that change state and emit an event happen in one transaction (outbox).
- Scheduled backups with `VACUUM INTO` (or the SQLite online backup API) to a configured directory.

## Modeling rules

- Primary keys are internal UUIDs (`id TEXT`).
- External identifiers are stored in their own columns with unique constraints.
- Times are ISO-8601 UTC text. Source timestamps (Slack `ts`, Jira `updated`) are also kept verbatim.
- Foreign keys everywhere a relation exists. Index every frequent filter and lookup path.
- Soft deletion only where justified (noted per table).
- Every AI-generated record has provenance: source references, confidence, created/reviewed dates.

## Platform tables

| Table | Purpose | Key columns / constraints |
|---|---|---|
| `app_settings` | Key/value settings | `key` PK, `value` JSON, `updated_at` |
| `integrations` | Configured integrations | `id`, `kind` (slack/jira/claude/repository), `adapter`, `config` JSON (e.g. Jira `cloud_id`), `enabled` |
| `integration_capabilities` | Discovered capabilities | `integration_id` FK, `name`, `available`, unique(`integration_id`,`name`) |
| `integration_sync_states` | Checkpoints | `integration_id` FK, `stream` (e.g. `slack.messages`, `slack.backfill`, `jira.issues`), `checkpoint` (Slack ts / Jira updated), `cursor`, `status`, `last_success_at`, `last_error` JSON, unique(`integration_id`,`stream`) |
| `modules`, `module_dependencies` | Module registry | name, enabled, version; dependency edges |
| `scheduled_tasks` | Recurring schedules | `name` unique, `job_type`, `interval_seconds`, `enabled`, `next_run_at` |
| `jobs` | Durable queue | `id`, `type`, `priority`, `status` (PENDING/RUNNING/RETRY/COMPLETED/FAILED/NEEDS_ATTENTION/CANCELLED), `input` JSON, `output_ref`, `attempts`, `max_attempts` (3), `idempotency_key` unique, `concurrency_group` (e.g. `engineering`), `run_after`, `lease_owner`, `lease_expires_at`, timestamps, `last_error` JSON. Index (`status`,`priority`,`run_after`) |
| `job_attempts` | Per-attempt history | `job_id` FK, `attempt`, `started_at`, `finished_at`, `status`, `error` JSON, `claude_run_id` FK nullable |
| `job_checkpoints` | Resumable progress | `job_id` FK, `checkpoint` JSON, `updated_at` |
| `leases` | Named locks | `name` PK (e.g. `engineering`), `holder` (job/task id), `acquired_at`, `expires_at`, `heartbeat_at` |
| `claude_runs` | Every Claude execution | `id` (runId), `job_id` FK, `worker_profile`, `model`, `status`, `num_turns`, `duration_ms`, token columns, `cost_usd_equivalent`, `permission_denials` JSON, `error` JSON, `started_at`, `finished_at`. Raw tool results are not stored here |
| `quota_snapshots` | Quota history | `observed_at`, `five_hour_utilization`, `five_hour_resets_at`, `seven_day_utilization`, `seven_day_resets_at`, `status`, `claude_run_id` FK |
| `domain_events` | Outbox | `id`, `type`, `version`, `aggregate_type`, `aggregate_id`, `correlation_id`, `causation_id`, `payload` JSON, `occurred_at`, `dispatched_at`, `ephemeral` |
| `event_consumptions` | Consumer idempotency | unique(`consumer`,`event_id`), `status`, `attempts`, `last_error` |
| `audit_events` | Append-only audit | `actor` (user/system/module), `module`, `worker_profile`, `action`, `target_integration`, `target_ref`, `approval_id`, `result`, `occurred_at`. Never deleted by retention |
| `notifications` | In-app notifications | `kind`, `severity`, `title`, `body`, `ref`, `read_at` |
| `approvals` | Approval requests | `action`, `target_integration`, `target_ref`, `payload` JSON (exact intended change), `risk_level`, `status` (pending/approved/rejected/expired/executed/failed), `expires_at`, `decided_at`, `execution_result` JSON, `idempotency_key` unique |
| `permissions` | Policy overrides | `operation`, `policy` (allowed/approval/explicit_approval/denied), `scope` JSON |

## Slack tables (owned by `inbox`)

| Table | Key columns / constraints |
|---|---|
| `slack_conversations` | `external_id` unique (channel/DM ID), `type` (im/mpim/private_channel/public_channel, from result labels), `name`, `accessible`, `last_seen_ts` |
| `slack_users` | `external_id` unique (U…), `name`, `email`, `is_bot` (nullable; not exposed by connector) |
| `slack_messages` | `conversation_id` FK, `ts` (verbatim), unique(`conversation_id`,`ts`), `thread_ts` nullable, `sender_user_id` FK, `text` (nullable after retention), `permalink`, `reply_count`, `sent_at`, `collected_at`, `content_expired_at`, `screening` JSON, `urgency_level`, `urgency_reason`, `urgency_status`. Index (`sent_at`), (`thread_ts`), (`urgency_level`,`urgency_status`) |
| `slack_attachments` | `message_id` FK, `external_file_id`, `name`, `local_path` nullable |
| `slack_message_references` | Links messages to other entities: `message_id` FK, `ref_type` (commitment/project/jira_issue/person), `ref_id` |

## People tables (owned by `people`)

| Table | Notes |
|---|---|
| `people` | Identity only: `slack_user_id` unique, name, email, title, team |
| `temporary_contacts` | Short-lived context for unknown people; `slack_user_id` unique, `expires_at`, `profile_assessment` JSON |
| `people_profiles` | Current approved profile per person (`person_id` unique), structured sections JSON |
| `people_profile_versions` | Immutable history: `profile_id`, `version`, `content` JSON, `approval_id` |
| `people_profile_recommendations` | Proposed changes, `status`, `claude_run_id` |
| `people_profile_evidence` | `recommendation_id` or `version_id`, `message_id` (nullable after retention), `source_external_ref` (always kept), `confidence`, `observed_at` |
| `people_priority_settings` | `person_id` unique, `priority` (manual only), `rationale`, `extra_attention` |

## Commitments tables (owned by `commitments`)

| Table | Notes |
|---|---|
| `commitments` | `description`, `owner_person_id`, `owed_to_person_id`, `status` (open/in_progress/blocked/completed/cancelled), `priority`, `due_at`, `next_action`, `completion_evidence`, `closed_at`, `approval_status`, `dedup_key` unique |
| `commitment_sources` | Multiple per commitment: `source_type` (slack_message/jira_issue), `source_external_ref`, `message_id` nullable |
| `commitment_updates` | Status history with actor and reason |
| `followups` | Scheduled reminders/follow-ups: `commitment_id`, `kind` (reminder_to_user/followup_to_other), `due_at`, `status`, `draft_text`, `approval_id` |
| `followup_history` | What happened to each follow-up, including sent message ref |

## Engineering Brain tables (owned by `engineering-brain`)

`projects`, `project_repositories`, `project_facts`, `project_decisions`, `project_milestones` (including go-live dates), `project_dependencies`, `project_knowledge_recommendations`, `project_knowledge_evidence`. Facts and decisions carry `status` (approved/needs_review/unknown/outdated), `source_refs`, `approved_at`, and supersede links for history.

## Jira tables (owned by `jira-tracking`)

| Table | Notes |
|---|---|
| `jira_projects` | `key` unique |
| `jira_issues` | `key` unique, `external_id` unique, status, priority, assignee, reporter, `due_date`, `updated_at_source`, `last_synced_at`, `attention_state` |
| `jira_issue_comments` | `external_id` unique, `issue_id` FK |
| `jira_issue_links` | Issue-to-issue and issue-to-entity links |
| `jira_sync_history` | Per sync run: counts, checkpoint, errors |

## Engineering task tables (owned by `engineering-tasks`)

| Table | Notes |
|---|---|
| `engineering_tasks` | `source_ref` (message/Jira/commitment), `repository_id`, `parent_branch`, `task_branch`, `status` (proposed/approved/in_progress/awaiting_approval/completed/failed/cancelled/needs_attention), `plan` JSON, `pr_url`, timestamps |
| `engineering_task_steps` | Ordered steps of the Git workflow (§10.6): `step` (branch/develop/test/update_parent/merge_local/raise_pr/merge_pr), `status`, `approval_id`, `claude_run_id`, `output` JSON |

## Dashboard tables (owned by `dashboard`)

`dashboard_layouts`, `dashboard_widgets`, `dashboard_widget_settings`.

## Retention

Slack message content is kept for 180 days (configurable). The cleanup job sets `slack_messages.text = NULL`, deletes local attachments, and sets `content_expired_at`, keeping IDs, `ts` and permalinks. People profiles, commitments, follow-ups, Engineering Brain records, approvals and audit events are never deleted by message retention. Evidence rows keep `source_external_ref`, so the UI can show "original message no longer available locally."
