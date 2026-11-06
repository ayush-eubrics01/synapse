# Phase 6b: Away-Mode Auto-Replies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While away mode is on, priority people get tagged, policy-checked automatic replies (an acknowledgement, a stalled reminder or a follow-up question) through the existing verified send path. The user gets a digest on return.

**Architecture:**
- **Decision.** A pure `decideAutoReply` makes every decision.
- **Sending.** A policy approval (`slack.auto_reply`, decided by `auto_reply_policy`) reuses the approval execute path, the `OutgoingService` executor, `SlackSender` and verification. The send run carries `policy_approved` provenance.
- **Prevention.** A per-run PreToolUse hook blocks any send whose arguments differ from the approved ones, before anything goes out.
- **Records.** Away sessions and `auto_replies` rows feed the digest.

**Tech Stack:** Bun 1.4.4, TypeScript strict, Hono, bun:sqlite + Drizzle (generated migrations), Zod 4, Next.js 16, `bun test`.

**Spec:** `docs/superpowers/specs/2026-11-06-phase-6b-away-mode.md` (decisions A1–A19), ADR-033, and entry gate J1–J5 in `docs/superpowers/plans/2026-11-06-phase-6-followups.md`.

## Global Constraints

- **CLAUDE.md hard rules:**
  - Only `core/orchestrator` runs Claude.
  - Untrusted text never reaches a run that can act.
  - The only sends without user approval are `slack.auto_reply`, and they are created only by `recordPolicyApproval`.
- **Never in logs, audit rows, events, notification titles, `lastError` or error messages:** Slack content, draft text or auto-reply text.
- **Tag:** exactly `Sent using @claude`, appended by code (A10).
- **Settings and defaults:**
  - `autoReply.awayMode` = false (exists);
  - `autoReply.allowedKinds` = `["code_answer","stalled_reminder","followup_question","acknowledgement"]`;
  - `autoReply.maxPerPersonPerDay` = 3;
  - `autoReply.minMinutesBetweenInThread` = 30;
  - `autoReply.minConfidence` = 0.75.
- **Tests:** placeholder people only (Ada, Grace, Linus). Never run the real `claude`; use the fake-binary pattern for e2e. No new dependency.
- **Migrations:** one new migration, `0013_away_mode.sql`, generated with the repo's drizzle workflow. Never edit an applied migration.
- **`bun run check` stays green.** Web tasks also pass `bun run --cwd apps/web build`.

## Review Focus

1. **The user returns mid-send.** Away is switched off after a decision but before execution. Revalidate must cancel the send: no message, the approval revoked, the row held with reason `away_off`. Tested in Task 4.
2. **Two triggers race for one thread.** For example an acknowledgement and a follow-up question for the same message. The thread gap and daily cap must hold, with only one sent. Tested in Task 5, with concurrency group plus transaction.
3. **Hook mismatch.** The guard blocks, the run reports no successful send, and the outgoing row ends `failed` (`argument_mismatch`), never re-sent. Tested in Task 1 at unit level and in Task 2 on the real CLI with a read tool.
4. **An incoming message already carries the tag** (bot loop), or has an open warning flag: held, never sent. Tested in Task 3.
5. **Null-confidence spec-clarity rows from before this phase** count as low confidence. Tested in Task 3/5.

---

### Task 1: Provenance `policy_approved` (J1) and the PreToolUse send guard (J2)

**Files:**
- Modify:
  - `packages/contracts/src/ai.ts`: add `policy_approved` to the provenance union and zod enum; add `sendGuard?` to `ClaudeJobRequest` and `AIExecutionRequest`.
  - `apps/api/src/core/orchestrator/validator.ts`: add rule K.
  - `apps/api/src/core/orchestrator/orchestrator.ts`: pass `sendGuard` through to `execReq`.
  - `apps/api/src/core/orchestrator/prompt.ts`: render `policy_approved` like `user_approved`, with its own label `policy-approved`.
