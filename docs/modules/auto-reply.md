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

Never auto-sent: urgent-reply drafts (they stay for approval), anything to a non-priority person, any `code_answer`, anything while away is off.

An acknowledgement depends on `message.urgent_detected`, which is only published for levels in `urgency.notify.levels` (default `critical, high`). Removing `high` there stops high-level acknowledgements.

## Flow

1. `PUT /api/away {on}` calls `setAway`: one immediate transaction that opens or closes an `away_sessions` row (one open session, enforced by a partial unique index), sets `autoReply.awayMode` through `SettingsService.setIn` (settings written in the caller's transaction), audits `away.started` / `away.ended` (actor `user`) and publishes `away.changed {on}`. Idempotent both ways.
2. The two consumers (`onUrgentDetected`, `onFollowupDraftCreated`) do nothing unless away is on. Otherwise they enqueue `autoreply.evaluate` with key `autoreply:<kind>:<id>`, priority 150, concurrency group `autoreply` (concurrency 1), `externalWrite: false`.
3. `evaluate(trigger)` is one immediate transaction: resolve, count caps, `decideAutoReply`, insert the `auto_replies` row, and on send call `requestAutoSend`. It records one row per trigger (`sent` or `held`), or skips outright (no row): `away_off`, `not_found`, `self`, `not_draft`, `kind_mismatch`, `already_evaluated`.
4. `requestAutoSend` inserts the outgoing row and `ApprovalEngine.recordPolicyApproval` (action `slack.auto_reply`, `decided_by = 'policy'`, audit `approval.policy_approved`, publishes `approval.approved`). The normal `approval.execute` path then runs the send, verification and needs-attention handling. The send run carries `policy_approved` provenance and a send guard (see `security-model.md` 6.1).
5. If the permission gate is shut or the session closed at request time, the transaction is rolled back and a hold (`policy_disabled` / `away_off`) is recorded in a new one.

## Decision order (`decideAutoReply`, pure)

Before the policy runs, `decideAndRecord` holds `missing_context` (the reply cannot be built: missing recipient, conversation, draft or origin text) and `recipient_mismatch` (see below). Then the first failing check wins:

`away_off` > `kind_not_allowed` > `not_priority` > `loop_tag` > `flagged` > `daily_cap` > `thread_gap` > `low_confidence` > `content_secret` > `content_internal_url` > `content_promise`.

- **Priority person:** `high` or `critical` in `people_priority_settings`.
- **Loop guard:** `loop_tag` when the incoming text contains the tag (case-insensitive, whitespace-collapsed, entities decoded) or the candidate text already carries it.
- **`flagged`:** an acknowledgement is held when its message has an open `warning`-or-higher flag. A follow-up is held when an open `warning`-or-higher flag touches the drafting run (`claudeRunId`), the origin message, or (stalled) any source message of its commitment.
- **Caps:** at most `autoReply.maxPerPersonPerDay` rows with `decision = 'sent'` to the recipient in the rolling 24 h; no `sent` row in the same conversation and thread within `autoReply.minMinutesBetweenInThread` (in an `im` the gap is per conversation, since a thread there reaches the same person). Count and insert share one transaction in a concurrency-1 group, so they cannot race.
- **Confidence:** acknowledgements have none (fixed text). Others need `confidence >= autoReply.minConfidence`; null counts as below. A low-confidence `followup_question` with an origin message enqueues an acknowledgement for that message in the same transaction (`autoreply:acknowledgement:<messageId>`, shared with the urgent trigger, so it is deduplicated); the draft stays in Needs you. A low-confidence `stalled_reminder` is only held. Acknowledgements replace low-confidence follow-up questions only.
- **`recipient_mismatch`:** in an `im` the recipient must be the DM partner (the first non-self sender, the inbox rule). A DM with an unknown partner or unknown self id holds.
- **`policy_disabled`:** the effective permission for `slack.auto_reply` is no longer `policy_gated` (the user tightened it). The auto-reply is held and never pends for manual approval.

## Content checks (`content-checks.ts`, pure)

Run on the candidate text before the tag is added; a match holds. Deliberately conservative: a false hold costs little.

- **secret:** `xox[abprs]-`, `sk-` + 16 alphanumerics, `AKIA...`, `gh[pousr]_...`, private-key headers, `password|passwd|secret|token|api_key` followed by `:` or `=`, uppercase env assignments (`NAME=value`), and any 40+ character token-like run (plain URLs without query or fragment are exempt from the run check).
- **internal URL:** `localhost`, `127.*`, `10.*`, `192.168.*`, `172.16-31.*`, `[::1]`, `*.local`, `*.internal`, a URL with a non-default port, or `host.tld:port`.
- **promise:** `I will`, `I'll`, `we will`, `we'll`, `I promise`, `guarantee`, `by today|tonight|tomorrow|eod|eow|<weekday>|next week`, `deadline`, `I've/I have approved|decided`, `approved`, `go ahead and`, and dates such as `5 Dec` or `Dec 5`.

Known gaps are in `docs/superpowers/plans/2026-11-06-phase-6b-followups.md`.

## Tag

`withAutoReplyTag(text) = text.trimEnd() + "\n\nSent using @claude"`, added in `decideAndRecord` just before `requestAutoSend`. `AUTO_REPLY_TAG` lives in `packages/contracts`; `requestAutoSend` throws `MissingAutoReplyTag` if the text does not end with it. The model never sees or writes it. There is no `autoReply.tag` setting.

## Away off

The user's return wins. Anything not yet spawned is cancelled by three checks, all using the same `autoSendBlock` (away off, or the auto-reply's session no longer the open one; or the gate shut):

