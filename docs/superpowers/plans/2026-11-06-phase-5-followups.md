# Phase 5: Follow-ups and Phase 6 Entry Gate

Phase 5 (People Memory) passed per-task reviews, a final whole-branch review, one final fix wave and a controller smoke run. This file keeps the controller rulings and the items deliberately deferred, so they survive after the review workspace is deleted.

## Smoke result

Run on 2026-11-06 with the real CLI and Slack connector, on a temp DB that was deleted afterwards. Desktop popups were off, the initial model was overridden to haiku, and the output was counts only.

- **`--pages 1`:** 20 messages, too few to infer the user's identity. The run printed `identity: none` and exited cleanly, as designed.
- **`--pages 3`:**

| Messages | Candidates | History items | Observations kept | Dropped by evidence rules | Evidence rows | Recommendation | Run |
|---|---|---|---|---|---|---|---|
| 60 | 4 | 39 | 10 (4 context, 4 communication, 2 guidelines) | 4 | 24 | created (pending approval) | collect ok, initial ok |

This confirmed:
- identity suggestion and ranking work on real data;
- history selection works;
- one haiku run passed the real validator;
- the output passed strict schema validation;
- evidence validation dropped unsupported observations;
- the recommendation, evidence rows and approval request were stored atomically.

## Product decisions made during the phase (user may revisit)

- **You choose who is evaluated.** Discovery only ranks contacts. Claude never profiles someone you did not pick. Unknown senders can be *suggested*, and you accept or dismiss each suggestion.
- **Evidence or nothing.** Every observation must cite messages Claude was actually given. Uncited and low-confidence observations are dropped. A proposal identical to one you rejected is never shown again.
- **Profile changes need approval.** Updates arrive as a diff against a specific version. If you approve an older diff after a newer one, the older one is superseded, never merged blindly.
- **A failed apply can be retried.** Approval failures are final (Phase 2 engine rule), so a failed profile write offers a Retry, which creates a fresh approval.
- **Deferred:**
  - the §6.5 post-send profile flow (needs sending): Phase 6;
  - group and channel profiles (ADR-020);
  - G4, the red-flag pattern review with real data (needs a session with the user).

## Phase 6 entry gate (Commitments and follow-ups, drafts and sending)

All five items are done in Phase 6 (status column).

| # | Item | Why it matters for Phase 6 | Status |
|---|---|---|---|
| H1 | **Guidelines in send runs.** Approved guidelines are model paraphrases of untrusted Slack text, labelled `user_approved`, and the validator lets `user_approved` content into a send-capable run. Before away-mode auto-replies (ADR-033) or any send uses guidelines, either keep them out of send runs or require the user to review the exact outgoing text at approval time | Prompt injection must not reach a send through the profile | Done: guidelines appear only in drafting runs; a send run's only `user_approved` part is the approved message; the user approves the exact text |
| H2 | **The §6.5 post-send profile flow.** Start a profile recommendation only after a verified successful send (`followup.sent`). A failed or cancelled send never creates one | The spec requires it, and it was deferred from Phase 5 | Done: consumer `people.post_send` on `followup.sent` stores a `suggest_evaluation` (it also fires for `sent_unverified`, where the send tool ran) |
| H3 | **A dedicated needs-attention error kind.** Approval bookkeeping failures reuse `parse_failed` today | Send approvals will surface these to the user | Done |
| H4 | **Approval UX for sends.** The send approval must show the exact text, recipient and conversation. Expiry and revoke must be handled end to end, as people approvals now are (R6) | Hard rule 2 | Done: the approvals view shows exact text, recipient and conversation; revoke, reject and expiry return the draft |
| H5 | **Split the large worker files** (`workers/people.ts`, `workers/urgency.ts`) before adding commitment jobs | Maintainability | Done: `workers/people/`, `workers/urgency/` and `workers/commitments/`, one file per job |

## Deferred minors (polish)

- **Approvals:** bookkeeping-failure parking reuses the `parse_failed` error kind; add a dedicated needs-attention kind. The engine stores an executor's `e.message`, so executors must keep throwing content-free messages.
- **People:**
  - The update baseline is the newest *cited* evidence, so one new message can re-send up to 150 messages; record the newest message seen.
  - Contacts whose messages have all expired are rescanned on every run.
  - `selectHistory` has no sender index (about 110 ms on 100k messages).
  - `workers/people.ts` and `workers/urgency.ts` are large; split them by job.
- **Security flags:** no test covers activating an inactive, higher starter version. Rolling back to a lower custom rule version is undone by the next restart; document it or add a pin.
- **Contracts and DB:** no behavioural test for evidence `ON DELETE SET NULL`. Strictness and bounds tests are thin for the update and unknown schemas.
- **Web:** no DOM click test. Decisions are tested through `decisionFor` and render assertions.

## Controller rulings made during execution (Phase 5)

| ID | Ruling |
|---|---|
| R1 | People runs attribute flags narrowly: runtime flags go to the evaluated person's newest provided message. AI flags go to the message containing the quote, else the newest |
| R2 | The evidence `observation_key` is `<section>.<key>` |
| R3 | The people executor is one all-or-nothing transaction with content-free errors. `retryApply` creates a fresh approval after a failed apply |
| R4 | Pending `suggest_evaluation` recommendations can be dismissed |
| R5 | Flag targets are the evaluated person's newest message, never the user's own |
| R6 | Recommendations whose approval is revoked, rejected, expired, failed or stale can be discarded. Revocations are consumed. Decision recording is traced |
| R7 | `profile_exists` guard. Temporary tracking is limited to senders who interact with the user, with a TTL-based cutoff. Omitted contacts are stamped. Removals carry evidence. The approval must match the recommendation. Docs drift fixed |