- Create: `apps/api/src/integrations/claude-code/send-guard.ts` (pure: `canonicalSendInput(input: unknown): string`, `sendInputSha256(input: unknown): string`, `buildGuardedOverride(base: string, guard: SendGuard, hookCommand: string[]): string`)
- Create: `apps/api/src/integrations/claude-code/send-guard-hook.ts`, a runnable script: `bun send-guard-hook.ts <sha256>` reads the hook JSON from stdin. It exits 0 when `sha256(canonical(tool_input))` matches. Otherwise it exits 2, writing `send arguments differ from the approved message` to stderr.
- Modify:
  - `apps/api/src/integrations/claude-code/cli-provider.ts`: when `r.sendGuard` is set, use `buildGuardedOverride(settingsOverride, r.sendGuard, [process.execPath, <abs path to send-guard-hook.ts>])` for that run only.
  - `apps/api/src/integrations/slack/sender.ts`: `buildSendRequest` sets `sendGuard: { toolName: SEND, expectedInputSha256: sendInputSha256(args) }` and takes the provenance from `cmd.authorisedBy` (`"user"` → `user_approved`, `"policy"` → `policy_approved`). The default is `"user"`.
  - `packages/contracts/src/outgoing.ts`: add `SendMessageCommand.authorisedBy?: "user" | "policy"`.
- Test: `apps/api/test/core/validator.test.ts` (add rule-K cases), `apps/api/test/integrations/send-guard.test.ts`, `apps/api/test/integrations/cli-provider.test.ts` (or wherever args or override are asserted), `apps/api/test/integrations/slack-sender.test.ts`.
- Docs: `docs/modules/claude-orchestrator.md` (the provenance table, rule K and the send guard), `docs/architecture/security-model.md` (send guard).

**Interfaces:**
- Produces:
  - `type SendGuard = { toolName: string; expectedInputSha256: string }`;
  - `sendInputSha256(input)`. Canonical form: a JSON object with keys sorted recursively, with `undefined` and absent keys dropped;
  - `SendMessageCommand.authorisedBy`.

- [ ] **Step 1: Write the failing tests.**
  - **Validator:**
    - `policy_approved` + system parts + `[SEND, "ToolSearch"]` → ok;
    - `policy_approved` in an intelligence run with no write tool → `fail("policy_approved content outside a send run")`;
    - `policy_approved` + `untrusted` in a send run → fails (rule D or I).
  - **Guard:**
    - `canonicalSendInput({message:"a", channel_id:"D1"})` equals `canonicalSendInput({channel_id:"D1", message:"a"})`;
    - the sha256 changes when any value changes;
    - the hook script run via `Bun.spawn` with a matching stdin `{"tool_name":"…","tool_input":{…}}` exits 0;
    - a mismatch exits 2 with the reason on stderr;
    - malformed stdin exits 2.
  - **Provider:** with `sendGuard`, the `--settings` argument parses to JSON whose `hooks.PreToolUse[0].matcher` equals the tool name and whose command contains the sha256. Plugins stay disabled as in the base override. Without `sendGuard`, the override is unchanged.
  - **Sender:**
    - `buildSendRequest(cmd)` carries a `sendGuard` whose sha256 equals `sendInputSha256` of the JSON args;
    - `authorisedBy: "policy"` gives a `policy_approved` part;
    - with no value, it gives `user_approved`.
- [ ] **Step 2: Run.** Expect FAIL.
- [ ] **Step 3: Implement.**
  - Rule K goes after rule J, with the reason `policy_approved content outside a send run`.
  - Keep the hook script dependency-free (only `node:crypto` and stdin).
  - It must also run directly under `bun` with no repo imports, because Claude Code spawns it. Import the canonicaliser from a sibling file that has no other imports, or inline it and test that the two agree.
- [ ] **Step 4: Run** `bun test apps/api` and `bun run check`. Expect PASS.
- [ ] **Step 5: Update the docs. Commit:** `feat(orchestrator): policy_approved provenance and PreToolUse send guard (J1, J2)`.

### Task 2: Real-CLI hook smoke (controller-run)

**Files:**
- Create: `scripts/dev/hook-smoke.ts`, plus a unit test `scripts/dev/test/hook-smoke.test.ts` for any pure helper, such as the parser of the run outcome.
- Modify: `CLAUDE.md` (Commands: add the `hook-smoke` line)