1. the executor's `revalidate` (approval is revoked, auto-reply held);
2. the claim transaction (`pending` to `sending`) re-check;
3. `beforeSpawn` (`RunOptions`, passed through `SendOptions`): checked after the Claude slot is acquired, just before spawn. A false return (or a throw) fails the run with `cancelled_before_spawn` and `details.notSpawned`.

A cancelled send ends as outgoing `failed` / `cancelled_away_off` (or `cancelled_policy_disabled`), the `auto_replies` row becomes `held` with reason `away_off` (text cleared) and `autoreply.held` is published. A send that has already spawned is allowed to finish; `setAway(false)` never cancels a `sending` row.

## Records and digest

`auto_replies(id, session_id, kind, recipient_slack_user_id, conversation_external_id, thread_ts, source_message_id, followup_id, decision 'sent'|'held', reason, text, outgoing_id, approval_id, created_at)`; `away_sessions(id, started_at, ended_at, dismissed_at)`. Migration `0013_away_mode.sql`. Text is kept only on sent rows and expires with message retention; a held row keeps no text (the draft is in its follow-up).

`decision = 'sent'` is the policy verdict. Delivery is the outgoing status: a user revoke or expiry leaves `sent`, and caps count it. `autoreply.sent {autoReplyId}` is published when the outgoing message first reaches `sent_unverified` or `sent`, not at decision time.

`GET /api/away/digest` returns the most recently ended, undismissed session as `{ session, sent, held }`, or `null`. Views carry recipient name, kind, conversation label, thread, time, reason and `outgoingStatus` (delivery is derived from it); never reply text. `POST /api/away/digest/:sessionId/dismiss` returns 204; 404 for an unknown or still-open session. Dismissing an already dismissed session also returns 204.

## Settings

| Key | Default |
|---|---|
| `autoReply.awayMode` | `false` (written by `setAway`, not the settings page) |
| `autoReply.allowedKinds` | all four kinds |
| `autoReply.maxPerPersonPerDay` | 3 |
| `autoReply.minMinutesBetweenInThread` | 30 |
| `autoReply.minConfidence` | 0.75 |

Permission: `slack.auto_reply` defaults to `policy_gated`, which only `recordPolicyApproval` accepts. An override can tighten it (which holds auto-replies as `policy_disabled`) but never loosen it.

## Events and routes

Emitted: `away.changed {on}`, `autoreply.sent {autoReplyId}`, `autoreply.held {autoReplyId, reason}`. Consumed: `message.urgent_detected`, `followup.draft_created`. Routes: `GET /api/away`, `PUT /api/away`, `GET /api/away/digest`, `POST /api/away/digest/:sessionId/dismiss`. Audit and events carry ids and fixed reasons only, never text.

## Tests

`apps/api/test/modules/auto-reply-service.test.ts`, `test/routes/away.test.ts`, `test/integration/away-autoreply-e2e.test.ts`, the send guard in `test/integrations/send-guard.test.ts`. The real-CLI guard proof is `scripts/dev/hook-smoke.ts`.
