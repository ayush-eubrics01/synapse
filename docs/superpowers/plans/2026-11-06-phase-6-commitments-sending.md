# Phase 6: Commitments, Follow-ups and Approved Sending Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Synapse extracts commitments made by and to the user from Slack. The user reviews them, and they are tracked through a lifecycle. Stalled items and unclear requests get drafted follow-ups. Any message Synapse sends to Slack (follow-ups and urgent-reply drafts alike) goes out only after the user approves the exact text, through one narrow, verified send path.

**Architecture:**
- **Commitments module.** Extraction is an intelligence run over batches of new messages: untrusted parts, Zod output, every candidate citing a batch message id. Candidates are deduplicated and wait for the user's review. A deterministic hourly stall check and a 15-minute reminder job (no AI) drive follow-ups and user reminders.
- **Drafting.** Follow-up drafts and spec-clarity questions are intelligence runs with no send tool.
- **Sending.** One `MessageSink` adapter (`integrations/slack/sender.ts`) performs a send as its own run on the collector profile. That run is allowed exactly `slack_send_message` plus ToolSearch. Its prompt carries only the exact approved arguments.
  - **Verification.** Code checks the tool_use input against the approved command field by field, and checks the result for success. Delivery is then verified by searching the conversation for the sent text.
  - **Approval.** Sends run only from the `slack.send` approval executor, through the Phase 5 execution path.
  - **Uncertain outcomes.** These are verified and never re-sent automatically.

**Tech Stack:** Bun 1.4.4, TypeScript strict, Hono, bun:sqlite + Drizzle (generated migrations), Zod 4, Next.js 16, `bun test`.

**Spec:**
- `docs/modules/commitments.md`
- `docs/architecture/integration-contracts.md` §MessageSink
- `docs/modules/claude-orchestrator.md` (send runs)
- ADR-013, ADR-032, ADR-026
- `docs/superpowers/plans/2026-11-06-phase-5-followups.md` (Phase 6 entry gate H1–H5)

**Out of scope, decided:**
- **Away-mode auto-replies (ADR-033) and the return digest.** These move to a follow-on phase (6b). It builds on this phase's send path, and it needs the H1 decision to be settled first.
- **Jira-sourced commitments.** Phase 7.
- **Holding engineering tasks pending clarification.** Phase 9; this phase records the clarity result only.
- **The `code_answer` kind.** Phases 8–9.
- **Escalation execution.** Never executed; this phase only shows recommendations.

## Global Constraints

- **CLAUDE.md hard rules:**
  - Only `core/orchestrator` runs Claude.
  - Untrusted text never reaches a run that can act.
  - Every Slack send goes through the approval engine (`slack.send`, already `approval_required`).
  - No Slack content, draft text or approved text in logs, audit rows, events, notification titles, `lastError` or executor error messages. Text lives only in the module tables and route responses.
- **Send run shape (ADR-032, validator R21):**
  - Profile `collector`, `priorityClass: "send"`, `allowedTools: ["mcp__claude_ai_Slack__slack_send_message", "ToolSearch"]`, `maxTurns: 3`, model haiku.
  - Parts: one `system` part (the instruction to call the tool once with exactly the given JSON arguments) and one `user_approved` part (the JSON of `{ channel_id, thread_ts?, message }`).
  - No untrusted parts.
  - The approved text reaches the send run only after the user approved that exact text.
- **H1 (ruled).** Approved People Memory guidelines may appear in drafting runs, which are intelligence runs with no send tool. They never appear in a send run. The send run's `user_approved` part is only the exact message the user approved.
- **Outgoing text limits:** at most 4,000 characters (the Slack per-element limit is 5,000). Code never alters approved text except to trim trailing whitespace.
- **Migrations:** every schema change gets a new generated migration. Update `database-design.md`.
- **No new runtime dependency.** Tests never run real `claude`. Every new Claude path has a fake-binary e2e test through the real provider and validator (the `apps/api/test/integration/*-provider-e2e.test.ts` pattern).
- **No real sends during development.** No implementer or reviewer ever sends a real Slack message. The controller asks the user before any real test send.
- **Job priorities** (higher first):

  | Job | Priority |
  |---|---|
  | `approval.execute` | 180 (existing) |
  | `outgoing.verify` | 170 |
  | `commitments.extract` | 50 |
  | `commitments.draft_followup` | 70 |
  | `commitments.check_spec_clarity` | 45 |
  | `commitments.check_stalled` | 0 Claude, scheduled |
  | `commitments.reminders` | no Claude, scheduled |

