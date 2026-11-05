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

## Extraction (implemented)

- Consumer `commitments.queue` on `message.received` queues `commitments.extract` (key `commitments.extract:<debounce bucket>`, `runAfter` at the bucket end, group `commitments.intelligence`, priority 50) for a recent message (within `people.history.days`), not expired, not yet extracted, in a conversation involving the user (im, mpim, a mention of the user, a thread the user posted in, or the user's own message). `slack.selfUserId` null queues nothing.
- The handler takes up to `commitments.extract.batchMax` unextracted eligible messages, oldest first. Each is one untrusted part with source `slack message <id> by <you|them:<slackUserId>> in <label> at <sentAt>` (the author id appears only there). Tools: `ToolSearch` only; model `commitments.models.extract`; timeout 420 s.
- Validation (`intelligence/commitments/validate.ts`): evidence ids outside the batch are removed, none left drops the candidate; `low` confidence is dropped; owner and counterparty must each be the author of a cited message or a `<@ID>` mention in one (owner equal to counterparty is dropped); `dueAt` is kept only after the cited message and within a year of it.
- `commitments.dedup_key` = sha256(owner|counterparty|normalized description). A repeated extraction only adds a new `commitment_sources` row. New commitments are `open` and `pending_review` (`accepted` when `commitments.requireReviewForDetected` is false); `direction` is `mine` when the owner is the user. Emits `commitment.detected`.
- A `completion` never creates a commitment and never changes a status. It inserts a `commitment_updates` proposal (`actor: ai`, `field: status`, `to_value: completed`, `reason: proposed:<source ref>`) on an open, accepted commitment of the same owner with a source in the same conversation; otherwise it is dropped. Task 6 confirms proposals.
- The batch's messages get `commitments_extracted_at` in the same transaction as the writes, including messages without a candidate. After a failed run they stay unmarked. The next batch is queued while eligible messages remain.
- Flags follow Phase 5 R5: never attributed to the user's own message.
- R8: in an `im` conversation the DM partner (the non-self author of any stored message there) is also an allowed owner or counterparty. R10 d: at least one of owner and counterparty must be the user.
- R9: schedule `commitments.extract_sweep` (hourly, coalesced) queues one extract job when eligible unmarked messages wait and none is PENDING, RETRY or RUNNING.
- R10: a terminal extract failure marks the batch extracted and writes audit `commitments.batch_skipped` `{count, runId}`; completion proposals also match `pending_review` commitments; a dedup match with a completed, cancelled or rejected commitment creates a new commitment keyed `<base>:<sha256(first source ref)[0..16]>`.

## Review and lifecycle (implemented)

`CommitmentLifecycle` (`modules/commitments/lifecycle.ts`, `Container.commitmentLifecycle`; no routes yet, Task 9 adds them).

- `review(id, "accept"|"reject", edits?)`: only a `pending_review` commitment (else `InvalidReview`). Edits are accept-only and validated (`InvalidCommitmentEdit`): `description` 1..500 characters (trimmed); `dueAt` an offset ISO date-time or null; `dueAt` is stored as UTC ISO; `owner` / `counterparty` Slack ids (must differ) (`^[UW][A-Z0-9]+$`) with at least one equal to `slack.selfUserId` (so edits to them need the identity set); changing the owner recomputes `direction`. Each changed field writes one `commitment_updates` row (`actor: user`; fields `description`, `due_at`, `owner`, `counterparty`, `direction`). Rejecting sets `review_status: rejected` only; `status` is untouched. `dedup_key` is not recomputed after an edit. Emits `commitment.reviewed`.
- `setStatus(id, status, reason?)`: accepted commitments only. `open` to `in_progress`/`blocked`/`completed`/`cancelled`; `in_progress` to `blocked`/`completed`/`cancelled`; `blocked` to `open`/`in_progress`/`cancelled`/`completed`; terminal states are final. Anything else, or a non-accepted commitment, throws `InvalidCommitmentTransition`. Terminal states set `closed_at`. Writes an update row and emits `commitment.status_changed`. A user completion leaves `completion_evidence` null.
- `confirmProposal(updateId, accept)`: the update must be an AI completion proposal (`actor: ai`, `field: status`, `to_value: completed`, `reason: proposed:<ref>`) with no decision row, else `InvalidProposal`. A decision is a user update row with `field: proposal` (never `status`, so history readers do not see a rejection as a status change) and reason `confirmed_proposal:<updateId>` or `rejected_proposal:<updateId>`. Accepting also applies `completed` (normal transition rules; reason `accepted_proposal:<updateId>`, `completion_evidence` = source ref, `closed_at`). Rejecting is allowed on any commitment, including closed ones. `setStatus` refuses a free-text reason starting with a decision prefix.
- `listViews(filter, limit = 200)` (max 500, applied after ordering) returns `CommitmentView[]` with sources (`messageAvailable`, http(s) permalink or null, ref kept after expiry), pending proposals (hidden once the commitment is closed), follow-up summaries, owner and counterparty names, and server-computed `actions`. `all`, `open`, `in_progress`, `blocked`, `overdue`, `closed` cover accepted commitments; `mine` and `theirs` cover accepted, not closed ones; `due_soon` is accepted, not closed, due within `commitments.reminder.dueSoonHours` and not yet past; `overdue` is `due_at < now` and not closed; `review` is `pending_review` plus `rejected` (the review history; rejected rows appear nowhere else). Order: overdue first, then soonest due, then newest.

## Stall detection, reminders and follow-up drafts (implemented)

`StallService` (`modules/commitments/stall.ts`) backs two scheduled, no-AI jobs (both coalesced); `commitments.draft_followup` is the only Claude job here.

- `commitments.check_stalled` (hourly). Accepted, open or in-progress `theirs` commitments. X = max(newest source message `sent_at` (the commitment's `created_at` if none survives), `last_followup_at`). Stalled when the owner (their Slack user) has no message in any source conversation after X (null or expired text still counts as a message) and either X is at least `commitments.stall.waitHours` old, or the commitment is past due and no follow-up was sent within the last `waitHours`. It sets `stalled_at` (and `next_action` = `Follow up` when empty), emits `commitment.stalled` and enqueues `commitments.draft_followup` (key `commitments.draft:<id>:<stalled_at>`, group `commitments.intelligence`, priority 70, input `{commitmentId, stalledAt}`). A commitment with `stalled_at` set is skipped until the owner replies after it, or `last_followup_at` > `stalled_at` (Task 9 sets it); either clears `stalled_at` and the wait restarts.
- Overdue `mine` commitments (accepted, not closed, `due_at` in the past) emit `commitment.overdue` once. The marker is a `commitment_updates` row `actor: system`, `field: overdue_notified`, `to_value` = the due date (no content).
- `commitments.reminders` (every 15 minutes). For accepted, open `mine` commitments with a due date that is within `commitments.reminder.dueSoonHours` (`due_soon`, severity `warning`) or past (`overdue`, severity `high`): one notification per (commitment, state), `kind: commitment.reminder`, `ref: commitment:<id>:<state>` (dedup key), title `Due soon: commitment to <name>` / `Overdue: commitment to <name>`, or `... your commitment` without a counterparty name. The description is never in the title or body. Notifications trigger the desktop notifier through `NotificationService`.
- `commitments.draft_followup` (intelligence profile, `batch`, model `commitments.models.draft`, `ToolSearch` only, 3 turns, 420 s). Skipped (no run) when the commitment is not `accepted`, closed, not stalled (or the job's `stalledAt` is stale) or already has a `draft` / `awaiting_approval` followup. Parts: system, a `user_approved` commitment description, a `user_approved` guidelines part when the owner has approved response guidelines (H1: drafting only, never in a send run; no Slack name in trusted text), then up to 10 untrusted context messages (newest non-expired text from the source conversations, source threads first, shown oldest first). Output `followupDraftOutputSchema`; the draft is stored through `renderExcerpt(draft, 4000)` in a `followups` row (`origin: stalled`, `status: draft`, `conversation_id` = internal conversation id of the newest available source, `thread_ts` = that message's `thread_ts` or its `ts`, recipient = owner, `confidence`) and `followup.draft_created` is emitted. When no source message text is available (expired or deleted), `thread_ts` is null and `followup_history` gets `noThread` / `no_thread`; the user sees this before sending (Task 9). Flags follow R5 (never the user's own message).

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