**Interfaces:**
- Consumes: `sendGuard` (Task 1). Runs one orchestrator job on a temp DB, as `claude-smoke.ts` does:
  - profile `collector`, `allowedTools: ["mcp__claude_ai_Slack__slack_search_users","ToolSearch"]`;
  - the instruction: call `slack_search_users` once with query `synapse-hook-smoke`;
  - `sendGuard: { toolName: "mcp__claude_ai_Slack__slack_search_users", expectedInputSha256: "0".repeat(64) }`.
- Pass condition: the run's raw tool results contain **no** non-error `slack_search_users` result, **and** it has either a permission denial for that tool or an error tool_result mentioning the guard reason. It prints `hook-smoke: blocked` or `hook-smoke: NOT BLOCKED` with an exit code of 0 or 1. Counts only, never content.

- [ ] **Step 1:** Write the outcome classifier `classifyHookSmoke(result: { toolResults: RawToolResult[]; permissionDenials: unknown[] }): "blocked" | "not_blocked" | "inconclusive"`, with tests covering the three cases.
- [ ] **Step 2:** Write the script. It must not read or print user content. The tool is read-only, so it can never send.
- [ ] **Step 3:** Run `bun run check`, then commit: `feat(scripts): hook-smoke proves the send guard blocks on the real CLI`.
- [ ] **Step 4 (controller):** Run `bun scripts/dev/hook-smoke.ts` once. If it is not blocked, stop and redesign before Task 4 relies on the guard; the after-the-fact check stays regardless. Record the result in the follow-ups.

### Task 3: Away data model, settings and the pure policy

**Files:**
- Modify: `packages/database/src/schema/platform.ts`: add the `away_sessions` table (`id, started_at, ended_at?, dismissed_at?`, plus a partial unique index allowing one open session where `ended_at is null`). Add the `auto_replies` table per spec A16, with indexes on `(recipient_slack_user_id, created_at)` and `(conversation_external_id, thread_ts, created_at)`. Add the `approvals.decided_by` text column (`'user' | 'policy'`, nullable).
- Create: `packages/database/migrations/0013_away_mode.sql` (generated)
- Modify:
  - `apps/api/src/core/config/settings.ts`: add the four `autoReply.*` keys with the Global Constraints defaults. `allowedKinds` is an array of the kind enum.
  - `packages/contracts/src/permissions.ts`: add `slack.auto_reply` with the default policy `policy_gated`, and add `policy_gated` to the policy union. Policy overrides must not be able to change `policy_gated` to anything looser.
- Create:
  - `packages/contracts/src/auto-reply.ts`: `AutoReplyKind`, `HoldReason` (the A4 list), `AutoReplyView` and the digest DTO.
  - `apps/api/src/intelligence/auto-reply/content-checks.ts`: `contentCheck(text: string): "content_secret" | "content_internal_url" | "content_promise" | null`.
  - `apps/api/src/modules/auto-reply/policy.ts`: `decideAutoReply(i: PolicyInput): { send: true } | { send: false; reason: HoldReason }`, plus `withAutoReplyTag(text)`, `hasAutoReplyTag(text)` and `ACK_TEXT`.
- Test: `apps/api/test/modules/auto-reply-policy.test.ts`, `apps/api/test/intelligence/auto-reply-content.test.ts`, the migration test pattern the repo uses, and a settings test.

**Interfaces:**
- Produces: `PolicyInput = { awayOn: boolean; kind: AutoReplyKind; allowedKinds: AutoReplyKind[]; recipientPriority: "normal"|"high"|"critical"; incomingText: string | null; incomingFlagged: boolean; sentToRecipientLast24h: number; lastSentInThreadAt: string | null; now: string; confidence: number | null; candidateText: string; maxPerDay: number; minGapMinutes: number; minConfidence: number }`.
  - The acknowledgement kind skips the confidence check.
  - `confidence: null` counts as below the threshold.