- **Concurrency group:** all commitment Claude jobs use `concurrencyGroup: "commitments.intelligence"`.
- **Settings** (exact keys and defaults):

  | Key | Default |
  |---|---|
  | `commitments.extract.debounceMinutes` | `30` |
  | `commitments.extract.batchMax` | `40` (max 60) |
  | `commitments.stall.waitHours` | `24` |
  | `commitments.reminder.dueSoonHours` | `24` |
  | `commitments.requireReviewForDetected` | `true` |
  | `commitments.models.extract` | `"haiku"` |
  | `commitments.models.draft` | `"haiku"` |
  | `outgoing.verify.delaySeconds` | `120` |
  | `outgoing.verify.maxAttempts` | `5` |

## Review Focus

1. **Duplicate sends.**
   - A timeout, crash or lost lease after the send tool ran must never lead to a second send.
   - An outcome that is uncertain or unverified goes to `needs_attention` with a "Resend?" decision for the user. It is never retried automatically.
   - A second approval of the same draft is blocked while one is live.
   - Tests in Tasks 3 and 4.
2. **The send run changes the arguments.** If the model calls the tool with a different channel, thread or text (prompt injection through the approved text, or model error), code detects it from the tool_use input. The send is marked `failed` with a `high` runtime flag and a notification, and it is never reported as sent. Test in Task 2.
3. **Hallucinated commitments.**
   - Every extracted commitment cites batch message ids.
   - Owner and counterparty must be authors of, or mentioned in, the cited messages.
   - "I'll do X" is never recorded as completion.
   - Extraction from the same source twice updates rather than duplicates.
   - Test in Task 5.
4. **Revoke or expiry before execution.** Nothing is sent, and the draft returns to editable. Test in Task 4.
5. **Expired source messages.** Commitments keep `source_external_ref`, and nothing is deleted by retention. Drafting skips expired context, and a follow-up whose target message expired still sends to the conversation (no thread) only if the user approves that. Test in Task 7.

---

### Task 1: Schema, contracts, settings and H3

**Files:**
- Modify:
  - `packages/database/src/schema/platform.ts`
  - `apps/api/src/core/config/settings.ts`
  - `packages/contracts/src/{events.ts, errors.ts, index.ts}`
  - `apps/web/lib/live-events.ts`
  - `docs/architecture/database-design.md`
  - `apps/api/src/core/approvals/execution.ts`: H3, use the new kind for bookkeeping parking.
- Create: `packages/contracts/src/commitments.ts`, `packages/contracts/src/outgoing.ts`, migration `0009_commitments_outgoing`
- Test: `packages/database/test/schema-phase6.test.ts`, `packages/contracts/test/commitments.test.ts`, `apps/api/test/core/approval-execution.test.ts`

**Interfaces:**
- **Tables:**
  - `commitments`:
    - Columns: `id`, `description` (≤500), `owner_slack_user_id`, `counterparty_slack_user_id` nullable, `direction` (`mine`/`theirs`), `status` (`open`/`in_progress`/`blocked`/`completed`/`cancelled`), `review_status` (`pending_review`/`accepted`/`rejected`), `due_at` nullable, `next_action` nullable, `completion_evidence` nullable, `stalled_at` nullable, `last_followup_at` nullable, `closed_at` nullable, `created_at`, `updated_at`.
    - `dedup_key` unique.
    - Index (`review_status`,`status`).
    - `direction` is `mine` when the owner is self, else `theirs`.
  - `commitment_sources`: `id`, `commitment_id` FK, `message_id` FK nullable (ON DELETE SET NULL), `source_external_ref` not null, `conversation_id`, `claude_run_id` nullable, `created_at`. Unique(`commitment_id`,`source_external_ref`).
  - `commitment_updates`: `id`, `commitment_id` FK, `actor` (`user`/`system`/`ai`), `field`, `from_value` nullable, `to_value` nullable, `reason` nullable, `created_at`.
  - `followups`:
    - Columns: `id`, `commitment_id` FK nullable, `origin` (`stalled`/`spec_clarity`/`urgent_reply`/`manual`), `origin_message_id` FK nullable, `conversation_id`, `thread_ts` nullable, `recipient_slack_user_id` nullable, `draft_text` nullable, `confidence` nullable, `status` (`draft`/`awaiting_approval`/`sending`/`sent`/`needs_attention`/`discarded`/`failed`), `approval_id` nullable, `outgoing_id` nullable, `claude_run_id` nullable, `created_at`, `updated_at`.
    - Index (`status`).
  - `followup_history`: `id`, `followup_id` FK, `event`, `detail` (content-free), `created_at`.
  - `outgoing_messages`:
    - Columns: `id`, `approval_id` unique, `followup_id` FK nullable, `conversation_external_id`, `thread_ts` nullable, `text`, `status` (`pending`/`sending`/`sent_unverified`/`sent`/`failed`/`needs_attention`), `claude_run_id` nullable, `sent_at` nullable, `verified_at` nullable, `verify_attempts` int default 0, `failure` (content-free) nullable, `created_at`, `updated_at`.
    - Index (`status`).
