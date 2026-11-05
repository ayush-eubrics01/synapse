# Commitments and Follow-ups

Covers the `commitments` domain module (`apps/api/src/modules/commitments`).

## Purpose

Track promises made by the user and by colleagues, and keep stalled conversations from being forgotten. Typical cases: "I'll check and let you know" (requirement 5f), a bug the user promised to fix, a document someone will share, a Jira issue awaiting action. Also detect unclear task specifications and draft follow-up questions to the requester (requirement 5e).

## Responsibilities / Non-responsibilities

Responsibilities:

- Extract commitments from messages (and, from Phase 8, Jira issues) (AI, batched), with owner, counterparty, due date and source.
- Commitment approval, status lifecycle and history.
- Detect stalled items: someone said they'd come back, and nothing followed.
- Detect unclear specs in task requests and draft clarifying questions.
- Reminders to the user (automatic). Follow-ups to others need approval, except ADR-033 auto-replies (Phase 6b: away mode on, priority person, `stalled_reminder` or `followup_question`).
- Escalation recommendations (never executed automatically; not built yet).
- Commitments Dashboard views.

Non-responsibilities:

- Sending messages directly. Sends go through approvals (or, from Phase 6b, the ADR-033 auto-reply policy) → `MessageSink`.
- Assuming completion because someone said they'd do something.

## Owned data (tables)

`commitments`, `commitment_sources` (many per commitment), `commitment_updates`, `followups`, `followup_history`.

Commitment fields (as built): ID, description, owner and counterparty (Slack ids), `direction` (`mine` when the owner is the user, else `theirs`), status, `review_status`, due (if known), next action, completion evidence, `stalled_at`, `last_followup_at`, closed date, `dedup_key`, created and updated. Sources live in `commitment_sources` (conversation, message, and the external ref kept after expiry). Jira issue sources are Phase 8; a priority field is not built.

## Ports used / provided

- `ClaudeOrchestrator` (intelligence profile) for extraction, spec-clarity checks and follow-up drafting. Stall detection and reminders are rules only, with no Claude run.
- Reads stored Slack messages, conversations and users, and the `people` guidelines (drafting only). `jira-tracking` is read from Phase 8.
- Provides `CommitmentLifecycle` (review, `setStatus`, `confirmProposal`, `listViews`) and `FollowupService` (list, send for approval, discard, manual draft) for the routes; sends go through `OutgoingService` (`modules/outgoing`).

## Jobs

| Job type | Trigger | Profile / model | Idempotency key | Retry |
|---|---|---|---|---|
| `commitments.extract` | batch of new messages (debounced, default 30 min; hourly sweep) | intelligence / haiku | `commitments.extract:<debounce bucket>` | 3 |
| `commitments.check_stalled` | scheduled (hourly, coalesced) | none (rules only) | scheduler slot | 3 |
| `commitments.check_spec_clarity` | new task-like Slack message (Jira issues: Phase 8) | intelligence / haiku | `commitments.spec:<messageId>` | 3 |
| `commitments.draft_followup` | stalled item or user request | intelligence / haiku | `commitments.draft:<commitmentId>:<stalled_at>`; manual `commitments.draft.manual:<commitmentId>:<id>` | 3 |
| `commitments.reminders` | scheduled (15 min, coalesced) | none | scheduler slot | 3 |
| `commitments.extract_sweep` | scheduled (hourly, coalesced) | none | `commitments.extract:sweep:<hour>` | 3 |
| `outgoing.verify` | after an unverified or uncertain send | none (searches Slack) | `outgoing.verify:<outgoingId>:<attempt>` | 3 |

`dedup_key` = sha256(owner|counterparty|normalized description), with a source suffix when the base-key row is terminal (see Dedup below). Repeated extraction from the same source updates rather than duplicates.

## Status lifecycle

`open` → `in_progress` → `completed`, with `blocked` and `cancelled` reachable as `setStatus` allows (see Review and lifecycle). A commitment closes only when the user marks it complete or cancelled, or confirms an AI completion proposal backed by a cited message. Jira status evidence is Phase 8. Every change writes `commitment_updates` with actor and reason.

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