- [ ] **Step 1: Write the failing tests.**
  - One test per A4 reason, in order. Each input fails exactly one check, and the earlier checks win when several fail.
  - **Caps:** 2 sent in 24 h → ok, 3 → `daily_cap`. Last in-thread send 29 min ago → `thread_gap`, 31 min ago → ok.
  - An acknowledgement with `confidence: null` → ok. A followup question with `null` → `low_confidence`.
  - **Content cases**, each yielding its reason:
    - `xoxb-123…`, `AKIA` plus 16 characters, `DB_PASSWORD=hunter22`, a 44-character base64 run → `content_secret`;
    - `http://localhost:3000/x`, `https://api.internal/x`, `http://10.1.2.3` → `content_internal_url`;
    - `I'll have it ready by Friday`, `deadline is 5 Dec`, `I have approved it` → `content_promise`;
    - clean `Could you share the CSV you uploaded?` → null.
  - `ACK_TEXT` passes `contentCheck`.
  - `withAutoReplyTag("hi  ")` is `"hi\n\nSent using @claude"`.
  - `hasAutoReplyTag` matches the casing and spacing variants, and the Slack-encoded `&amp;` form where relevant.
  - The settings defaults read back as specified.
  - The migration applies on a fresh DB, and a second open away session violates the unique index.
- [ ] **Step 2: Run.** Expect FAIL.
- [ ] **Step 3: Implement.** Generate the migration with the repo's script (`drizzle-kit generate`, as earlier phases did; see `packages/database/package.json`).
- [ ] **Step 4: Run** `bun run check`. Expect PASS.
- [ ] **Step 5: Commit:** `feat(auto-reply): away data model, settings and deterministic policy`.

### Task 4: Policy approval, the auto-send request and the executor

**Files:**
- Modify:
  - `apps/api/src/core/approvals/approvals.ts`: add `recordPolicyApproval(tx, req: ApprovalRequest, decidedBy: "auto_reply_policy"): Approval`. It throws `PolicyApprovalNotAllowed` unless `req.action === "slack.auto_reply"`. It inserts `status: "approved"` and `decided_by: "policy"`, audits actor `system` and action `approval.policy_approved` (ids only), and publishes `approval.approved`. `request()` must refuse action `slack.auto_reply`, so it can never pend for a user.
  - `apps/api/src/core/permissions/permissions.ts`: enforce `policy_gated`. `request()` refuses it; only `recordPolicyApproval` accepts it.
  - `apps/api/src/modules/outgoing/service.ts`: add `requestAutoSend(tx, input: AutoSendRequest): SendRequested`, where `AutoSendRequest = { autoReplyId: string; conversationExternalId: string; threadTs: string | null; text: string; followupId: string | null }`. It inserts an outgoing row the same way `requestSend` does, using `recordPolicyApproval` with action `slack.auto_reply`, and sets `outgoing_messages.approval_id`. Register a second integration executor for `slack.auto_reply` that shares the `slack.send` claim, execute and verify logic, but passes `authorisedBy: "policy"`. Its `revalidate(a)` returns false unless `settings.get("autoReply.awayMode")` is true and the auto-reply's `session_id` equals the open session's id.
  - When revalidate fails: revoke the approval, set the outgoing row to `failed` with failure `cancelled_away_off`, set the auto_reply row to `held` with reason `away_off`, and publish `autoreply.held`. Nothing is sent.
  - `packages/contracts/src/events.ts`: add `autoreply.sent`, `autoreply.held` and `away.changed` (payloads per spec A16), and mirror them in `apps/web/lib/live-events.ts` (its test enforces parity).
- Test: `apps/api/test/core/approvals-policy.test.ts`, `apps/api/test/modules/outgoing-auto.test.ts`

**Interfaces:**
- Consumes: Task 1 `authorisedBy`, and the Task 3 tables and policy.
- Produces: `OutgoingService.requestAutoSend` and `ApprovalEngine.recordPolicyApproval`. On `followup.sent` or verification of an outgoing row linked to an auto_reply, publish `autoreply.sent` exactly once.