- **`packages/contracts/src/commitments.ts`:**

  ```ts
  commitmentCandidateSchema = z.object({
    description: z.string().min(1).max(500),
    owner: z.string().regex(/^[UW][A-Z0-9]+$/),
    counterparty: z.string().regex(/^[UW][A-Z0-9]+$/).nullable(),
    dueAt: z.string().datetime({ offset: true }).nullable(),
    evidence: z.array(z.string()).min(1).max(5),
    kind: z.enum(["promise", "request_accepted", "completion"]),
    confidence: z.enum(["low", "medium", "high"]),
  }).strict()

  commitmentExtractionOutputSchema = z.object({
    candidates: z.array(commitmentCandidateSchema).max(40),
    suspectedInjection: strictInjectionSchema,
  }).strict()
  ```

  Export the strict injection schema from contracts (people.ts already defines it locally; move it to a shared export).

  ```ts
  followupDraftOutputSchema = z.object({
    draft: z.string().min(1).max(4000),
    confidence: z.number().min(0).max(1),
    suspectedInjection,
  }).strict()

  specClarityOutputSchema = z.object({
    clear: z.boolean(),
    missing: z.array(z.enum(["expected_behaviour", "steps", "scope", "environment", "acceptance_criteria"])).max(5),
    questions: z.array(z.string().min(1).max(300)).max(5),
    suspectedInjection,
  }).strict()
  ```

  DTO types: `CommitmentView`, `FollowupView`.
- **`packages/contracts/src/outgoing.ts`:** `SendMessageCommand { outgoingId; approvalId; conversationExternalId; threadTs?; text }`; `SendResult { status: "sent_unverified"|"failed"|"uncertain"; failure?: string }`; `MessageSink { send(cmd, signal): Promise<SendResult>; findSent(cmd, sinceTs): Promise<boolean | null> }`, where null means "could not check".
- **Events:**
  - `commitment.detected { commitmentId }`
  - `commitment.reviewed { commitmentId, reviewStatus }`
  - `commitment.status_changed { commitmentId, status }`
  - `commitment.stalled { commitmentId }`
  - `commitment.overdue { commitmentId }`
  - `followup.draft_created { followupId }`
  - `followup.status_changed { followupId, status }`
  - `followup.sent { followupId, outgoingId }`
  - `outgoing.status_changed { outgoingId, status }`
- **H3:** add the ErrorKind `needs_attention` (decision `needs_attention`, content-free) and use it in place of `parse_failed` for approval bookkeeping parking.
- **Settings:** per the Global Constraints table.

- [ ] **Step 1: Failing tests.**
  - The unique constraints; the SET NULL on `commitment_sources.message_id` (insert, delete message, assert null and ref kept).
  - The strict schemas reject extra keys.
  - Draft max 4000.
  - Events parse.
  - Settings defaults.
  - H3: bookkeeping failure parks with kind `needs_attention`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Generate the migration.
- [ ] **Step 4: Run** `bun run check` and the web build → PASS.
- [ ] **Step 5: Commit** `feat(db,contracts): commitments, follow-ups and outgoing messages schema`.

### Task 2: Slack sender (MessageSink adapter)

**Files:**
- Create: `apps/api/src/integrations/slack/sender.ts`
- Test: `apps/api/test/integrations/slack-sender.test.ts`, `apps/api/test/integration/slack-send-e2e.test.ts`, fixtures `apps/api/test/fixtures/streams/send_*.jsonl`

**Interfaces:**
- `class SlackSender implements MessageSink`, constructed with `{ orchestrator, clock, searchSource }`.
- **`send(cmd, signal)`:**
  1. Builds the send request described in Global Constraints.
  2. Calls `orchestrator.run` (not `runStructured`).
  3. **Failure classification:**
     - Not exactly one `slack_send_message` tool_result → `failed` with failure `no_send` when the run succeeded with zero send results, else `uncertain`.
     - The tool_use input differs from the command (`channel_id` exact, `thread_ts` exact or both absent, `message` exact after trimming trailing whitespace) → `failed` with failure `argument_mismatch`. Set a returned flag `mismatch: true` so the caller raises a high runtime flag.
     - `isError` → `failed` with failure `tool_error`.
  4. Otherwise → `sent_unverified`.
  5. A thrown `JobError` with `details.uncertain` (timeout or crash after spawn) → `uncertain`. A thrown error before spawn (quota, auth, validation) → rethrown, because nothing was sent.
