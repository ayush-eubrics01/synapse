# Phase 6b: Follow-ups

Phase 6b (away-mode auto-replies, ADR-033) is built. This file records the proof on the real CLI, the rulings made during the build, and the items deliberately left open, so they survive after the review workspace is deleted. Design: `docs/superpowers/specs/2026-11-06-phase-6b-away-mode.md`. Module doc: `docs/modules/auto-reply.md`.

## Entry gate J1-J5

- **J1** (provenance): done. `policy_approved`, validator rule K, `recordPolicyApproval` for `slack.auto_reply`.
- **J2** (send guard): done. Per-run PreToolUse hook with canonical normalised input sha256, tool-name check, `|| exit 2`, `disableAllHooks: false`.
- **J3** (real-connector verification): closed in Phase 6 follow-ups.
- **J4** (caps and loop guard): done. Rolling 24 h per recipient, thread gap 30 min (per conversation for `im`), loop guard on incoming and candidate text, tag appended by code.
- **J5** (digest): done. Latest ended undismissed session; delivery derived from the outgoing status.

## Hook smoke result (2026-11-06)

`bun scripts/dev/hook-smoke.ts` on the real CLI: the deny run was blocked (wrong hash, no successful tool result for `slack_search_users`), and `--allow` (matching hash) was allowed through. The CLI honours hooks supplied through `--settings` with `--setting-sources user`. The script is read-only and can never send. Residual: a hook timeout (10 s) may let the call proceed; the after-the-fact argument check (`argument_mismatch`, high flag, needs attention) is the backstop.

## Rulings

- Away off cancels anything not yet spawned (revalidate, claim, `beforeSpawn` giving `cancelled_before_spawn`, outgoing `cancelled_away_off`, auto-reply held `away_off`). A spawned send finishes; `setAway(false)` never cancels a `sending` row.
- `auto_replies.decision = 'sent'` is the policy verdict; delivery is the outgoing status. A user revoke or expiry keeps `sent`, and caps count it.
- A shut permission gate (`slack.auto_reply` tightened) holds as `policy_disabled`; it never falls back to manual approval.
- Followups are held `flagged` when an open warning-or-higher flag touches the drafting run, the origin message, or (stalled) the commitment's source messages.
- In a DM the recipient must be the DM partner; an unknown partner holds (`recipient_mismatch`).
- Acknowledgements replace low-confidence follow-up questions only. They depend on `message.urgent_detected`, which is published only for levels in `urgency.notify.levels`; removing `high` there disables high acknowledgements.
- The tag is the `AUTO_REPLY_TAG` constant; ADR-033's `autoReply.tag` setting was not built.
- Dismissing an already dismissed digest returns 204 (404 only for an unknown or still-open session). The web client treats 204 as no body (`dismissAwayDigest` resolves `void`).

## Final-review rulings (2026-11-06)

- Acknowledgements only for messages addressed to the user: an `im` or `mpim`, a `<@SELF>` mention (labelled or escaped forms too), or the user posted earlier in the same thread. Otherwise `not_addressed`.
- `before_session` (the source or origin message predates the open session) and `already_answered` (the user posted at or after it in its thread; anywhere in an `im` or `mpim`) for acknowledgements and follow-up questions. Stalled reminders are exempt (no source message). A follow-up question without an origin message holds as `missing_context`. An unknown self id holds.
- Migration 0014: `followups.suspected_injection` and `followups.context_message_ids`, written by the stalled and spec-clarity drafting workers. `injection_suspected` when set; `flagged` also covers an open warning+ flag on any context message. Null context ids (pre-0014 rows) are not checkable and keep the other checks. Index on `auto_replies.outgoing_id`.
- Content checks: `content_link` and `content_mention`; order secret, internal URL, link, mention, promise. They run on every candidate; the fixed acknowledgement passes by construction.
- Staleness (M8): `autoReply.maxSendDelayMinutes` (default 15). Revalidate, claim and `beforeSpawn` cancel an older auto-send exactly like `away_off`, reason `stale`, outgoing `cancelled_stale`.
- Retention: the Slack retention job also nulls `auto_replies.text` older than the cutoff, blanks the text of `sent`/`failed` outgoing messages (to `''`; the column is NOT NULL) and nulls the draft of `sent`/`discarded`/`failed` follow-ups older than the cutoff (all by `created_at`). Non-terminal rows are untouched.
- Cancellation endings: on the revalidate path the approval ends `revoked`; on the claim and `beforeSpawn` paths it ends `failed`.
- A failed check publishes `autoreply.held` and leaves the follow-up a plain draft (no `autoreply.skipped`, no extra approval-queue entry), recorded in ADR-033 Deviations.

## Deferred or parked

- `code_answer` has no producer until Phases 9-10 (repository registry and Engineering Brain).
- Per-person kind toggles (out of scope in the spec).
- Approving from a phone (OQ-2).
- Content checks:
  - `HOST_PORT` also holds `file:line` such as `foo.py:123`; tune before `code_answer` exists.
  - The month pattern `may` gives false positives ("may 5").
  - `password is X` and `Bearer <token>` are not caught.
- If `beforeSpawn` throws, the send ends `not_started` while the auto-reply keeps `decision = 'sent'`.
- A bad-payload revalidate strands the approval and row until expiry.
- `revokeReason` is not filtered on the actor.
- No test covers `recipient_mismatch` for the acknowledgement trigger.
- No UI or route to tighten `slack.auto_reply` or change the `autoReply.*` settings (M3). Today's kill switch is away off. Add a settings surface.
- The inbox reads `auto_replies` with raw SQL (M5, a module-boundary leak). Move it behind an auto-reply query.
- After a user resends a message from needs attention, the digest still shows the original outgoing status (M7), not the resend's.
- `outgoing_messages.text` is NOT NULL, so retention blanks it to `''` rather than nulling it. A later migration could make it nullable.

## Small fixes in the docs task

CLAUDE.md hook-smoke line punctuation, the e2e test title for the argument-mismatch case (`needs_attention`), and the digest card title (`1 auto-reply sent`, `<n> auto-replies sent`, via `digestTitle` in `apps/web/lib/away.ts`).