- [ ] **Step 1: Write the failing tests.**
  - `recordPolicyApproval` with action `slack.send` throws. `request()` with action `slack.auto_reply` throws.
  - A policy approval is `approved` with `decided_by='policy'`, and the audit row has actor `system` and no text.
  - `requestAutoSend`, then executing the approval with a fake sink, results in the sink receiving `authorisedBy: "policy"` and the tagged text unchanged.
  - **Revalidate:** with away switched off before execute, or with the session changed, the sink is never called, the approval is `revoked`, the outgoing row is `failed`/`cancelled_away_off`, and the auto_reply is `held`/`away_off`.
  - A `slack.send` user approval still uses `authorisedBy: "user"`.
- [ ] **Step 2: Run.** Expect FAIL.
- [ ] **Step 3: Implement.** Reuse the existing executor code, not a copy: factor the shared execute body into one private function with an `authorisedBy` parameter.
- [ ] **Step 4: Run** `bun test apps/api` and `bun run check`. Expect PASS.
- [ ] **Step 5: Commit:** `feat(outgoing): policy-approved auto-sends through the verified send path`.

### Task 5: Away sessions, triggers and the auto-reply service

**Files:**
- Create:
  - `apps/api/src/modules/auto-reply/service.ts`: `AutoReplyService` with these methods:
    - `setAway(on: boolean): { on: boolean; sessionId: string | null }`: opens or closes a session, sets the setting, audits `away.started`/`away.ended` with actor `user`, and publishes `away.changed`;
    - `status()`;
    - `evaluate(trigger: Trigger): AutoReplyOutcome`, where `Trigger = { kind: "acknowledgement"; messageId: string } | { kind: "stalled_reminder" | "followup_question"; followupId: string }`;
    - `digest(): DigestDto | null`;
    - `dismissDigest(sessionId)`.
  - `apps/api/src/workers/auto-reply/evaluate.ts`: job `autoreply.evaluate` in concurrency group `autoreply` with concurrency 1, idempotency key `autoreply:<kind>:<id>`.
- Modify:
  - `apps/api/src/container.ts`: wire it up. Add dispatcher handlers: on `message.urgent_detected` (level critical/high), enqueue `{kind:"acknowledgement", messageId}` only while away is on. On `followup.draft_created`, enqueue by origin: `stalled` → `stalled_reminder`, `spec_clarity` → `followup_question`; other origins are ignored, and only while away is on.
  - `packages/contracts/src/commitments.ts` and `apps/api/src/intelligence/commitments/clarity-prompt.ts`: spec-clarity confidence (A7). `workers/commitments/check-spec-clarity.ts` stores it.
- Test: `apps/api/test/modules/auto-reply-service.test.ts`, `apps/api/test/workers/auto-reply-evaluate.test.ts`

**Interfaces:**
- Consumes: Task 3 `decideAutoReply`, Task 4 `requestAutoSend`, `PeopleService.getPriorityBySlackUser`, `SecurityFlagsService.hasOpenFlag(messageId, "warning")`, and the followups and messages tables.
- `evaluate` algorithm. Everything is one immediate transaction, except the read of message text:
  1. Resolve the recipient, conversation, thread, incoming message id and text, the candidate text and the confidence:
     - acknowledgement: recipient = message sender, thread = `threadTs ?? ts`, candidate = `ACK_TEXT`, incoming = that message;
     - stalled or followup question: from the followup row (recipient, conversation external id, thread, `draftText`, `confidence`); incoming = the `originMessageId` message if present.
  2. Count caps from `auto_replies` (A5).
  3. Call `decideAutoReply`.
  4. **On send:** insert an `auto_replies` row (`sent`, text = the tagged text) and call `requestAutoSend` with the tagged text. For a followup, also move it out of `draft` exactly as `FollowupService.send` does (status `awaiting_approval`, linked ids), so it can't be sent twice.
  5. **On hold:** insert an `auto_replies` row (`held`, reason, `text: null`). Leave the followup as a draft for the user.
  6. **Low-confidence `followup_question` (A6):** after recording the hold, run `evaluate({kind:"acknowledgement", messageId: originMessageId})` if the origin message exists.
  7. Publish `autoreply.sent` or `autoreply.held`.
  - A recipient with no Slack id, or an expired source message (text null), counts as held with reason `missing_context` (add it to `HoldReason`).

