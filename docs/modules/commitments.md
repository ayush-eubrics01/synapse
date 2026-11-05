# Commitments and Follow-ups

Covers the `commitments` domain module (`apps/api/src/modules/commitments`).

## Purpose

Track promises made by the user and by colleagues, and keep stalled conversations from being forgotten. Typical cases: "I'll check and let you know" (requirement 5f), a bug the user promised to fix, a document someone will share, a Jira issue awaiting action. Also detect unclear task specifications and draft follow-up questions to the requester (requirement 5e).

## Responsibilities / Non-responsibilities

Responsibilities:

- Extract commitments from messages and Jira issues (AI, batched), with owner, counterparty, due date and source.
- Commitment approval, status lifecycle and history.
- Detect stalled items: someone said they'd come back, and nothing followed.
- Detect unclear specs in task requests and draft clarifying questions.
- Reminders to the user (automatic). Follow-ups to others need approval, except ADR-033 auto-replies (away mode on, priority person, `stalled_reminder` or `followup_question`).
- Escalation recommendations (never executed automatically).
- Commitments Dashboard views.

Non-responsibilities:

- Sending messages directly. Sends go through approvals, or the ADR-033 auto-reply policy, → `MessageSink`.
- Assuming completion because someone said they'd do something.

## Owned data (tables)

`commitments`, `commitment_sources` (many per commitment), `commitment_updates`, `followups`, `followup_history`.

Commitment fields: ID, description, owner, owed-to, source conversation and message or Jira issue, created, due (if known), priority, status, next action, completion evidence, closed date. `dedup_key` prevents duplicate extraction.

## Ports used / provided

- `ClaudeOrchestrator` (intelligence profile) for extraction, stall analysis, spec-clarity checks and drafting.
- Reads from the `inbox`, `jira-tracking` and `people` public read services.
- Provides read APIs for dashboard views and a `markComplete` / `updateStatus` service for the UI.

## Jobs

| Job type | Trigger | Profile / model | Idempotency key | Retry |
|---|---|---|---|---|
| `commitments.extract` | batch of new messages/issues (debounced, e.g. every 30 min) | intelligence / haiku | `commitments.extract:<batch hash>` | 3 |
| `commitments.check_stalled` | scheduled (default hourly) | rules first; intelligence for context | `commitments.stall:<slot>` | 3 |
| `commitments.check_spec_clarity` | new task-like message or Jira issue | intelligence / haiku | `commitments.spec:<source ref>` | 3 |
| `commitments.draft_followup` | stalled/overdue item or user request | intelligence / haiku or sonnet | `commitments.draft:<commitmentId>:<n>` | 3 |
| `commitments.reminders` | scheduled (default 15 min) | none | `commitments.remind:<slot>` | 3 |

`dedup_key` = normalized (owner, counterparty, source message/issue, description hash). Repeated extraction from the same source updates rather than duplicates.

## Status lifecycle

`open` → `in_progress` → `completed`. Any state may go to `blocked` or `cancelled`. A commitment closes only when completion is confirmed by evidence (a message or Jira status) or when the user marks it complete. Every change writes `commitment_updates` with actor and reason.

## Events

Emitted: `commitment.detected`, `commitment.approved`, `commitment.overdue`, `commitment.completed`, `followup.recommended`, `followup.draft_created`, `followup.sent`.

Consumed: `message.received`, `message.thread_updated`, `jira.issue_updated`, `engineering.task_completed`, `approval.*`.

## Workflows

Extraction:

```text
new messages/issues → commitments.extract (batched)
 → Zod-validated candidates with source refs
 → dedup → commitment.detected (pending review)
 → user approves/edits/rejects → commitment.approved
```

Stalled item (requirement 5f):

```text
approved commitment owed by another person, no reply or evidence
after the configured wait (or past due)
 → mark stalled (next_action = follow up)
 → followup.recommended → draft_followup (uses People Memory guidelines)
 → followup.draft_created
 → away mode on + priority person + policy checks pass (ADR-033):
      auto-send with tag "Sent using @claude", verify, followup.sent, autoreply.sent
 → otherwise: approval.requested → approved: send via MessageSink, verify, followup.sent
 → history recorded either way
```

Unclear spec (requirement 5e): a task or bug request lacking key information (expected behaviour, steps, scope, environment, acceptance criteria) gets a clarity check. If it's unclear, Synapse drafts specific follow-up questions to the requester for approval, and the related engineering task stays in `proposed` until answers arrive. In away mode, questions to a priority person are auto-sent per ADR-033.

Reminders to the user (upcoming, overdue) are automatic notifications. Escalation is recommended in the UI, never executed.

## Permissions and approvals

Extract and recommend: allowed. Create a commitment record: user review (`approval_status`). Send any follow-up or reminder to another person: approval required, except ADR-033 away-mode auto-replies to priority people (`stalled_reminder`, `followup_question`). Escalation: recommendation only.

## Failure handling

- Duplicate extraction → absorbed by `dedup_key`.
- Invalid AI output → retry; after max attempts `NEEDS_ATTENTION`.
- Uncertain send → verify via `findSentMessage` before retry; never a duplicate follow-up.
- Source message expired → `commitment_sources.source_external_ref` remains; the commitment is never deleted by retention.

## Configuration

| Key | Default |
|---|---|
| `commitments.extract.debounceMinutes` | `30` |
| `commitments.stall.waitHours` | `24` (business hours handling TBD) |
| `commitments.reminder.dueSoonHours` | `24` |
| `commitments.requireReviewForDetected` | `true` |

## Dashboard views

All, assigned to me, owed by others, open, in progress, blocked, overdue, due soon, closed. Full follow-up history per commitment.

## Tests

- Duplicate commitment extraction → single record.
- "I'll check and let you know" with no follow-up → stalled → draft → approval → single verified send.
- Completion not assumed from a promise.
- Unclear bug report → clarifying questions drafted; engineering task held.
- Approval revoked before send → nothing sent.
- Send timeout with uncertain result → verified, no duplicate.
- Expired source message → commitment kept with external ref.
- Away mode on, priority person stalled → reminder auto-sent once with the tag; daily cap respected.
- Away mode off, or non-priority person → draft only, nothing sent.

## Open questions

- OQ-1 resolved by ADR-033: stalled reminders and follow-up questions to priority people are auto-sent in away mode.
- **OQ-2 (deferred):** approving follow-ups to non-priority people while away (phone/remote access).
- Stall wait time and business-hours rules are proposals.

See `docs/product/open-questions.md`.
