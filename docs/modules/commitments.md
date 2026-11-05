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
| `commitments.extract` | batch of new messages (debounced, default 30 min; hourly sweep) | intelligence / haiku | `commitments.extract:<debounce bucket>` | 3 |
| `commitments.check_stalled` | scheduled (hourly, coalesced) | none (rules only) | scheduler slot | 3 |
| `commitments.check_spec_clarity` | new task-like message or Jira issue | intelligence / haiku | `commitments.spec:<source ref>` | 3 |
| `commitments.draft_followup` | stalled item or user request | intelligence / haiku | `commitments.draft:<commitmentId>:<stalled_at>` | 3 |
| `commitments.reminders` | scheduled (15 min, coalesced) | none | scheduler slot | 3 |
| `commitments.extract_sweep` | scheduled (hourly, coalesced) | none | `commitments.extract:sweep:<hour>` | 3 |
| `outgoing.verify` | after an unverified or uncertain send | none (searches Slack) | `outgoing.verify:<outgoingId>:<attempt>` | 3 |

`dedup_key` = normalized (owner, counterparty, source message/issue, description hash). Repeated extraction from the same source updates rather than duplicates.

## Status lifecycle

`open` → `in_progress` → `completed`. Any state may go to `blocked` or `cancelled`. A commitment closes only when completion is confirmed by evidence (a message or Jira status) or when the user marks it complete. Every change writes `commitment_updates` with actor and reason.

## Implementation notes (Phase 6)

What is built. Phase 6 is Slack only: Jira sources, the engineering-task hold on unclear specs and the ADR-033 away-mode auto-replies are not implemented.

### Extraction