- [ ] **Step 1: Write the failing tests.** Use a temp DB with seeded fixtures (Ada as priority high, Grace as normal) and a fake sink.
  - Away off → no job is enqueued on either event.
  - Away on:
    - an urgent message from Ada → one acknowledgement is sent with the exact tagged `ACK_TEXT` in her thread;
    - the same from Grace → held, `not_priority`;
    - a stalled followup draft to Ada with confidence 0.9 and clean text → sent, and the followup leaves `draft`;
    - with confidence 0.5 → held, `low_confidence`, and the followup is still `draft`;
    - a spec-clarity draft at 0.5 with an origin message → the question is held and an acknowledgement is sent;
    - a null-confidence spec draft → `low_confidence`.
  - **Caps:** a 4th send to Ada within 24 h → `daily_cap`. An acknowledgement and then a followup question in the same thread within 30 min → the second is `thread_gap`.
  - An incoming message containing the tag → `loop_tag`. An incoming message with an open warning flag → `flagged`.
  - `setAway(false)` closes the session. `digest()` returns that session's sent and held rows with recipient names. `dismissDigest` hides it.
  - The idempotency key prevents double evaluation of the same trigger.
- [ ] **Step 2: Run.** Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test apps/api` and `bun run check`. Expect PASS.
- [ ] **Step 5: Commit:** `feat(auto-reply): away sessions, triggers and policy-gated auto-replies`.

### Task 6: API routes and the end-to-end fake-binary test

**Files:**
- Create: `apps/api/src/routes/away.ts`, registered in `app.ts`. Routes:
  - `GET /api/away` → `{ on, sessionId, startedAt }`;
  - `PUT /api/away` body `{ on: boolean }` → the same;
  - `GET /api/away/digest` → `DigestDto | null`;
  - `POST /api/away/digest/:sessionId/dismiss` → 204; an unknown id → 404.
- Modify:
  - `apps/api/src/modules/dashboard/service.ts`: add `away: { on: boolean; highPriorityCount: number }` to the overview (contract in `packages/contracts/src/dashboard.ts`).
  - `apps/api/src/modules/inbox/conversations.ts`: `sentViaSynapse` gains `auto: boolean`, true when the matched outgoing row belongs to an auto_reply.
- Test: `apps/api/test/routes/away.test.ts`, and `apps/api/test/integration/away-autoreply-e2e.test.ts`. The e2e follows the existing `slack-send-e2e` fake-binary pattern, through the real `ClaudeCliProvider` and `ClaudeOrchestrator`:
  1. away on;
  2. urgent message from a high-priority person;
  3. the evaluate job runs;
  4. approval execute;
  5. the fake claude emits a `slack_send_message` tool_use whose input equals the tagged ack and a success tool_result;
  6. the outgoing row reaches `sent_unverified`;
  7. `autoreply.sent` is published.

  Assert that the fake binary received a `--settings` argument containing the PreToolUse guard with the expected sha256. A second case where the fake binary's tool_use input differs → outgoing `failed`/`argument_mismatch`, `needs_attention` behaviour as in Phase 6 R5, and never re-sent.

- [ ] **Step 1: Write the failing tests:** routes (400 on a bad body, toggling, digest and dismiss), the overview `away` field, `sentViaSynapse.auto`, and both e2e cases.
- [ ] **Step 2: Run.** Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun run check`. Expect PASS.
- [ ] **Step 5: Commit:** `feat(api): away mode routes, digest and auto-reply e2e`.

### Task 7: Web — Away switch, banner, digest card and thread badge

