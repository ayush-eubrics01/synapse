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
| `integrations` | Configured integrations | `id`, `kind` (slack/jira/claude/repository), `adapter`, `config` JSON (e.g. Jira `cloud_id`; nullable), `enabled` (default true), `created_at`. Unique(`kind`,`adapter`) |
| `integration_capabilities` | Discovered capabilities | `integration_id` FK → `integrations.id`, `name`, `available`, unique(`integration_id`,`name`) |
| `integration_sync_states` | Checkpoints | `integration_id` FK → `integrations.id`, `stream` (e.g. `slack.messages`, `slack.backfill`, `jira.issues`), `checkpoint` (text, nullable; Slack ts / Jira updated), `cursor` (nullable), `status` (idle/running/paused/complete/error, default idle), `last_success_at`, `last_error` JSON, `upper_bound` (text, nullable; the backfill's `before`), `pages_done` int default 0, `search_count_date` (text YYYY-MM-DD, nullable), `search_count` int default 0, `next_run_after` (text, nullable), `backoff_minutes` int default 0, `stall_count` int default 0 (consecutive backfill runs that left the checkpoint unchanged), `generation` (text, nullable; ISO time of the backfill start or resume, part of its job idempotency key). Unique(`integration_id`,`stream`) |
| `modules`, `module_dependencies` | Module registry | name, enabled, version; dependency edges |
| `scheduled_tasks` | Recurring schedules | `name` unique, `job_type`, `interval_seconds` (nullable), `cron` (nullable), `input` JSON, `priority` (default 100), `enabled`, `next_run_at`, `last_run_at`. The opt-in `coalesce` flag (R58) is set in code at registration, not stored |
| `jobs` | Durable queue | `id`, `type`, `priority`, `status` (PENDING/RUNNING/RETRY/COMPLETED/FAILED/NEEDS_ATTENTION/CANCELLED), `input` JSON, `output` JSON (nullable), `attempts`, `max_attempts` (3), `idempotency_key` unique, `concurrency_group` (e.g. `engineering`), `external_write` (boolean, default false; set at enqueue for jobs that write to an external system — an uncertain outcome after a timeout, forced stop or crash goes to NEEDS_ATTENTION instead of RETRY), `run_after`, `lease_owner`, `lease_expires_at`, timestamps, `last_error` JSON. Index (`status`,`priority`,`run_after`) |
| `job_attempts` | Per-attempt history | `job_id` FK, `attempt`, `started_at`, `finished_at`, `status`, `error` JSON, `claude_run_id` FK nullable |
| `job_checkpoints` | Resumable progress | `job_id` FK, `checkpoint` JSON, `updated_at` |
| `leases` | Named locks | `name` PK (e.g. `engineering`), `holder` (job/task id), `acquired_at`, `expires_at`, `heartbeat_at` |
| `claude_runs` | Every Claude execution | `id` (runId), `job_id` FK, `worker_profile`, `model`, `status`, `num_turns`, `duration_ms`, token columns, `cost_usd_equivalent`, `permission_denials` JSON, `error` JSON, `started_at`, `finished_at`. Raw tool results are not stored here |
| `quota_snapshots` | Quota history | `observed_at`, `five_hour_utilization`, `five_hour_resets_at`, `seven_day_utilization`, `seven_day_resets_at`, `status` (combined), `five_hour_status`, `seven_day_status` (nullable; null on pre-R30 rows), `claude_run_id` FK |
| `auth_snapshots` | Credential expiry history (ADR-037): `observed_at`, `access_expires_at`, `refresh_expires_at`, `claude_run_id` FK. Never tokens |
| `domain_events` | Outbox | `id`, `type`, `version`, `aggregate_type`, `aggregate_id`, `correlation_id`, `causation_id`, `payload` JSON, `occurred_at`, `dispatched_at`, `ephemeral` |
| `event_consumptions` | Consumer idempotency | unique(`consumer`,`event_id`), `status`, `attempts`, `last_error`, `next_attempt_at` (nullable; retry backoff, base 5 s, cap 5 min) |
| `audit_events` | Append-only audit | `actor` (user/system/module), `module`, `worker_profile`, `action`, `target_integration`, `target_ref`, `approval_id`, `result`, `details` JSON (nullable), `occurred_at`. Never deleted by retention |
| `notifications` | In-app notifications | `kind`, `severity`, `title`, `body`, `ref`, `read_at` |
| `approvals` | Approval requests | `action`, `target_integration`, `target_ref`, `payload` JSON (exact intended change), `risk_level`, `status` (pending/approved/rejected/expired/executed/failed/revoked), `expires_at`, `decided_at`, `execution_result` JSON, `execution_started_at` (nullable; set atomically when `execute` claims the approval, so a second concurrent execute cannot run the executor), `requested_by_module`, `requested_by_worker` (nullable), `idempotency_key` unique |
| `permissions` | Policy overrides | `operation`, `policy` (allowed/approval/explicit_approval/denied), `scope` JSON |

## Slack tables (owned by `inbox`)

| Table | Key columns / constraints |
|---|---|
| `slack_conversations` | `external_id` unique (channel/DM ID), `type` (im/mpim/channel), `name` (nullable), `accessible` (default true), `last_seen_ts` (nullable) |
| `slack_users` | `external_id` unique (U…), `name` (nullable), `email` (nullable), `is_bot` (nullable; not exposed by connector) |
| `slack_messages` | `conversation_id` FK → `slack_conversations.id`, `ts` (verbatim), unique(`conversation_id`,`ts`), `thread_ts` nullable, `sender_user_id` FK → `slack_users.id`, `text` (nullable after retention), `full_notes` (nullable), `permalink` (nullable), `reply_count` (default 0), `sent_at`, `collected_at`, `content_expired_at` (nullable), `screening` JSON, `urgency_level`, `urgency_reason`, `urgency_status` (all nullable). Index (`sent_at`), (`conversation_id`,`thread_ts`), (`urgency_level`,`urgency_status`) |
| `slack_attachments` | `message_id` FK → `slack_messages.id`, `external_file_id`, `name` (nullable), `local_path` nullable |
| `slack_message_references` | Links messages to other entities: `message_id` FK → `slack_messages.id`, `ref_type` (commitment/project/jira_issue/person), `ref_id` |

## People tables (owned by `people`)

| Table | Notes |
|---|---|
| `people` | Identity only: `slack_user_id` unique not null, name, email, `created_at` (title and team arrive with the people module) |
| `temporary_contacts` | Short-lived context for unknown people; `slack_user_id` unique, `expires_at`, `profile_assessment` JSON |
| `people_profiles` | Current approved profile per person (`person_id` unique), structured sections JSON |
| `people_profile_versions` | Immutable history: `profile_id`, `version`, `content` JSON, `approval_id` |
| `people_profile_recommendations` | Proposed changes, `status`, `claude_run_id` |
| `people_profile_evidence` | `recommendation_id` or `version_id`, `message_id` (nullable after retention), `source_external_ref` (always kept), `confidence`, `observed_at` |
| `people_priority_settings` | `person_id` FK unique, `priority` (normal/high/critical, manual only), `rationale` (nullable), `extra_attention` (default false), `updated_at` |

## Commitments tables (owned by `commitments`)

| Table | Notes |
|---|---|
| `commitments` | `description`, `owner_person_id`, `owed_to_person_id`, `status` (open/in_progress/blocked/completed/cancelled), `priority`, `due_at`, `next_action`, `completion_evidence`, `closed_at`, `approval_status`, `dedup_key` unique |
| `commitment_sources` | Multiple per commitment: `source_type` (slack_message/jira_issue), `source_external_ref`, `message_id` nullable |
| `commitment_updates` | Status history with actor and reason |
| `followups` | Scheduled reminders/follow-ups: `commitment_id`, `kind` (reminder_to_user/followup_to_other), `due_at`, `status`, `draft_text`, `approval_id` |
| `followup_history` | What happened to each follow-up, including sent message ref |

## Engineering Brain tables (owned by `engineering-brain`)

| Table | Notes |
|---|---|
| `repositories` | `name`, `local_path` unique, `origin_url`, `upstream_url`, `upstream_push_disabled`, `tracked_branch`, `notes`, `registered_at`, `last_drift_check_at` (ADR-035) |
| `repository_environments` | `repository_id` FK, `name` (e.g. stage/prod), `branch`, `notes`, unique(`repository_id`,`name`) |


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
| `engineering_tasks` | `source_ref` (message/Jira/commitment), `repository_id` FK, `environment_id` FK nullable, `parent_branch` (user-confirmed, ADR-035), `task_branch`, `approved_description` (the only text given to the engineering worker, ADR-032), `status` (proposed/approved/in_progress/awaiting_approval/completed/failed/cancelled/needs_attention), `plan` JSON, `pr_url`, timestamps |
| `engineering_task_steps` | Ordered steps of the Git workflow (§10.6): `step` (branch/develop/test/update_parent/merge_local/raise_pr/merge_pr), `status`, `approval_id`, `claude_run_id`, `output` JSON |

## Auto-reply table (owned by `inbox`, used by `commitments`)

| Table | Notes |
|---|---|
| `auto_replies` | ADR-033 decisions: `source_message_id` FK, `recipient_person_id` FK, `kind` (code_answer/stalled_reminder/followup_question/acknowledgement), `conversation_id`, `thread_ts`, `text` (including tag), `confidence`, `policy_result` JSON (each check + outcome), `status` (sent/skipped/failed), `sent_ts`, `approval_id` (if it fell back to approval), `idempotency_key` unique, `created_at`. Index (`recipient_person_id`,`created_at`) for daily caps. Kept like audit (not deleted by message retention) |

Away mode itself is the `autoReply.awayMode` key in `app_settings`, with changes recorded in `audit_events`.

## Security flag tables (owned by `security-flags`)

| Table | Notes |
|---|---|
| `security_flags` | `message_id` FK nullable, `source_external_ref` (always kept), `slack_user_id`, `person_id` FK nullable, `conversation_id`, `detector` (rules/ai/runtime), `rule_id`, `claude_run_id` FK nullable, `severity` (info/warning/high), `excerpt` (≤ 300 chars), `reason`, `status` (open/acknowledged/contacted/dismissed), `rules_version`, `created_at`, `reviewed_at`, `updated_at`. `rule_id` is NOT NULL: the `ai` and `runtime` detectors use the literal `"ai"` and `"runtime"`. Unique(`message_id`,`detector`,`rule_id`). Index (`status`,`severity`), (`slack_user_id`). Kept like audit (not deleted by message retention) |
| `security_flag_rules` | Versioned rule config: `version` int unique, `rules` JSON, `active`, `created_at` |
| `message_drafts` | Suggested replies (owned by the urgency engine): `message_id` FK, `kind` (`suggested_response`), `text` (nullable; cleared by retention), `confidence` real, `status` (proposed/discarded), `claude_run_id` nullable FK, `created_at`, `content_expired_at`. Unique(`message_id`,`kind`) |

## Claude activity tables (owned by `claude-activity`, ADR-036)

| Table | Notes |
|---|---|
| `claude_sessions` | `session_id` unique, `repository_id` FK, `cwd`, `git_branch`, `title`, `entrypoint`, `cli_version`, `started_at`, `last_activity_at`, `file_path`, `read_offset` (incremental parsing). Metadata only, never message content |
| `claude_session_prs` | `session_id` FK, `pr_url` unique, `pr_number`, `pr_repository`, `first_seen_at`, links to `engineering_tasks` / `jira_issues` when matched |

## Dashboard tables (owned by `dashboard`)

`dashboard_layouts`, `dashboard_widgets`, `dashboard_widget_settings`.

## Retention

Slack message content is kept for 180 days (configurable). The cleanup job sets `slack_messages.text = NULL`, deletes local attachments, and sets `content_expired_at`, keeping IDs, `ts` and permalinks. People profiles, commitments, follow-ups, Engineering Brain records, approvals and audit events are never deleted by message retention. Evidence rows keep `source_external_ref`, so the UI can show "original message no longer available locally."
