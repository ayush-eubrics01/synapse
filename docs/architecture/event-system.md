# Event System

Modules communicate through typed domain events instead of calling each other's internals. Important events are persisted through a transactional outbox, so a restart can't lose work.

## Envelope

```typescript
interface DomainEvent<TType extends string, TPayload> {
  id: string;              // UUID
  type: TType;             // e.g. 'message.received'
  version: number;         // payload schema version, starts at 1
  occurredAt: string;      // ISO-8601 UTC
  aggregateType: string;   // e.g. 'slack_message', 'commitment'
  aggregateId: string;     // internal UUID
  correlationId: string;   // ties a chain of events/jobs together
  causationId?: string;    // id of the event or job that caused this one
  payload: TPayload;       // Zod-validated, defined in packages/contracts/events
}
```

Payloads carry IDs and small facts, not full message text. Consumers load what they need from the owning module.

## Delivery

1. A module writes its state change **and** the event row into `domain_events` in the same SQLite transaction (outbox).
2. The dispatcher reads undispatched events in order and delivers them to registered consumers.
3. Each consumer records `(consumer_name, event_id)` in `event_consumptions` in the same transaction as its own work. A repeat delivery is a no-op, so **consumers must be idempotent**.
4. A consumer that fails is retried with backoff. After max attempts the event is marked for that consumer as `failed` and surfaced in health monitoring. Other consumers keep going.
5. Heavy work is never done inside a consumer. Consumers enqueue jobs.

Events that are purely for live UI updates (SSE) may skip the outbox and are marked `ephemeral` in the catalog.

## Event catalog

| Event | Emitted by | Typical consumers | Notes |
|---|---|---|---|
| `message.received` | inbox | screening, people, commitments | New message stored after dedup |
| `message.thread_updated` | inbox | screening, commitments | New reply in a known thread |
| `message.screened` | inbox | urgency (if candidate), batch analysis | Rule-based screening result |
| `message.urgent_detected` | inbox | notifications, dashboard | Critical/High after assessment |
| `collection.completed` | inbox / jira-tracking | health, dashboard | Per collector run: counts, new checkpoint |
| `collection.failed` | inbox / jira-tracking | health, notifications | Classified error |
| `person.discovered` | people | people (temporary contact) | Unknown sender seen |
| `person.profile_recommendation_created` | people | approvals, dashboard | |
| `person.profile_approved` | people | urgency (priority refresh) | |
| `commitment.detected` | commitments | approvals | AI-extracted, pending review |
| `commitment.approved` | commitments | followups scheduler | |
| `commitment.overdue` | commitments | notifications, followups | |
| `commitment.completed` | commitments | dashboard | |
| `followup.recommended` | commitments | dashboard | |
| `followup.draft_created` | commitments | approvals | |
| `followup.sent` | commitments | audit, people (post-send profile flow) | Only after verified send |
| `jira.issue_updated` | jira-tracking | commitments, engineering-brain | |
| `jira.issue_blocked` | jira-tracking | notifications, dashboard | |
| `project.discovered` | engineering-brain | approvals | |
| `project.knowledge_recommendation_created` | engineering-brain | approvals | |
| `project.knowledge_approved` | engineering-brain | dashboard | |
| `engineering.task_proposed` | engineering-tasks | approvals | Investigation result + plan |
| `engineering.task_started` | engineering-tasks | dashboard | Engineering lock acquired |
| `engineering.task_awaiting_approval` | engineering-tasks | notifications | Code change, commit, push, PR or merge step |
| `engineering.task_completed` | engineering-tasks | dashboard, commitments | PR merged, lock released |
| `engineering.task_failed` | engineering-tasks | notifications | Lock released after cleanup, or NEEDS_ATTENTION |
| `claude.job_created` | orchestrator | dashboard (ephemeral) | |
| `claude.job_started` | orchestrator | dashboard (ephemeral) | |
| `claude.job_completed` | orchestrator | requesting module | Carries runId; result loaded from run log |
| `claude.job_failed` | orchestrator | requesting module, health | ClassifiedError |
| `quota.threshold_reached` | orchestrator | notifications, scheduler | Non-urgent jobs paused until resetsAt |
| `auth.expiry_warning` | health | notifications | Refresh token < 48 h from expiry |
| `autoreply.sent` | inbox / commitments | audit, dashboard (return digest) | ADR-033; only after verified send |
| `autoreply.skipped` | inbox / commitments | approvals, dashboard | Policy check failed; reason recorded; draft queued |
| `away_mode.changed` | settings | dashboard (digest on turning off) | |
| `security.injection_suspected` | security-flags | notifications (high), dashboard, auto-reply policy | ADR-034 |
| `security.flag_reviewed` | security-flags | dashboard | acknowledged/contacted/dismissed |
| `repository.registered` | engineering-brain | engineering-brain (inspection) | ADR-035 |
| `repository.branch_config_changed` | engineering-brain | audit, dashboard | tracked branch or environments changed by the user |
| `repository.drift_detected` | engineering-brain | notifications | |
| `claude_session.activity_changed` | claude-activity | orchestrator (yield), dashboard | User became active or idle (ADR-036) |
| `claude_session.pr_detected` | claude-activity | engineering-brain, jira-tracking, dashboard | PR opened from an interactive session |
| `approval.requested` | approvals | notifications, dashboard | |
| `approval.approved` | approvals | requesting module | Execution happens after revalidation |
| `approval.rejected` | approvals | requesting module | |
| `approval.expired` | approvals | requesting module | |
| `settings.changed` | settings | scheduler, orchestrator | |

New events must be added here and to `packages/contracts/events` in the same change.