- **`findSent(cmd, sinceTs)`:**
  - Uses the existing Slack search path (`SlackConnectorSource`-style collector run with `slack_search_public_and_private` and the R44 query hint) to find a message in `cmd.conversationExternalId` from self, at or after `sinceTs`, whose text equals the command text after whitespace normalisation.
  - Returns true or false.
  - A search failure returns null.
  - It never sends.

- [ ] **Step 1: Failing tests** (fake orchestrator, plus e2e through the real provider and validator):
  - **Happy path:** the request has only the send tool plus ToolSearch, a `user_approved` part equal to the JSON args, and no untrusted parts.
  - **`argument_mismatch`:** each of these causes it: a different channel, a thread_ts dropped, the text altered.
  - **`tool_error`.**
  - **Zero sends** → `failed` `no_send`.
  - **Two sends** → `uncertain`.
  - **A timeout after spawn** → `uncertain`.
  - **A quota error before spawn** → rethrown.
  - **`findSent`:** true on an exact match, false on a different text or an earlier ts, null on a search failure.
  - **E2e:** the validator accepts the send request; the validator rejects the same request when an untrusted part is added.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun run check` → PASS.
- [ ] **Step 5: Commit** `feat(api): verified slack sender behind MessageSink`.

### Task 3: Outgoing messages and the `slack.send` executor

**Files:**
- Create: `apps/api/src/modules/outgoing/service.ts`, `apps/api/src/workers/outgoing.ts`
- Modify: `apps/api/src/container.ts`
- Test: `apps/api/test/modules/outgoing.test.ts`

**Interfaces:**
- **`OutgoingService.requestSend(tx, { followupId, conversationExternalId, threadTs, text, requestedByModule })`:**
  - Validates `text.trimEnd()` (1..4000 chars).
  - Inserts `outgoing_messages` with status `pending`.
  - Creates an approval with:

    | Field | Value |
    |---|---|
    | `action` | `"slack.send"` |
    | `targetIntegration` | `"slack"` |
    | `targetRef` | conversation external id |
    | `payload` | `{ outgoingId }` |
    | `riskLevel` | `"medium"` |
    | key | `outgoing:<outgoingId>` |
    | `expiresAt` | now + 7 days |

  - Returns `{ outgoingId, approvalId }`.
  - Refuses with a typed `SendAlreadyPending` if the followup already has an outgoing message in `pending`, `sending`, `sent_unverified` or `needs_attention`.
- **Executor** (`registerIntegrationExecutor(engine, "slack.send", "slack", …)`):
  1. Loads the outgoing message by `payload.outgoingId` (Zod-validated). It must be `pending` and its `approval_id` must match, else it skips.
  2. Sets `sending` in an immediate transaction. Then calls `sink.send`.
  3. On `sent_unverified`:
     - writes `sent_at`;
     - enqueues `outgoing.verify` (key `outgoing.verify:<id>:1`, `runAfter` = now + `outgoing.verify.delaySeconds`);
     - updates the followup to `sent`, emits `followup.sent` and `outgoing.status_changed`;
     - writes an audit row `slack.sent` (ids only).
  4. On `failed`:
     - sets the status with its content-free failure, and the followup back to `draft`;
     - an `argument_mismatch` failure also raises `recordRuntimeFlag(high)` against the origin message if one exists, plus a notification "Send blocked: arguments changed";
     - throws `ProfileApplyError`-style typed errors with fixed messages, so the approval is `failed`.
  5. On `uncertain`: sets `needs_attention` (failure `uncertain_outcome`), enqueues `outgoing.verify`, and returns without throwing.
  - The job is `externalWrite`, so crashes park.
- **`outgoing.verify` handler:**
  - Calls `sink.findSent`.
  - true → `sent` with `verified_at`. If the status was `needs_attention`, it also becomes `sent`, the followup becomes `sent` and `followup.sent` is emitted, if not already done.
  - false or null → `verify_attempts` + 1. While under `maxAttempts`, re-enqueue with key `:n+1` and the same delay. At max: a `sent_unverified` stays `sent_unverified` with failure `unverified` and a notification; a `needs_attention` stays `needs_attention`.
  - It never re-sends.
- **`OutgoingService.resolveNeedsAttention(outgoingId, decision: "mark_sent"|"resend"|"discard")`:**
  - User-only. `resend` creates a new outgoing message and approval with the same text; the old one becomes `failed` with failure `superseded`.
  - Writes audit rows.
- **Revoked or expired approvals:** consumers `outgoing.decisions` on `approval.revoked`, `approval.rejected` and `approval.expired` for `slack` approvals set the outgoing message `failed` (with the failure named after the reason) and the followup back to `draft`.

- [ ] **Step 1: Failing tests:**
  - Request → approve → execute → `sent_unverified` → verify true → `sent`. One send call. `followup.sent` emitted once.
  - A second `requestSend` while pending → `SendAlreadyPending`.
  - Revoke before execution → nothing sent, outgoing `failed` `revoked`, followup `draft`.
  - Expiry → same, with `expired`.
  - Uncertain → `needs_attention`, the send never called again, then verify true → `sent`.
  - Verify false at max attempts → stays `sent_unverified` or `needs_attention`, with a notification.
  - `argument_mismatch` → approval `failed`, high flag, notification, followup `draft`.
  - A crash during execution (lease expiry) → job parked, never re-executed.
  - `resend` → a new approval, the old one superseded.
  - No text in audit rows, events, `lastError` or notifications.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun run check` → PASS.