**Files:**
- Modify:
  - `apps/web/lib/api.ts`: add `getAway`, `setAway(on)`, `getAwayDigest`, `dismissAwayDigest(id)`, plus tests in `test/api.test.ts`.
  - `apps/web/app/components/header/Header.tsx`: the Away switch becomes enabled. It reflects `overview.away.on` and calls `setAway`, with the toast "Away mode on" or "Away mode off". Remove the D9 disabled text.
  - Create `apps/web/app/components/header/AwayBanner.tsx` (copy per spec A18, plus a "Set priority people" button that scrolls to #people).
  - Create `apps/web/app/components/triage/AwayDigestCard.tsx`, rendered first in Needs you while a digest exists:
    - kind tag "WHILE YOU WERE AWAY";
    - the title "<n> auto-replies sent, <m> held";
    - rows per item: recipient avatar and name, a kind label ("Acknowledgement", "Stalled reminder", "Follow-up question"), conversation label, time, and outgoing status or hold reason in plain words. The hold-reason mapping is in `lib/away.ts`.
    - a "Dismiss" button.
  - `apps/web/lib/needs-you.ts`: add the `away-digest` card kind, ranked first. It counts in the Needs-you badge.
  - `apps/web/app/components/inbox/Thread.tsx`: when `sentViaSynapse.auto`, show "sent via Synapse · auto-reply while away".
  - `apps/web/app/components/people/PriorityList.tsx`: the subtitle per spec A18.
  - `apps/web/app/page.tsx`: wiring, and refetch the digest in `refresh()`.
- Create: `apps/web/lib/away.ts` with `holdReasonLabel(reason)` and `kindLabel(kind)`:
  - `away_off`: "You came back first";
  - `not_priority`: "Not a priority person";
  - `loop_tag`: "Their message was itself an auto-reply";
  - `flagged`: "Their message has an open red flag";
  - `daily_cap`: "Daily limit reached";
  - `thread_gap`: "Replied in this thread recently";
  - `low_confidence`: "Not confident enough";
  - `content_secret`: "Draft looked like it contained a secret";
  - `content_internal_url`: "Draft contained an internal link";
  - `content_promise`: "Draft made a promise for you";
  - `kind_not_allowed`: "Kind turned off";
  - `missing_context`: "Original message no longer available".
- Test: `apps/web/test/away.test.ts`, `apps/web/test/away-ui.test.tsx`, plus updates to the existing header, needs-you and inbox tests.

- [ ] **Step 1: Write the failing tests:**
  - the switch is enabled (`role="switch"`, no `aria-disabled`) and reflects `on`;
  - the banner copy for n = 2 and n = 0;
  - the digest card renders sent and held rows with labels, and Dismiss calls the handler;
  - the `away-digest` card ranks first and counts;
  - the thread auto badge;
  - every `holdReasonLabel` mapping exists, with an exhaustive test over the contract's `HoldReason` list.
- [ ] **Step 2: Run.** Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun run check` and `bun run --cwd apps/web build`. Expect PASS.
- [ ] **Step 5: Commit:** `feat(web): away mode switch, banner, return digest and auto-reply badges`.

### Task 8: Docs, ADR status and follow-ups

**Files:**
- Create: `docs/modules/auto-reply.md`. It covers the flow, the decision order, the content checks, caps, the send guard, sessions and digest, settings, events and the deferred `code_answer`.
- Modify:
  - `docs/decisions/ADR/ADR-033-*.md`: add an "Implementation (Phase 6b)" section linking the module doc. It records the J1 `policy_approved` provenance, the J2 send guard, the rolling 24 h cap, the acknowledgement template, and that acknowledgements replace low-confidence followup questions only.
  - `docs/architecture/security-model.md`: the auto-send path and the send guard.
  - `docs/architecture/integration-contracts.md`: `requestAutoSend` and `sendGuard`.
  - `docs/modules/claude-orchestrator.md`, if Task 1 didn't fully cover it.
  - `docs/product/roadmap.md`: Phase 6b status.
  - `CLAUDE.md`: hard rule 2 wording stays, but point to `docs/modules/auto-reply.md`.
- Create: `docs/superpowers/plans/2026-11-06-phase-6b-followups.md`. It records the hook-smoke result, rulings and deferred items (`code_answer`, per-person kind toggles, phone approvals).

- [ ] **Step 1: Write the docs.** Check the claims against the code (grep for each setting key and event name).
- [ ] **Step 2: Run** `bun run check`. Expect PASS.
- [ ] **Step 3: Commit:** `docs: phase 6b away mode, ADR-033 implementation notes and follow-ups`.
