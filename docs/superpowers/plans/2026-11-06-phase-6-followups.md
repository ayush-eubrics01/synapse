# Phase 6: Follow-ups and Phase 6b Entry Gate

Phase 6 (commitments, follow-ups and approved sending) passed per-task reviews, a final whole-branch review, one final fix wave and controller smoke runs. This file records the controller rulings and the items that were deliberately deferred, so they survive after the review workspace is deleted.

## Smoke result

Runs on 2026-11-06 used the real CLI and Slack connector on a temp DB, which was deleted afterwards. The message sink throws if called, extraction ran on haiku, and output was counts only.

| Run | Messages | Batch | Candidates | Dropped | Created |
|---|---|---|---|---|---|
| 1 | 60 | 40 | 10 | 10 | 0 |
| 2 (after fix 1) | 60 | 40 | 8 | 7 | 1 (theirs) |
| 3 (after fix 2, with drop reasons) | 60 | 40 | 9 | 8 (low_confidence=3, not_involving_user=5) | 1 (theirs) |

The real run found two bugs that fixture tests had missed, both fixed before the PR:
1. The model was never told the user's own Slack id. Owner and counterparty must be Slack ids, so every commitment involving the user failed validation. The confirmed `slack.selfUserId` now goes into the trusted system part.
2. In a 1:1 DM, a commitment with only an owner had no counterparty. The user is now an implicit DM counterparty, though not an implicit owner, and the counterparty is inferred.

Content-free drop-reason counts were added to the job result and the smoke output. The remaining drops are by design: low confidence, and commitments between other people.

**Real test send (J3): done on 2026-11-06, run by the user.**

- The approved send was delivered and ended as `sent_unverified`.
- `findSent` failed to verify it at first. Slack autolinks a typed URL as `<https://host/path|host/path>`, so the label lacks the scheme and the decoded text differed from the approved text.
- Fixed by removing the `http(s)://` prefixes from both sides before comparing. There is a regression test with the real format.
- Re-running the real `findSent` on the delivered message then returned `true`.

J3 is closed.

## Product decisions made during the phase (the user may revisit)

- **Every Slack message Synapse sends needs your approval of the exact text.** The approval shows the text, the recipient and the conversation. The send run can only call the send tool, and code checks that the model used exactly the approved arguments.
- **Uncertain sends are never retried automatically.** If Synapse can't tell whether a message went out, it marks it "needs attention" and checks Slack. You then decide: mark it sent, resend or discard.
- **Commitments wait for your review.** A promise never counts as completion. "Looks done" suggestions also wait for you to confirm them.
- **Follow-up placement.** In a DM, a follow-up posts as a new message, unless the conversation was already in a thread. In channels, it replies in the thread.
- **Spec-clarity questions are bounded:**
  - only for requests from the last 24 hours;
  - one open draft per thread;
  - at most 5 per sender per day;
  - never for requests you've already answered, and never for bots.

## Phase 6b entry gate (away-mode auto-replies, ADR-033)

| # | Item | Why it matters for 6b |
|---|---|---|
| J1 | **Text provenance for auto-replies.** An auto-reply's text is model output derived from untrusted Slack text, sent without the user approving the exact text. Decide its provenance tag before it enters a send run: it is `user_approved` today only because the user approved it. Options: a new `policy_approved` provenance that the validator allows only for the auto-reply profile with deterministic content checks, or another explicit ADR-033 mechanism. Do not mislabel it | ADR-032 |
| J2 | **A PreToolUse argument guard** (it needs hooks in the plugin override). Argument mismatches are detected only after the message has gone out (R20). An auto-reply has no human approval in front of it, so prevention matters more there | Auto-sends are unattended |
| J3 | **Verify against the real connector format.** `findSent`'s entity and link decoding (R19) is checked only on fixtures. The controller's real test send must pass before 6b relies on verification | Uncertain auto-sends must be detectable |
| J4 | **Thread-safe caps.** Per-person daily cap, per-thread 30-minute gap, and the loop guard: the incoming message carries the `Sent using @claude` tag. The tag is appended by code, never by the model | ADR-033 |
| J5 | **Return digest.** A list of everything auto-sent and everything held while away, shown when away mode is switched off | ADR-033 |

## Controller rulings made during execution (Phase 6)

| ID | Ruling |
|---|---|
| R1 | `slack_messages.commitments_extracted_at` is added in migration 0009 |
| R2 | `findSent` reuses the verified Slack search (2 pages, self sender, same conversation, normalised text) |
| R3 | A send tool error is `uncertain` unless Slack definitively rejected it, which is detected by a code allowlist |
| R4 | An auth failure that happens after spawn keeps `details.uncertain` |
| R5 | An argument mismatch never returns the draft for re-send. It goes to needs_attention with a high flag and a notification |
| R6 | (Superseded by R7) |
| R7 | Duplicate-send hardening: an in-process in-flight guard, the abort signal passed through the engine to the sink, an execute timeout longer than the collector timeout, late outcomes recorded after a sweep, stranded pending rows resolved, the claim requires an approved approval, a private executor, and a partial unique index on live sends |
| R8 | The DM partner is an allowed owner or counterparty |
| R9 | An hourly extraction sweep |
| R10 | Poison batches are skipped and audited. Completion matching includes `pending_review`. Dedup reuses only non-terminal rows. Candidates that don't involve the user are dropped. `batchMax` is capped at 40 |
| R11 | Follow-up thread placement: top level in a DM, otherwise in the thread |
| R12 | A commitment description is `user_approved` only after explicit acceptance. A no-identity skip clears `stalled_at` |
| R13 | Spec-clarity bounds: 24 hours, one open draft per thread, a sender cap, answered requests skipped, bots skipped |
| R14 | `followup.sent` sets `last_followup_at`. Internal conversation ids are mapped to external ids for sends |
| R15 | `followups.conversation_id` is normalised to the internal id (migration 0012) |