- [ ] **Step 5: Commit** `feat(api): approved slack sends with verification and no automatic resend`.

### Task 4: Sending urgent-reply drafts

**Files:**
- Create: `apps/api/src/modules/outgoing/urgent-reply.ts`
- Modify: `apps/api/src/routes/urgent.ts`, `apps/web/app/components/UrgentInbox.tsx`, `apps/web/lib/api.ts`
- Test: `apps/api/test/routes-phase6.test.ts`, `apps/web/test/components.test.tsx`

**Interfaces:**
- **`POST /api/urgent/:messageId/reply { text }`:**
  - The text is the user's possibly edited draft, 1..4000 chars.
  - Creates a `followups` row (`origin: "urgent_reply"`, `origin_message_id`, conversation, `thread_ts` = the message's `thread_ts ?? ts`, recipient = sender, `draft_text` = text, `status: "awaiting_approval"`), then calls `requestSend`.
  - Returns `{ followupId, approvalId }`.
  - Errors: 409 on `SendAlreadyPending`; 404 for an unknown or non-urgent message; 409 when the message text has expired and `allowNoThread` is not set.
- **Urgent list items:** add `reply: { followupId, status, approvalId, outgoingStatus } | null`.
- **UrgentInbox:**
  - The draft area becomes editable with **Send for approval**.
  - After requesting, show "Awaiting approval", then "Sent", "Sending" or "Needs attention" with the resolve actions (mark sent, resend, discard).
  - Approval happens through the existing approvals list. Each pending `slack.send` approval shows the exact text, the recipient name and the conversation label (H4): extend the approvals route view for `slack.send` with an `outgoing` preview.

- [ ] **Step 1: Failing tests:**
  - Reply request creates a followup, an outgoing message and an approval.
  - The approval view shows the exact text, recipient and conversation.
  - A second request → 409.
  - Approve, then the fake sink → `sent_unverified`, and the list shows the status.
  - Revoke → back to draft.
  - Component: the editable draft, and the button is shown only when no reply is pending.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, `bun run check` and the web build → PASS.
- [ ] **Step 5: Commit** `feat(api,web): send urgent-reply drafts through approval`.

### Task 5: Commitment extraction

**Files:**
- Create:
  - `apps/api/src/intelligence/commitments/{extract-prompt.ts, validate.ts}`
  - `apps/api/src/modules/commitments/{store.ts, extraction-queue.ts}`
  - `apps/api/src/workers/commitments.ts`
- Modify: `apps/api/src/container.ts`
- Test: `apps/api/test/workers/commitments-extract.test.ts`, plus e2e

**Interfaces:**
- **Queueing:** consumer `commitments.queue` on `message.received`. For recent messages (within `people.history.days`; old backfill messages are skipped) that are not expired and are in conversations involving self (im, mpim, a mention of self, or a thread self is in, reusing the Phase 5 interaction check), it enqueues `commitments.extract` with key `commitments.extract:<debounce bucket>` and `runAfter` = the end of the bucket. Self messages also count, because the user makes promises too.
- **The handler:**
  - Selects up to `batchMax` unextracted eligible messages, oldest first. Tracking uses a new column `slack_messages.commitments_extracted_at`, added in Task 1's migration if you prefer; otherwise put it in Task 5's own generated migration.
  - **Request:**
    - Each message is one untrusted part, with source `slack message <id> by <you|them> in <label> at <sentAt>`.
    - The system part defines the commitment kinds, says "a promise is not completion", says owner and counterparty must be Slack ids that appear as authors or mentions in the cited messages, and gives due dates as ISO strings resolved relative to the message's `sentAt`.
    - Byte budget via the shared overhead-aware helper. `allowedTools` `["ToolSearch"]`. Model from `commitments.models.extract`.
  - **Validation:**
    - Evidence ids are kept only when they are in the batch; with none left, the candidate is dropped.
    - The owner and counterparty must be in the cited messages' author or mention set; otherwise the candidate is dropped.
    - Low confidence is dropped.
    - A `completion` kind never creates a commitment. It attaches as `completion_evidence` to a matching open commitment (same owner, an existing source in the same conversation) as a pending `commitment_updates` proposal (`actor: "ai"`, `field: "status"`, `to_value: "completed"`), which the user must confirm in Task 6.
  - **Dedup:** `dedup_key` = sha256(owner|counterparty|normalized description). Repeated extraction adds a source and leaves the existing commitment as it is.
  - **New commitments:** `review_status: "pending_review"` (or `accepted` when `requireReviewForDetected` is false), `status: "open"`. Emits `commitment.detected`.
  - **After the run:** marks the batch extracted. Flags follow Phase 5's R5 attribution, never self.
  - If eligible messages remain, it enqueues the next batch.

- [ ] **Step 1: Failing tests:**
  - "I'll check and let you know" from self → a `mine` commitment pending review.
  - A request the other person accepted → `theirs`.
  - An out-of-batch evidence id is dropped.
  - An owner not in the cited messages is dropped.
  - The same source twice → one commitment, with sources deduplicated.
  - A `completion` creates no commitment, only a pending status proposal.
  - Old messages are not queued.
  - The request has no tools beyond ToolSearch and the messages are untrusted.
  - The e2e path passes the real validator.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun run check` → PASS.
- [ ] **Step 5: Commit** `feat(api): evidence-checked commitment extraction`.

### Task 6: Commitment review and lifecycle

**Files:**
- Create: `apps/api/src/modules/commitments/lifecycle.ts`
- Test: `apps/api/test/modules/commitments-lifecycle.test.ts`

**Interfaces:**
- **`review(id, decision: "accept"|"reject", edits?: { description?; dueAt?; owner?; counterparty? })`.** Edits are applied and recorded in `commitment_updates` (`actor: "user"`). Emits `commitment.reviewed`.
- **`setStatus(id, status, reason?)`:**
  - Allowed transitions: `open` → `in_progress`/`blocked`/`completed`/`cancelled`; `in_progress` → `blocked`/`completed`/`cancelled`; `blocked` → `open`/`in_progress`/`cancelled`/`completed`. `completed` and `cancelled` are terminal.
  - Sets `closed_at` on terminal states, writes `commitment_updates` and emits `commitment.status_changed`.
  - An illegal transition throws a typed `InvalidCommitmentTransition`.
- **`confirmProposal(updateId, accept: boolean)`:** for AI completion proposals. Accepting applies `completed` with `completion_evidence` = the source ref. Rejecting records the rejection.
- **List views:** `listViews(filter: "all"|"mine"|"theirs"|"open"|"in_progress"|"blocked"|"overdue"|"due_soon"|"closed"|"review")`. These return `CommitmentView` with sources (`messageAvailable` and an http(s) permalink), pending proposals, followups and server-computed `actions`. "Overdue" means `due_at < now` and not closed. "Due soon" means within `dueSoonHours`.

- [ ] **Step 1: Failing tests:**
  - Accept with edits records the updates.
  - Reject.
  - The transitions table, including the illegal ones.
  - A completion proposal is confirmed or rejected.
  - Each filter.
  - An expired source keeps its ref.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun run check` → PASS.
- [ ] **Step 5: Commit** `feat(api): commitment review and lifecycle`.

### Task 7: Stall detection, reminders and follow-up drafts

**Files:**
- Create: `apps/api/src/intelligence/commitments/followup-prompt.ts`, `apps/api/src/modules/commitments/stall.ts`
- Modify: `apps/api/src/workers/commitments.ts`
- Test: `apps/api/test/workers/commitments-stall.test.ts`, plus e2e

**Interfaces:**
- **`commitments.check_stalled`** (hourly, coalesced, no AI):
  - Applies to accepted, open or in-progress `theirs` commitments.
  - A commitment is stalled when either holds:
    - since the later of its newest source and `last_followup_at`, no message from the owner exists in any of its source conversations for `waitHours`;
    - it is past due.
  - It sets `stalled_at`, emits `commitment.stalled` (once per stall), and enqueues `commitments.draft_followup` (key `commitments.draft:<id>:<stalled_at>`).
  - For `mine` commitments that are past due, it emits `commitment.overdue` once.
- **`commitments.reminders`** (every 15 minutes, no AI): sends an in-app and desktop notification for `mine` commitments that are due soon or overdue. It notifies once per (commitment, state), and the title carries the counterparty name and the state only, no description.
- **`commitments.draft_followup`:**
  - **Request:**
    - The intelligence run gets the commitment description as a `user_approved` part, but only when `review_status` is `accepted`; it was accepted by the user.
    - Up to 10 context messages from the source thread or conversation go in as `untrusted` parts.
    - The recipient's approved guidelines go in as a `user_approved` part (H1: drafting only).
  - **Output:** parses `followupDraftOutputSchema`.
  - **Writes:** a `followups` row (`origin: "stalled"`, conversation and `thread_ts` from the newest available source, recipient = owner, `status: "draft"`), and emits `followup.draft_created`.
  - **Expired source:** if the newest source message has expired, it uses the conversation with no thread and marks the followup `noThread: true` in the view. The user sees it before sending.

- [ ] **Step 1: Failing tests:**
  - No owner reply for 25 h → stalled once, plus one draft job.
  - An owner reply → not stalled.
  - Past due → stalled.
  - A reminder notifies once per state, and the title has no description.
  - A draft is stored with the guidelines part only in the drafting run.
  - An expired source → no thread.
  - The e2e path passes the real validator.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun run check` → PASS.
- [ ] **Step 5: Commit** `feat(api): stalled commitments, reminders and follow-up drafts`.

### Task 8: Spec-clarity check

**Files:**
- Create: `apps/api/src/intelligence/commitments/clarity-prompt.ts`
- Modify: `apps/api/src/workers/commitments.ts`, `apps/api/src/modules/commitments/extraction-queue.ts`
- Test: `apps/api/test/workers/commitments-clarity.test.ts`, plus e2e

**Interfaces:**
- **Trigger:** a recent message from someone else, addressed to the user (an im, or a mention of self), that matches the task-request heuristic. The heuristic is a regex over the text: `\b(can you|could you|please|need you to|bug|broken|doesn't work|isn't working|fix|implement|add|build)\b` and at least 8 words. It enqueues `commitments.check_spec_clarity` with key `commitments.spec:<messageId>`.
- **The handler:**
  - The message plus up to 5 thread messages go in as untrusted parts.
  - It parses `specClarityOutputSchema`.
  - When `clear` is false and there are questions, it creates a `followups` row (`origin: "spec_clarity"`, in the thread, recipient = sender, `draft_text` = the questions as a numbered list, `status: "draft"`) and records `missing` in `followup_history`.
  - When `clear` is true, it stores nothing.
- **Hold:** the engineering-task hold is out of scope.

- [ ] **Step 1: Failing tests:**
  - An unclear bug report → a draft with numbered questions, in the thread.
  - A clear request → nothing.
  - A message from self → not triggered.
  - A short message → not triggered.
  - The e2e path passes the real validator.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun run check` → PASS.
- [ ] **Step 5: Commit** `feat(api): spec-clarity questions for unclear requests`.

### Task 9: Routes and dashboard

**Files:**
- Create:
  - `apps/api/src/routes/commitments.ts`
  - `apps/web/app/components/{CommitmentsPanel.tsx, FollowupDrafts.tsx}`
- Modify:
  - `apps/api/src/app.ts`, `apps/api/src/routes/approvals.ts` (H4 preview, if Task 4 didn't add it)
  - `apps/web/app/page.tsx`, `apps/web/lib/api.ts`
- Test: `apps/api/test/routes-phase6.test.ts`, `apps/web/test/components.test.tsx`

**Interfaces:**
- `GET /api/commitments?filter=` → `CommitmentView[]`.
- `POST /api/commitments/:id/review { decision, edits? }`.
- `POST /api/commitments/:id/status { status, reason? }`.
- `POST /api/commitments/proposals/:id { accept }`.
- `POST /api/commitments/:id/draft-followup` → manual draft request: enqueues a draft job with `origin: "manual"`.
- `GET /api/followups?status=` → `FollowupView[]`, with draft text, recipient, conversation label, `noThread`, outgoing status and actions.
- `POST /api/followups/:id/send { text }` → `requestSend` with the edited text; it also sets `draft_text` to the sent text.
- `POST /api/followups/:id/discard`.
- `POST /api/outgoing/:id/resolve { decision }`.
- **Validation:** text 1..4000 chars, and id formats are checked. Typed errors map to 404 or 409.
- **Web:**
  - `CommitmentsPanel`: filter tabs, a review queue with Accept, Edit and Reject, status actions computed by the server, sources with expired-message wording, and completion proposals to confirm.
  - `FollowupDrafts`:
    - an editable draft with recipient and conversation, plus a "no thread" warning;
    - **Send for approval**, Discard;
    - the outgoing status and resolve actions.
  - Every send-capable control is labelled "Requires your approval".

- [ ] **Step 1: Failing tests:**
  - Each route's happy path and its 404 and 409 cases.
  - The send route creates an approval and never calls the sink until approved.
  - Component tests: tabs, actions computed by the server, the no-thread warning, the resolve actions.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, `bun run check` and the web build → PASS.
- [ ] **Step 5: Commit** `feat(api,web): commitments dashboard, follow-up drafts and send approval`.

### Task 10: H2 and H5, the smoke script, and docs

**Files:**
- Modify:
  - `apps/api/src/modules/people/*` (H2 consumer)
  - Split `apps/api/src/workers/people.ts` and `apps/api/src/workers/urgency.ts` into per-job files under `workers/people/` and `workers/urgency/` (H5). No behaviour change; keep the tests green.
  - `docs/modules/{commitments.md, slack.md, claude-orchestrator.md, people-memory.md}`, `docs/architecture/integration-contracts.md` (MessageSink as built), `CLAUDE.md`
  - `docs/superpowers/plans/2026-11-06-phase-5-followups.md` (mark H1–H5)
- Create: `scripts/dev/commitments-smoke.ts`, `scripts/dev/test/commitments-smoke.test.ts`

**Interfaces:**
- **H2:** consumer `people.post_send` on `followup.sent`.
  - When the recipient has no profile and no pending recommendation, and the outgoing message is `sent` (verified) or `sent_unverified`, it ensures a person row and stores a `suggest_evaluation` recommendation (reason "You messaged this person").
  - A failed or cancelled send never reaches this consumer.
- **`scripts/dev/commitments-smoke.ts [--pages N] [--self Uxxxx]`:**
  - It reuses the people-smoke setup and runs one `commitments.extract` batch, overriding the model to haiku.
  - It prints counts only: messages, eligible, candidates, dropped, commitments created (mine and theirs), and completion proposals.
  - **It never sends:** the container gets a sink that throws when called, and a test asserts that.
- **Docs:**
  - Add "Implementation notes (Phase 6)" to `commitments.md`.
  - Rewrite the MessageSink section of `integration-contracts.md` to match what was built.
  - Add send-run notes to `claude-orchestrator.md`.
  - Update the CLAUDE.md commands.
  - Mark H1–H5 done in the Phase 5 follow-ups.

- [ ] **Step 1: Failing tests:**
  - H2: a verified send to someone without a profile → one suggestion; to someone with a profile → none.
  - The smoke `summarize` and argument parsing, plus a sink that throws if called.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the code, the H5 split and the docs.
- [ ] **Step 4: Run** `bun test`, `bun run check` and the web build → PASS.
- [ ] **Step 5: Commit** `feat: post-send profile suggestion, worker split, commitments smoke script, phase 6 docs`.
- [ ] **Step 6 (controller only, after the final review):**
  - Run `bun scripts/dev/commitments-smoke.ts --pages 3` once.
  - Ask the user whether to do one real test send. The recipient would be the user themselves: a DM to their own Slack user id, with text the user approves on the dashboard. Do the test send only if the user says yes.

---

## Phase 6 Definition of Done

- `bun run check` passes, and no test runs real `claude` or sends.
- Commitments are extracted with evidence, reviewed by the user, and tracked through the lifecycle. A promise is never treated as completion.
- Stalled commitments produce one draft each. Reminders notify once per state.
- Unclear requests produce clarifying-question drafts.
- Every send needs the user's approval of the exact text, which the approval shows with its recipient and conversation.
  - The send run's arguments are verified by code.
  - Delivery is verified by search.
  - An uncertain outcome is never re-sent automatically.
- Urgent-reply drafts can be sent through the same path.
- H1–H5 are closed.
- A real extraction smoke run succeeds and prints counts only. A real test send happens only if the user agrees.
