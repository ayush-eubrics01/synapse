# ADR-033: Away-Mode Auto-Replies to Priority People

- **Status:** Accepted
- **Date:** 2026-11-05
- **Source:** User decision resolving OQ-1 (requirements 5c, 5e, 5f)

## Context

ADR-013 requires approval for every external write, including Slack messages. Approvals happen on the local dashboard only. So when the user is away, delivery people and colleagues wait for answers that Synapse could give from the code (UR-5c), clarifying questions don't get asked (UR-5e), and stalled items aren't chased (UR-5f).

The user decided that, for selected people and message kinds, Synapse may send without approval while the user is away, with a visible tag.

## Decision

Synapse auto-sends a Slack reply **without approval** only when **all** of these hold:

1. **Away mode is on.** The user switches it on and off from the dashboard. While it is off, every reply is a draft for approval, as in ADR-013.
2. **The recipient is a priority person.** The person who wrote the message being answered, or the person being reminded, has a manually set priority in People Memory (`people_priority_settings`). Everyone else gets a draft that waits for the user.
3. **The message is an allowed kind:**
   - `code_answer`: answer to a question about the user's projects, from registered repositories and the Engineering Brain (UR-5c)
   - `stalled_reminder`: reminder about a commitment stuck on that person (UR-5f)
   - `followup_question`: clarifying questions about an unclear task or bug report (UR-5e)
   - `acknowledgement`: short note that the user is away and the message has been noted (urgent messages)
4. **Deterministic policy checks pass** (in application code, not in the model):
   - the incoming message doesn't itself carry the auto-reply tag (prevents bot-to-bot loops)
   - the incoming message has no open `warning` or `high` security flag (ADR-034)
   - per-person daily cap not exceeded (default 3) and at most 1 auto-reply per thread per 30 minutes
   - the draft's self-reported confidence is at least the threshold. Otherwise send an `acknowledgement` instead and queue the full draft for approval
   - content checks pass: no secrets, tokens, keys, `.env` values or internal URLs flagged as sensitive; no promises of dates, decisions or commitments on the user's behalf
5. The reply goes into the **same conversation and thread** as the message it answers. It never starts a new conversation or posts to a different channel.

Every auto-sent message ends with this tag, appended by application code (never by the model):

```text
Sent using @claude
```

The tag is sent as plain text, not a Slack mention.

### Execution (compatible with ADR-032)

```text
intelligence run (reads untrusted Slack text, NO send tool) ─▶ draft + kind + confidence (Zod-validated)
        ─▶ AutoReplyPolicy (deterministic: away mode, priority, kind, caps, loop check, content checks)
        ─▶ send run: allowedTools = [mcp__claude_ai_Slack__slack_send_message] only,
                     exact channel / thread_ts / text from the policy decision
        ─▶ verify sent ─▶ record in auto_replies + audit ─▶ autoreply.sent
```

If any check fails, the draft goes to the approval queue (`autoreply.skipped` with the reason).

### Return digest

When away mode is switched off, the dashboard shows a digest of everything auto-sent and everything held for approval while the user was away.

## Consequences

- **Positive:** priority people get timely answers and nudges while the user is out. Recipients can see the reply came from Claude.
- **Negative:** a wrong or poorly judged answer reaches a colleague under the user's Slack identity. Mitigated by the priority-only scope, away-only activation, confidence fallback, content checks, caps and the digest.
- **Residual risk:** a priority person's message could try to steer the drafting run (prompt injection) into revealing repository details. The drafting run can only read, and content checks run before sending. Accepted as a deliberate trade-off.
- ADR-013 now has a defined exception. All other external writes still need approval.
- OQ-2 (approvals from a phone) is less pressing. Non-priority drafts simply wait until the user returns.

## Configuration

| Key | Default |
|---|---|
| `autoReply.awayMode` | `false` (toggle) |
| `autoReply.allowedKinds` | `code_answer, stalled_reminder, followup_question, acknowledgement` |
| `autoReply.tag` | `Sent using @claude` |
| `autoReply.maxPerPersonPerDay` | 3 |
| `autoReply.minMinutesBetweenInThread` | 30 |
| `autoReply.minConfidence` | 0.75 (proposal; tune with use) |

## Implementation (Phase 6b)

Built in Phase 6b; details in [`docs/modules/auto-reply.md`](../../modules/auto-reply.md).

- **J1, provenance.** A policy-authorised text carries the new provenance `policy_approved`, never `user_approved`. Validator rule K allows it only in a send run. `ApprovalEngine.recordPolicyApproval` approves `slack.auto_reply` (permission default `policy_gated`) with `decided_by = 'policy'`; any other action throws.
- **J2, send guard.** Every send run (user and policy) carries a per-run PreToolUse hook that blocks the send call unless its canonical arguments hash to the approved ones. Any run that allows a connector write tool must carry the guard. Real-CLI proof on 2026-11-06: `hook-smoke` blocked a wrong hash and `--allow` let the matching call through. Residual risk: if the hook times out the call may proceed, so the after-the-fact argument check stays as the backstop.
- **Caps.** Rolling 24 h per recipient (not a calendar day), counted from `auto_replies` rows with `decision = 'sent'`, plus a 30 minute gap per thread (per conversation for DMs).
- **Acknowledgement.** A fixed first-person template with no model text. It replaces low-confidence follow-up questions only; a low-confidence stalled reminder is just held.
- **Extra checks (final review).** An acknowledgement goes only to a message addressed to the user (a DM or group DM, a mention of the user, or a thread the user posted in before it). Nothing is sent about a message from before the away session or one the user already answered. A draft is held when its drafting run suspected injection, or when an open warning-or-higher flag touches any message fed into its prompt. Drafts that contain a link or mention people or a group are held. An auto-send not started within `autoReply.maxSendDelayMinutes` (default 15) of its decision is cancelled as `stale`.
- **Deviations from this ADR.** The tag is the `AUTO_REPLY_TAG` constant, not the `autoReply.tag` setting listed above. `code_answer` is produced from Phase 10b on (`docs/modules/code-answers.md`): the deterministic policy decides it with the extra holds `not_answerable`, `unverified`, `low_confidence`, `content_code_block` and `code_answer_review`. Unlike the other kinds, a `code_answer_review` hold **creates a user approval** (a normal `slack.send` approval with the exact answer and no tag), because `codeAnswer.away.autoSend` is off by default and the answer is useful to the user even when it is not auto-sent; the other kinds still leave only a draft. For that kind `daily_cap` and `thread_gap` do not block the review approval while `autoSend` is off (they bound unapproved sends), and the user may request the send again after an earlier one was rejected, expired or cancelled before spawn. When a check fails, Synapse publishes `autoreply.held {autoReplyId, reason}` and leaves the follow-up as a plain draft in Needs you; there is no `autoreply.skipped` event and no extra approval-queue entry (the draft is sent, if at all, through the normal user approval).
- Follow-ups batch 3: the five limits are editable, only towards stricter values (ranges in `docs/modules/auto-reply.md`).

## Related

- [ADR-013](ADR-013-manual-approval-for-external-writes.md): the approval rule this amends
- [ADR-032](ADR-032-untrusted-content-isolation.md): the drafting run has no send tool; the send run receives no untrusted text
- [ADR-014](ADR-014-people-memory-requires-approval.md): priority is set by the user only
- [`auto-reply` module](../../modules/auto-reply.md)
- `../../architecture/security-model.md`, `../../modules/claude-orchestrator.md`, `../../modules/commitments.md`, `../../modules/urgency-engine.md`