- Consumer `commitments.queue` on `message.received` queues `commitments.extract` (key `commitments.extract:<debounce bucket>`, `runAfter` at the bucket end, group `commitments.intelligence`, priority 50) for a recent message (within `people.history.days`), not expired, not yet extracted, in a conversation involving the user (an im, a mention of the user, a thread the user posted in, or the user's own message). `slack.selfUserId` null queues nothing. The hourly `commitments.extract_sweep` queues one extract job when eligible unmarked messages wait and none is PENDING, RETRY or RUNNING, so a failed batch never waits for the next qualifying message.
- The handler takes up to `commitments.extract.batchMax` (default and maximum 40) unextracted eligible messages, oldest first, read in pages so non-interacting rows never fill the batch. Each is one untrusted part whose source line carries the message id, `you` or `them:<slackUserId>`, the conversation label and the time. Tools: `ToolSearch` only; model `commitments.models.extract`; timeout 420 s.
- Validation (`intelligence/commitments/validate.ts`), every rule drops the candidate or the offending piece:
  - Evidence ids outside the batch are removed; none left drops the candidate. Only what was sent can be cited.
  - `low` confidence is dropped.
  - Owner and counterparty must each be the author of a cited message or a `<@ID>` mention in one, and must differ. In an `im` conversation the DM partner (the non-self author of any stored message there) is also allowed.
  - At least one of owner and counterparty must be the user; a commitment between two other people is dropped.
  - `dueAt` is kept only after the cited message and within a year of it, and is stored as UTC ISO.
- A `completion` never creates a commitment and never changes a status. It inserts a `commitment_updates` proposal (`actor: ai`, `field: status`, `to_value: completed`, `reason: proposed:<source ref>`) on an open commitment (accepted or still `pending_review`, never rejected) of the same owner with a source in the same conversation; otherwise it is dropped. "I'll do X" is therefore never completion; the user confirms every proposal.
- Counts are returned and nothing else: `messages`, `candidates`, `dropped`, `created`, `source_added`, `unchanged`, `proposed`, `no_match`. Flags follow the people rule: never attributed to the user's own message.
- Batch bookkeeping: the batch's messages get `commitments_extracted_at` in the same transaction as the writes, including messages without a candidate. After a failed run they stay unmarked and the next batch is queued while eligible messages remain. A terminal failure (attempts exhausted, or a needs-attention or fail kind) marks that batch extracted and writes audit `commitments.batch_skipped` `{count, runId}`, so a poison batch never blocks newer messages.

### Dedup

`commitments.dedup_key` = sha256(owner|counterparty|normalized description). A repeated extraction only adds a `commitment_sources` row (`source_added`) or changes nothing. The base-key row is reused only while it is non-terminal (status not completed or cancelled and review not rejected); otherwise a new commitment is created with the key `<base>:<sha256(first source ref)[0..16]>`. Paraphrases of one promise can still create two rows. New commitments are `open` and `pending_review` (`accepted` when `commitments.requireReviewForDetected` is false); `direction` is `mine` when the owner is the user. Emits `commitment.detected`.

### Review and lifecycle

`CommitmentLifecycle` (`modules/commitments/lifecycle.ts`, `Container.commitmentLifecycle`).

- `review(id, "accept"|"reject", edits?)`: only a `pending_review` commitment (else `InvalidReview`). Edits are accept-only and validated (`InvalidCommitmentEdit`): `description` 1..500 characters (trimmed); `dueAt` an offset ISO date-time or null, stored as UTC ISO; `owner` and `counterparty` Slack ids (`^[UW][A-Z0-9]+$`, different from each other) with at least one equal to `slack.selfUserId`; changing the owner recomputes `direction`. Each changed field writes one `commitment_updates` row (`actor: user`; fields `description`, `due_at`, `owner`, `counterparty`, `direction`), and every review writes a row `actor: user`, `field: review_status` (`pending_review` to `accepted` or `rejected`). Rejecting sets `review_status: rejected` only; `status` is untouched. `dedup_key` is not recomputed after an edit. Emits `commitment.reviewed`.
- `setStatus(id, status, reason?)`: accepted commitments only. `open` to `in_progress`, `blocked`, `completed` or `cancelled`; `in_progress` to `blocked`, `completed` or `cancelled`; `blocked` to `open`, `in_progress`, `cancelled` or `completed`; terminal states are final. Anything else throws `InvalidCommitmentTransition`. Terminal states set `closed_at`. Writes an update row and emits `commitment.status_changed`. A user completion leaves `completion_evidence` null.
- `confirmProposal(updateId, accept)`: the update must be an AI completion proposal with no decision row, else `InvalidProposal`. A decision is a user update row with `field: proposal` (never `status`, so history readers do not read a rejection as a status change) and reason `confirmed_proposal:<updateId>` or `rejected_proposal:<updateId>`. Accepting also applies `completed` (normal transition rules; reason `accepted_proposal:<updateId>`, `completion_evidence` = source ref, `closed_at`). Rejecting is allowed on any commitment. `setStatus` refuses a free-text reason that starts with a decision prefix.
- `listViews(filter, limit = 200)` (max 500, applied after ordering) returns `CommitmentView[]` with sources (`messageAvailable`, an http(s) permalink or null, the ref kept after expiry), pending proposals (hidden once the commitment is closed), follow-up summaries, owner and counterparty names, and server-computed `actions`. `all`, `open`, `in_progress`, `blocked`, `overdue` and `closed` cover accepted commitments; `mine` and `theirs` cover accepted, not closed ones; `due_soon` is accepted, not closed, due within `commitments.reminder.dueSoonHours` and not yet past; `overdue` is `due_at < now` and not closed; `review` is `pending_review` plus `rejected` (the review history; rejected rows appear nowhere else). Order: overdue first, then soonest due, then newest.

### Stall detection and reminders

`StallService` (`modules/commitments/stall.ts`) backs two scheduled jobs that never call Claude.

- `commitments.check_stalled` (hourly). Accepted, open or in-progress `theirs` commitments; `blocked` is never stalled. X = max(newest source message `sent_at` (the commitment's `created_at` if none survives), `last_followup_at`). Stalled when the owner (the other person) has no message in any source conversation after X (a message with null or expired text still counts) and either X is at least `commitments.stall.waitHours` old, or the commitment is past due and no follow-up was sent within the last `waitHours`. It sets `stalled_at` (and `next_action` = `Follow up` when empty), emits `commitment.stalled` and enqueues `commitments.draft_followup` (key `commitments.draft:<id>:<stalled_at>`, group `commitments.intelligence`, priority 70, input `{commitmentId, stalledAt}`). A commitment with `stalled_at` set is skipped until the owner replies after it, or `last_followup_at` is later than `stalled_at` (the `followup.sent` consumer sets it when a follow-up of the commitment is sent); either clears `stalled_at` and the wait restarts.
- Overdue `mine` commitments (accepted, not closed, `due_at` past) emit `commitment.overdue` once. The marker is a `commitment_updates` row `actor: system`, `field: overdue_notified`, `to_value` = the due date.
- `commitments.reminders` (every 15 minutes). For accepted, open `mine` commitments with a due date within `commitments.reminder.dueSoonHours` (`due_soon`, severity `warning`) or past (`overdue`, severity `high`): one notification per (commitment, state), `kind: commitment.reminder`, `ref: commitment:<id>:<state>`, title `Due soon: commitment to <name>` or `Overdue: commitment to <name>` (`... your commitment` without a counterparty name). The description is never in the title or body. Notifications reach the desktop notifier through `NotificationService`. Reminders are to the user only; nothing is sent to anyone else.

### Follow-up drafts

`commitments.draft_followup` is the only Claude job here (intelligence profile, `batch`, model `commitments.models.draft`, `ToolSearch` only, 3 turns, 420 s). The user can also request one with `POST /api/commitments/:id/draft-followup` (accepted, open, `theirs`; `{queued: false}` when a draft job for it is already live).

- Skipped without a run when the commitment is not `accepted`, is closed, is not stalled (or the job's `stalledAt` is stale), or already has a `draft` or `awaiting_approval` follow-up. A skip for `no_identity` clears `stalled_at` (it happens before any run), so the commitment can stall again once the identity is set; an exhausted job keeps `stalled_at`, so a failure never loops.
- Prompt parts and provenance: a system part; the commitment description (a `user_approved` part only when the user accepted the commitment through review, recorded as a `commitment_updates` row `actor: user`, `field: review_status`, `to_value: accepted`; an auto-accepted detection, and any accepted row without that record, is an `untrusted` part); a `user_approved` guidelines part when the owner has approved People Memory response guidelines (drafting only, never in a send run; no Slack name in trusted text); then up to 10 untrusted context messages (the newest non-expired text from the source conversations, source threads first, shown oldest first). Expired source text is never used as context.
- Output `followupDraftOutputSchema`; the draft is stored through `renderExcerpt(draft, 4000)` in a `followups` row (`origin: stalled`, `status: draft`, `conversation_id` = the internal conversation id of the newest available source, recipient = the owner, `confidence`) and `followup.draft_created` is emitted. Flags follow the people rule (never the user's own message).
- Thread placement (`followupThreadTs`, shared with spec clarity): in an `im` conversation the draft posts top-level (`thread_ts` null) unless the newest available source message was itself a thread reply, then that thread; in an mpim or channel it threads under the source (`thread_ts`, else its `ts`). `noThread` means strictly that no source message text is available (expired or deleted): `thread_ts` is null, `followup_history` gets `noThread` / `no_thread`, and the user sees "posts as a new message" before sending.

### Spec clarity

A task or bug request that lacks key information gets a clarity check, and a numbered list of clarifying questions becomes a follow-up draft to the requester.

- The `commitments.queue` consumer enqueues `commitments.check_spec_clarity` (key `commitments.spec:<messageId>`, priority 45, group `commitments.intelligence`, timeout 300 s) for a recent, unexpired message from someone other than the user, addressed to the user (an `im`, or a mention of the user), matching `\b(can you|could you|please|need you to|bug|broken|doesn't work|isn't working|fix|implement|add|build)\b` (case-insensitive) with at least 8 words. The request is the message plus up to 5 earlier messages of its thread (or the 5 previous conversation messages), all untrusted.
- Bounds (cost control): the message must be within `commitments.spec.maxAgeHours` (default 24), not from a bot, have no open spec follow-up (`draft`, `awaiting_approval`, `sending`, `needs_attention`) in its thread (its conversation when unthreaded), and the sender must be under `commitments.spec.maxPerSenderPerDay` (default 5, counted per UTC day from spec jobs enqueued). The handler skips without a Claude run when the user posted in the conversation or thread after the request. At most one spec follow-up exists per origin message.
- When the output is not `clear` and has questions, a `followups` row (`origin: spec_clarity`, `status: draft`, no confidence) holds the questions under the lead "A few questions so I can pick this up:", placed like any follow-up, plus a `clarity_missing` history row whose detail is the comma-joined `missing` enums.

### Routes

All on localhost; errors carry ids and enums only, never text.

| Route | Result |
|---|---|
| `GET /api/commitments?filter&limit` | `CommitmentView[]` (see `listViews`) |
| `POST /api/commitments/:id/review` | `{decision: accept\|reject, edits?}`; 404 unknown, 409 not allowed |
| `POST /api/commitments/:id/status` | `{status, reason?}`; 404 unknown, 409 illegal transition |
| `POST /api/commitments/proposals/:id` | `{accept}`; 404 unknown, 409 not a pending proposal |
| `POST /api/commitments/:id/draft-followup` | 202 `{queued}`; 409 when not eligible |
| `GET /api/followups?status` | `FollowupViewDto[]` with recipient, conversation label, `threadReply`, `noThread`, draft text, outgoing status, `actions` (`send`, `discard`) and `resolveActions`; urgent-reply follow-ups are excluded (they appear in the urgent inbox) |
| `POST /api/followups/:id/send` | `{text}` (1..4000 after trimming trailing whitespace); creates the outgoing message and its `slack.send` approval, never calls the sink; 404, 400, 409 (not sendable, or a send is already pending) |
| `POST /api/followups/:id/discard` | 409 when sent or a send is live |
| `POST /api/outgoing/:id/resolve` | `{decision: mark_sent\|resend\|discard}` for a send in `needs_attention` (or an exhausted `sent_unverified`: no resend); 404, 409 |

The `send` action is listed only when the follow-up is a draft with no live send and its conversation can be resolved; `discard` does not need the conversation. `followups.conversation_id` is the internal `slack_conversations.id` for every origin (urgent replies too; migration 0012 rewrote older rows); reads still accept an external id.

### Follow-up and outgoing statuses

`followups.status`: `draft`, `awaiting_approval`, `sending`, `sent`, `needs_attention`, `discarded`, `failed`. `outgoing_messages.status`: `pending`, `sending`, `sent_unverified`, `sent`, `failed`, `needs_attention`. The follow-up mirrors its outgoing message (it moves only while it still points at that message):

| Outgoing event | Outgoing status | Follow-up status |
|---|---|---|
| send requested | `pending` | `awaiting_approval` |
| executor claims it | `sending` | `sending` |
| send tool ran with the approved arguments | `sent_unverified` (a verify job is queued) | `sent`, `followup.sent` emitted once |
| verification finds it | `sent` | `sent` (once) |
| definitive Slack rejection or no send call | `failed` (`tool_error`, `no_send`) | `draft` |
| nothing started (quota, auth, abort before spawn) | `failed` (`not_started`) | `draft` |
| revoke, reject or expiry before the claim | `failed` (`revoked`, `rejected`, `expired`) | `draft` |
| uncertain outcome (timeout, crash, unknown tool error, lost executor) | `needs_attention` (`uncertain_outcome`; verified) | `needs_attention` |
| arguments changed | `needs_attention` (`argument_mismatch`; detected after the send tool ran, not prevented; never verified, never re-sent automatically) | `needs_attention` |
| user: mark sent | `sent` | `sent` |
| user: discard | `failed` (`discarded`) | `discarded` |
| user: resend | old `failed` (`superseded`), new `pending` with a new approval | `awaiting_approval` |

Verification exhausted (`outgoing.verify.maxAttempts`) sets failure `unverified` and notifies; the row then only accepts `mark_sent` and `discard`. A second approval of the same follow-up is blocked while a send is live (a partial unique index backs it). See `integration-contracts.md` for the sink and `slack.md` for the send run.

### Smoke

`bun scripts/dev/commitments-smoke.ts [--pages N] [--self Uxxxx]` runs one real collection and exactly one `commitments.extract` batch on a temporary database, with a sink that throws if called, and prints counts only (messages, eligible, candidates, dropped, commitments created, completion proposals). See `CLAUDE.md`.

## Events

Emitted: `commitment.detected`, `commitment.reviewed`, `commitment.status_changed`, `commitment.stalled`, `commitment.overdue`, `followup.draft_created`, `followup.status_changed`, `followup.sent`, `outgoing.status_changed`.

Consumed: `message.received` (extraction and spec-clarity queueing), `followup.sent` (resets the post-follow-up wait; `people.post_send`, see `people-memory.md`), `approval.revoked` / `approval.rejected` / `approval.expired` (cancels a send that has not started). Jira and engineering events are not consumed yet.

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
- Uncertain send → verify via `findSent` (search) before anything else; never an automatic resend, never a duplicate follow-up.
- Source message expired → `commitment_sources.source_external_ref` remains; the commitment is never deleted by retention.

## Configuration

| Key | Default |
|---|---|
| `commitments.extract.debounceMinutes` | `30` |
| `commitments.stall.waitHours` | `24` (business hours handling TBD) |
| `commitments.spec.maxAgeHours` | `24` (int 1..168): spec-clarity only fires for messages this fresh |
| `commitments.spec.maxPerSenderPerDay` | `5`: spec jobs enqueued per sender per UTC day |
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
