# Auto-Reply (away mode)

Implements ADR-033 (Phase 6b). While away mode is on, Synapse may send three kinds of Slack message to priority people without approval, after deterministic checks. Every one ends with the tag `Sent using @claude`, appended by code. When the user switches away mode off, a digest lists what was sent and held. Spec: `docs/superpowers/specs/2026-11-06-phase-6b-away-mode.md`.

Code: `apps/api/src/modules/auto-reply` (`service.ts`, `policy.ts`), `intelligence/auto-reply/content-checks.ts`, `workers/auto-reply/evaluate.ts`, `routes/away.ts`. The send itself is `OutgoingService.requestAutoSend` (`modules/outgoing`).

## Kinds

| Kind | Trigger | Text | Placement |
|---|---|---|---|
| `acknowledgement` | `message.urgent_detected`, level `critical` or `high` | Fixed template `ACK_TEXT` in `policy.ts` (no model text) | Thread of the urgent message (`threadTs ?? ts`) |
| `stalled_reminder` | `followup.draft_created`, origin `stalled` | The follow-up draft | The follow-up's conversation and thread |
| `followup_question` | `followup.draft_created`, origin `spec_clarity` | The spec-clarity draft | The follow-up's conversation and thread |
| `code_answer` | none | none | A valid kind name in settings, but nothing produces it until Phases 9-10 |

Never auto-sent: urgent-reply drafts (they stay for approval), anything to a non-priority person, any `code_answer`, anything while away is off, an acknowledgement of a message not addressed to the user, and anything about a message from before the session or that the user already answered.

An acknowledgement depends on `message.urgent_detected`, which is only published for levels in `urgency.notify.levels` (default `critical, high`). Removing `high` there stops high-level acknowledgements.

## Flow