- `commitments.check_stalled` (hourly). Accepted, open or in-progress `theirs` commitments; `blocked` is never stalled. R16: the owner's latest reply is the owner's newest message in the source scope sent after the oldest source message (so an owner-authored source "I'll do X" is not a reply; a message with null or expired text still counts). The scope is the source thread (root included) for a source that is a thread reply, else the source conversation. The reference time is max(newest source message `sent_at` (the commitment's `created_at` if none survives), `last_followup_at`, the owner's latest reply). Stalled when the reference is at least `commitments.stall.waitHours` old, or when the commitment is past due and `waitHours` have passed since the last contact, max(the owner's latest reply, `last_followup_at`) (at once when there was none). One old reply therefore never stops detection: a request acknowledged once and then left past due stalls. It sets `stalled_at` (and `next_action` = `Follow up` when empty), emits `commitment.stalled` and enqueues `commitments.draft_followup` (key `commitments.draft:<id>:<stalled_at>`, group `commitments.intelligence`, priority 70, input `{commitmentId, stalledAt}`). A commitment with `stalled_at` set is skipped until the owner replies after it, or `last_followup_at` is later than `stalled_at` (the `followup.sent` consumer sets it when a follow-up of the commitment is sent); either clears `stalled_at` and the wait restarts.
- Overdue `mine` commitments (accepted, not closed, `due_at` past) emit `commitment.overdue` once. The marker is a `commitment_updates` row `actor: system`, `field: overdue_notified`, `to_value` = the due date.
- `commitments.reminders` (every 15 minutes). For accepted, open `mine` commitments with a due date within `commitments.reminder.dueSoonHours` (`due_soon`, severity `warning`) or past (`overdue`, severity `high`): one notification per (commitment, state), `kind: commitment.reminder`, `ref: commitment:<id>:<state>`, title `Due soon: commitment to <name>` or `Overdue: commitment to <name>` (`... your commitment` without a counterparty name). The description is never in the title or body. Notifications reach the desktop notifier through `NotificationService`. Reminders are to the user only; nothing is sent to anyone else.

### Follow-up drafts

`commitments.draft_followup` is the follow-up drafting job (intelligence profile, `batch`, model `commitments.models.draft`, `ToolSearch` only, 3 turns, 420 s). The user can also request one with `POST /api/commitments/:id/draft-followup` (accepted, open, `theirs`; 409 while a follow-up of the commitment is live, and the view then does not offer `draft_followup`; `{queued: false}` when a draft job for it is already queued).

- Skipped without a run when the commitment is not `accepted`, is closed, is not stalled (or the job's `stalledAt` is stale), or already has a live follow-up (`draft`, `awaiting_approval`, `sending` or `needs_attention`). R17: also skipped (`owner_not_in_conversation`: no draft, no history) when the chosen source conversation is an `im` or `mpim` in which the owner has no stored message, because the follow-up would reach that conversation's members and not the owner (for example "<@Y> will handle it" written in a DM with X). A skip for `no_identity` clears `stalled_at` (it happens before any run), so the commitment can stall again once the identity is set; an exhausted job keeps `stalled_at`, so a failure never loops.
- Prompt parts and provenance: a system part; the commitment description (a `user_approved` part only when the user accepted the commitment through review, recorded as a `commitment_updates` row `actor: user`, `field: review_status`, `to_value: accepted`; an auto-accepted detection, and any accepted row without that record, is an `untrusted` part); a `user_approved` guidelines part when the owner has approved People Memory response guidelines (drafting only, never in a send run; no Slack name in trusted text); then up to 10 untrusted context messages (the newest non-expired text from the source conversations, source threads first, shown oldest first). Expired source text is never used as context.
- Output `followupDraftOutputSchema`; the draft is stored through `renderExcerpt(draft, 4000)` in a `followups` row (`origin: stalled`, `status: draft`, `conversation_id` = the internal conversation id of the newest available source, recipient = the owner, `confidence`) and `followup.draft_created` is emitted. Flags follow the people rule (never the user's own message).
- Thread placement (`followupThreadTs`, shared with spec clarity): in an `im` conversation the draft posts top-level (`thread_ts` null) unless the newest available source message was itself a thread reply, then that thread; in an mpim or channel it threads under the source (`thread_ts`, else its `ts`). `noThread` means strictly that no source message text is available (expired or deleted): `thread_ts` is null, `followup_history` gets `noThread` / `no_thread`, and the user sees "posts as a new message" before sending.

### Spec clarity

A task or bug request that lacks key information gets a clarity check, and a numbered list of clarifying questions becomes a follow-up draft to the requester.

- The `commitments.queue` consumer enqueues `commitments.check_spec_clarity` (key `commitments.spec:<messageId>`, priority 45, group `commitments.intelligence`, timeout 420 s) for a recent, unexpired message from someone other than the user, addressed to the user (an `im`, or a mention of the user), matching `\b(can you|could you|please|need you to|bug|broken|doesn't work|isn't working|fix|implement|add|build)\b` (case-insensitive) with at least 8 words. The request is the message plus up to 5 earlier messages of its thread (or the 5 previous conversation messages), all untrusted.
- Bounds (cost control): the message must be within `commitments.spec.maxAgeHours` (default 24), not from a bot, have no open spec follow-up (`draft`, `awaiting_approval`, `sending`, `needs_attention`) in its thread (its conversation when unthreaded), the sender must be under `commitments.spec.maxPerSenderPerDay` (default 5), and all senders together under `commitments.spec.maxPerDay` (default 30), both counted per UTC day from spec jobs enqueued. The handler skips without a Claude run when the user posted in the conversation or thread after the request. At most one spec follow-up exists per origin message.
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
| `GET /api/followups?status` | `FollowupViewDto[]` with recipient, conversation label (R17: `DM with <name>`, `group DM with <a>, <b> +n` or `#channel`, naming the conversation's other participants; the approval preview uses the same label), `threadReply`, `noThread`, draft text, outgoing status, `actions` (`send`, `discard`) and `resolveActions`; urgent-reply follow-ups are excluded (they appear in the urgent inbox) |
| `POST /api/followups/:id/send` | `{text}` (1..4000 after trimming trailing whitespace); creates the outgoing message and its `slack.send` approval, never calls the sink; 404, 400, 409 (not sendable, or a send is already pending) |
| `POST /api/followups/:id/discard` | 409 when sent or a send is live |
| `POST /api/outgoing/:id/resolve` | `{decision: mark_sent\|resend\|discard}` for a send in `needs_attention` (or an exhausted `sent_unverified`: no resend); 404, 409 |

The `send` action is listed only when the follow-up is a draft with no live send and its conversation can be resolved; `discard` does not need the conversation. `followups.conversation_id` is the internal `slack_conversations.id` for every origin (urgent replies too; migration 0012 rewrote older rows); reads still accept an external id.

### Follow-up and outgoing statuses

`followups.status`: `draft`, `awaiting_approval`, `sending`, `sent`, `needs_attention`, `discarded` (the enum also has `failed`, which is never written: a failed send returns the follow-up to `draft`; it is neither active nor sendable). `outgoing_messages.status`: `pending`, `sending`, `sent_unverified`, `sent`, `failed`, `needs_attention`. The follow-up mirrors its outgoing message (it moves only while it still points at that message):

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

Extraction (Phase 6, Slack only; Jira issues are Phase 8):

```text
new Slack messages involving the user → commitments.extract (batched, debounced)
 → Zod-validated candidates citing batch message ids → evidence and owner checks
 → dedup → commitment.detected (pending_review)
 → user accepts / edits / rejects → commitment.reviewed
```

Stalled item (requirement 5f), as built:

```text
accepted commitment owed by another person, quiet for waitHours (or past due, R16)
 → mark stalled (next_action = Follow up) → commitment.stalled
 → commitments.draft_followup (People Memory guidelines, drafting only)
 → followup.draft_created
 → user edits and sends → slack.send approval → approved: send via MessageSink
 → verify (outgoing.verify) → followup.sent → last_followup_at, wait restarts
```

Target design, not built yet:

- **Phase 6b (ADR-033):** away mode on, priority person and policy checks pass → auto-send with the tag "Sent using @claude", verify, `followup.sent`, `autoreply.sent`, and the return digest.
- **Phase 10:** an unclear spec holds the related engineering task in `proposed` until answers arrive. Phase 6 drafts the clarifying questions only (see Spec clarity).
- **Escalation recommendations** in the UI are not built; nothing is ever escalated automatically.

Reminders to the user (due soon, overdue) are automatic notifications.

## Permissions and approvals

Extract and draft: allowed. A detected commitment waits for user review (`review_status`, unless `commitments.requireReviewForDetected` is false). Send any follow-up or reply to another person: a `slack.send` approval of the exact text, always. ADR-033 away-mode auto-replies to priority people (`stalled_reminder`, `followup_question`) are Phase 6b. Escalation: recommendation only (not built).

## Failure handling

- Duplicate extraction → absorbed by `dedup_key`.
- Invalid AI output → retry. An extract batch that fails terminally is marked extracted and audited as `commitments.batch_skipped` (R10); an exhausted draft job keeps `stalled_at`, so a failure never loops.
- Uncertain send → verify via `findSent` (search) before anything else; never an automatic resend, never a duplicate follow-up. An auth pause, quota stop or Slack rate limit during verification defers the verify job without spending an attempt (R18).
- Source message expired → `commitment_sources.source_external_ref` remains; the commitment is never deleted by retention.

## Configuration

| Key | Default |
|---|---|
| `commitments.extract.debounceMinutes` | `30` |
| `commitments.extract.batchMax` | `40` (max 40, the output cap) |
| `commitments.stall.waitHours` | `24` (business hours handling TBD) |
| `commitments.spec.maxAgeHours` | `24` (int 1..168): spec-clarity only fires for messages this fresh |
| `commitments.spec.maxPerSenderPerDay` | `5`: spec jobs enqueued per sender per UTC day |
| `commitments.spec.maxPerDay` | `30`: spec jobs enqueued for all senders per UTC day |
| `commitments.reminder.dueSoonHours` | `24` |
| `commitments.requireReviewForDetected` | `true` |
| `commitments.models.extract` | `"haiku"` |
| `commitments.models.draft` | `"haiku"` (follow-up drafts; spec clarity uses `commitments.models.extract`) |
| `outgoing.verify.delaySeconds` | `120` |
| `outgoing.verify.maxAttempts` | `5` |

## Dashboard views

All, assigned to me, owed by others, open, in progress, blocked, overdue, due soon, closed. Full follow-up history per commitment.

## Tests

Built (Phase 6):

- Extraction: evidence, owner and DM-partner checks, completion never assumed from a promise, dedup and terminal-row reuse, poison-batch skip, sweep (`test/workers/commitments-extract.test.ts`, `test/integration/commitments-provider-e2e.test.ts`).
- Review, lifecycle and views (`test/modules/commitments-lifecycle.test.ts`).
- Stall detection (R16 reference time and thread scope), reminders, follow-up drafts, provenance, R11 thread placement, R17 owner-in-conversation skip, live follow-up skip (`test/workers/commitments-stall.test.ts`).
- Spec clarity bounds, including the per-sender and global daily caps (`test/workers/commitments-clarity.test.ts`).
- Sending: approval first, revoke or expiry before send sends nothing, uncertain outcome verified and never resent automatically, argument mismatch flagged, verify deferral (R18), no duplicate send when a send outlives its job (`test/modules/outgoing.test.ts`, `test/integrations/slack-sender.test.ts`, `test/integration/slack-send-e2e.test.ts`).
- Routes, R17 participant labels, manual draft 409 (`test/routes-phase6.test.ts`).
- Expired source message → commitment kept with its external ref.

Target (later phases):

- Phase 6b: away mode on, priority person stalled → reminder auto-sent once with the tag, daily cap respected; away mode off or a non-priority person → draft only, nothing sent.
- Phase 10: an unclear bug report holds its engineering task.

## Open questions

- OQ-1 resolved by ADR-033: stalled reminders and follow-up questions to priority people are auto-sent in away mode.
- **OQ-2 (deferred):** approving follow-ups to non-priority people while away (phone/remote access).
- Stall wait time and business-hours rules are proposals.

See `docs/product/open-questions.md`.