1. `PUT /api/away {on}` calls `setAway`: one immediate transaction that opens or closes an `away_sessions` row (one open session, enforced by a partial unique index), sets `autoReply.awayMode` through `SettingsService.setIn` (settings written in the caller's transaction), audits `away.started` / `away.ended` (actor `user`) and publishes `away.changed {on}`. Idempotent both ways.
2. The two consumers (`onUrgentDetected`, `onFollowupDraftCreated`) do nothing unless away is on. Otherwise they enqueue `autoreply.evaluate` with key `autoreply:<kind>:<id>`, priority 150, concurrency group `autoreply` (concurrency 1), `externalWrite: false`.
3. `evaluate(trigger)` is one immediate transaction: resolve, count caps, `decideAutoReply`, insert the `auto_replies` row, and on send call `requestAutoSend`. It records one row per trigger (`sent` or `held`), or skips outright (no row): `away_off`, `not_found`, `self`, `not_draft`, `kind_mismatch`, `already_evaluated`.
4. `requestAutoSend` inserts the outgoing row and `ApprovalEngine.recordPolicyApproval` (action `slack.auto_reply`, `decided_by = 'policy'`, audit `approval.policy_approved`, publishes `approval.approved`). The normal `approval.execute` path then runs the send, verification and needs-attention handling. The send run carries `policy_approved` provenance and a send guard (see `security-model.md` 6.1).
5. If the permission gate is shut or the session closed at request time, the transaction is rolled back and a hold (`policy_disabled` / `away_off`) is recorded in a new one.

A failed check publishes `autoreply.held {autoReplyId, reason}` and leaves a follow-up as a plain draft in Needs you. There is no `autoreply.skipped` event and no extra approval-queue entry (ADR-033 Deviations).

## Decision order (`decideAutoReply`, pure)

Before the policy runs, `decideAndRecord` records these pre-check holds, first match wins (spec A20):

`missing_context` > `recipient_mismatch` > `not_addressed` > `before_session` > `already_answered` > `injection_suspected`.

- **`missing_context`:** the reply cannot be built: missing recipient, conversation, draft or origin text, or a `followup_question` without an origin message.
- **`not_addressed`** (acknowledgements only): send-eligible only if the conversation is an `im` or `mpim`, the message text mentions the user's id (`<@SELF>`, `<@SELF|name>` or the entity-escaped form, parsed with `mentionedIds` from `intelligence/commitments/validate.ts`), or the user posted in the same thread (`threadTs ?? ts`) strictly before the message. Deterministic from the database; screening is unchanged.
- **`before_session`** (acknowledgements and follow-up questions): the acknowledged or origin message's `sent_at` is before the open session's `started_at`.
- **`already_answered`** (acknowledgements and follow-up questions): the user posted at or after that message's `sent_at` in its thread; in an `im` or `mpim`, anywhere in the conversation. A stalled reminder has no source message, so neither check applies to it.
- An unknown `slack.selfUserId` counts as not addressed and as already answered (both hold).
- **`injection_suspected`:** the drafting run reported `suspectedInjection.detected`, stored in `followups.suspected_injection` by the stalled and spec-clarity drafting workers.

Then the first failing policy check wins:

`away_off` > `kind_not_allowed` > `not_priority` > `loop_tag` > `flagged` > `daily_cap` > `thread_gap` > `low_confidence` > `content_secret` > `content_internal_url` > `content_link` > `content_mention` > `content_promise`.

- **Priority person:** `high` or `critical` in `people_priority_settings`.
- **Loop guard:** `loop_tag` when the incoming text contains the tag (case-insensitive, whitespace-collapsed, entities decoded) or the candidate text already carries it.
- **`flagged`:** an acknowledgement is held when its message has an open `warning`-or-higher flag. A follow-up is held when an open `warning`-or-higher flag touches the drafting run (`claudeRunId`), the origin message, (stalled) any source message of its commitment, or any message fed into the drafting prompt (`followups.context_message_ids`). Rows drafted before migration 0014 have null context ids: those are not checkable, so only the other checks apply.
- **Caps:** at most `autoReply.maxPerPersonPerDay` rows with `decision = 'sent'` to the recipient in the rolling 24 h; no `sent` row in the same conversation and thread within `autoReply.minMinutesBetweenInThread` (in an `im` the gap is per conversation, since a thread there reaches the same person). Count and insert share one transaction in a concurrency-1 group, so they cannot race.
- **Confidence:** acknowledgements have none (fixed text). Others need `confidence >= autoReply.minConfidence`; null counts as below. A low-confidence `followup_question` with an origin message enqueues an acknowledgement for that message in the same transaction (`autoreply:acknowledgement:<messageId>`, shared with the urgent trigger, so it is deduplicated); the draft stays in Needs you. A low-confidence `stalled_reminder` is only held. Acknowledgements replace low-confidence follow-up questions only.
- **`recipient_mismatch`:** in an `im` the recipient must be the DM partner (the first non-self sender, the inbox rule). A DM with an unknown partner or unknown self id holds.
- **`policy_disabled`:** the effective permission for `slack.auto_reply` is no longer `policy_gated` (the user tightened it). The auto-reply is held and never pends for manual approval.

## Content checks (`content-checks.ts`, pure)

Run on the candidate text before the tag is added, for every kind (the fixed acknowledgement text passes by construction, so in practice they gate model drafts); a match holds. Deliberately conservative: a false hold costs little. Order: secret, internal URL, link, mention, promise.

- **secret:** `xox[abprs]-`, `sk-` + 16 alphanumerics, `AKIA...`, `gh[pousr]_...`, private-key headers, `password|passwd|secret|token|api_key` followed by `:` or `=`, uppercase env assignments (`NAME=value`), and any 40+ character token-like run (plain URLs without query or fragment are exempt from the run check).
- **internal URL:** `localhost`, `127.*`, `10.*`, `192.168.*`, `172.16-31.*`, `[::1]`, `*.local`, `*.internal`, a URL with a non-default port, or `host.tld:port`.
- **link** (after internal URL, so an internal one keeps `content_internal_url`): any `scheme://` (http, https, ftp, ws, mailto, ...), a bare `www.` host, or a Slack `<http…>` / `<mailto:…>` link, raw or entity-escaped, or a bare `mailto:` / `tel:` / `sms:` link.
- **mention:** `<!channel>`, `<!here>`, `<!everyone>`, `<!subteam^…>` (raw or escaped, with or without a label), any `<@U…>` / `<@W…>` user mention, and any bare `@name` (covers `@here`, `@channel`, `@everyone`; broader on purpose; an email address is not a mention).
- **promise:** `I will`, `I'll`, `we will`, `we'll`, `I promise`, `guarantee`, `by today|tonight|tomorrow|eod|eow|<weekday>|next week`, `deadline`, `I've/I have approved|decided`, `approved`, `go ahead and`, and dates such as `5 Dec` or `Dec 5`.

Known gaps are in `docs/superpowers/plans/2026-11-06-phase-6b-followups.md`.

## Tag

`withAutoReplyTag(text) = text.trimEnd() + "\n\nSent using @claude"`, added in `decideAndRecord` just before `requestAutoSend`. `AUTO_REPLY_TAG` lives in `packages/contracts`; `requestAutoSend` throws `MissingAutoReplyTag` if the text does not end with it. The model never sees or writes it. There is no `autoReply.tag` setting.

## Away off

The user's return wins. Anything not yet spawned is cancelled by three checks, all using the same `autoSendBlock`: away off, or the auto-reply's session no longer the open one (`away_off`); the gate shut (`policy_disabled`); or more than `autoReply.maxSendDelayMinutes` (default 15) since the `auto_replies` row was created (`stale`, M8; an unparseable time counts as stale):

1. the executor's `revalidate` (the approval ends `revoked`, auto-reply held);
2. the claim transaction (`pending` to `sending`) re-check (the executor throws, so the approval ends `failed`);
3. `beforeSpawn` (`RunOptions`, passed through `SendOptions`): checked after the Claude slot is acquired, just before spawn. A false return (or a throw) fails the run with `cancelled_before_spawn` and `details.notSpawned`; the approval ends `failed`.

A cancelled send ends as outgoing `failed` with `cancelled_away_off`, `cancelled_policy_disabled` or `cancelled_stale`; the `auto_replies` row becomes `held` with the matching reason (`away_off`, `policy_disabled`, `stale`; text cleared), a linked follow-up returns to `draft`, and `autoreply.held` is published. A send that has already spawned is allowed to finish; `setAway(false)` never cancels a `sending` row.

## Records and digest

`auto_replies(id, session_id, kind, recipient_slack_user_id, conversation_external_id, thread_ts, source_message_id, followup_id, decision 'sent'|'held', reason, text, outgoing_id, approval_id, created_at)`, indexed on (recipient, created_at), (conversation, thread, created_at) and `outgoing_id`; `away_sessions(id, started_at, ended_at, dismissed_at)`. Migration `0013_away_mode.sql`; `0014_followup_context_flags.sql` adds `followups.suspected_injection` (boolean, not null, default false), `followups.context_message_ids` (JSON text, nullable) and the `auto_replies_outgoing_idx` index. Text is kept only on sent rows; a held row keeps no text (the draft is in its follow-up).

**Retention.** The daily `slack.retention_cleanup` job, with `retention.slackContentDays` (default 180), also runs `AutoReplyService.expireText` (sets `auto_replies.text` to null where `created_at` is older than the cutoff), `OutgoingService.expireText` (sets `outgoing_messages.text` to `''`, since the column is NOT NULL, on `sent` and `failed` rows older than the cutoff by `created_at`) and `FollowupService.expireDrafts` (sets `followups.draft_text` to null on `sent`, `discarded` and `failed` rows older than the cutoff by `created_at`). Rows in any other status are never touched. The job returns counts only.

`decision = 'sent'` is the policy verdict and delivery is the outgoing status. A user revoke, or an expiry, of a send that is still within `autoReply.maxSendDelayMinutes` and whose gates are open leaves `sent`, and caps count it. Past that window the revoke consumer's `autoSendBlock` check holds it as `stale`: nothing was sent, so it no longer counts towards the daily cap or the thread gap. A 7-day approval expiry therefore always ends `held` / `stale`. `autoreply.sent {autoReplyId}` is published when the outgoing message first reaches `sent_unverified` or `sent`, not at decision time.

`GET /api/away/digest` returns the most recently ended, undismissed session as `{ session, sent, held }`, or `null`. Views carry recipient name, kind, conversation label, thread, time, reason and `outgoingStatus` (delivery is derived from it); never reply text. `POST /api/away/digest/:sessionId/dismiss` returns 204; 404 for an unknown or still-open session. Dismissing an already dismissed session also returns 204.

## Settings

| Key | Default |
|---|---|
| `autoReply.awayMode` | `false` (written by `setAway`, not the settings page) |
| `autoReply.allowedKinds` | all four kinds |
| `autoReply.maxPerPersonPerDay` | 3 |
| `autoReply.minMinutesBetweenInThread` | 30 |
| `autoReply.minConfidence` | 0.75 |
| `autoReply.maxSendDelayMinutes` | 15 |

Permission: `slack.auto_reply` defaults to `policy_gated`, which only `recordPolicyApproval` accepts. An override can tighten it (which holds auto-replies as `policy_disabled`) but never loosen it.

There is no UI or route yet to tighten the permission or to change the `autoReply.*` settings (`PermissionManager.setOverride` and `SettingsService.set` exist, but nothing exposes them for these keys). Today's kill switch is switching away mode off (`PUT /api/away {on: false}` or the header switch), which also cancels anything not yet spawned. Recorded in the follow-ups.

## Events and routes

Emitted: `away.changed {on}`, `autoreply.sent {autoReplyId}`, `autoreply.held {autoReplyId, reason}`. Consumed: `message.urgent_detected`, `followup.draft_created`. Routes: `GET /api/away`, `PUT /api/away`, `GET /api/away/digest`, `POST /api/away/digest/:sessionId/dismiss`. Audit and events carry ids and fixed reasons only, never text.

## Tests

`apps/api/test/modules/auto-reply-service.test.ts`, `test/modules/auto-reply-policy.test.ts`, `test/intelligence/auto-reply-content.test.ts`, `test/modules/outgoing-auto.test.ts` (cancellation, including `stale`), `test/integration/auto-send-retention.test.ts`, `test/routes/away.test.ts`, `test/integration/away-autoreply-e2e.test.ts`, the send guard in `test/integrations/send-guard.test.ts`. The real-CLI guard proof is `scripts/dev/hook-smoke.ts`.
