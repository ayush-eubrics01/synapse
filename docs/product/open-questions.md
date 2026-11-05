# Open Questions

Unresolved product and technical questions. Don't implement behaviour that depends on an open question without the user's decision. When a question is resolved, record the answer here, update the affected docs, and add or update an ADR.

| ID | Question | Blocks | Status |
|---|---|---|---|
| OQ-1 | Can Synapse send messages without approval while the user is away? | UR-5c, UR-5f sending | **Resolved** (ADR-033) |
| OQ-2 | How does the user approve actions when away from the machine? | Non-priority drafts while away | Deferred (less pressing after ADR-033) |
| OQ-3 | In the Git workflow, which branch does the PR come from and target? | Engineering task PR step | **Resolved** (ADR-030) |
| OQ-4 | Does the Claude Code refresh-token expiry slide forward on refresh? | Unattended operation | Open (re-check credentials metadata) |
| OQ-5 | Does UR-7 include monitoring the user's interactive Claude Code sessions? | Orchestrator scope | **Resolved** (ADR-036) |
| OQ-6 | What are the sustained Slack rate limits through the connector? | Backfill pacing | Open |
| OQ-7 | Should a local bot filter back up Slack's `include_bots: false`? | Inbox quality | Deferred (ADR-027) |

## OQ-1 — Away-mode replies vs. the approval rule

**Resolved 2026-11-05 (user decision, ADR-033):** auto-send without approval only when away mode is on (dashboard toggle) and the recipient is a priority person. Allowed kinds: answers from the code, stalled-item reminders, follow-up questions, acknowledgements. Every auto-sent message ends with `Sent using @claude`. Everyone else gets drafts for approval. Guards: loop check, daily caps, confidence fallback, content checks, same-thread only, digest on return.

Original question, for history:

UR-5c (answer delivery people from the code while away) and UR-5f (remind people about stalled items) both mean sending Slack messages. The architecture requires approval for every send (ADR-013). With approvals only on the local dashboard, people still wait until the user is back.

Options:

1. Auto-send for selected people and question types, with a visible "AI-drafted on behalf of …" note.
2. Approve from the phone (needs OQ-2).
3. Drafts only. Simplest and safest, but drops the "don't make them wait" goal.

Also relevant: the connector posts as the user's own Slack identity, so colleagues will see these messages as coming from the user.

## OQ-2 — Approvals while away

**Deferred:** after ADR-033, only non-priority drafts and other external writes wait for the user. Revisit if that waiting becomes a problem.


The backend binds to localhost with no remote access (security model). Approving from a phone needs some remote channel: a tunnel, a push service, or Slack itself (for example, the user reacting to a DM from Synapse). Each option widens the attack surface and needs a security review.

## OQ-3 — PR source and target

**Resolved 2026-11-05 (user decision, ADR-030):** push the updated local parent branch to `origin`, then open the PR from `origin/<parent>` into `upstream/<parent>`.

Original question, for history:

The workflow is: task branch → `git pull origin <parent>` && `git pull upstream <parent>` → merge task branch into the parent locally → raise PR → merge. Unclear: is the PR the local parent branch pushed to `origin` and opened against `upstream`, or something else? This decides what gets pushed where, and what the approval for the push/PR step shows.

## OQ-4 — Refresh-token lifetime

During Phase 0, `refreshTokenExpiresAt` was about 7 days out. If it is fixed, the user must re-login weekly. The health monitor warns at < 48 h either way (`runtime-design.md`).

## OQ-5 — Scope of "admin of my Claude Code"

**Resolved 2026-11-05 (ADR-036):** observe interactive sessions from metadata only (repo, branch, title, activity, PR links), never read content or control sessions. Used to pause background work while the user is active, and to show work in progress and session PRs.

Original question, for history:

Either Synapse only manages jobs it launches (current design), or it also observes the user's own interactive sessions (for example, `~/.claude/projects` transcripts) to track what's in progress.

## OQ-6 — Sustained Slack rate limits

Phase 0 tested a 5-page burst with no errors. A 90-day backfill is about 115–270 pages. The collector must pace and back off on `rate_limited`, and record what it observes.

## OQ-7 — Local bot filter

Phase 0 couldn't prove `include_bots: false` works, because no bot messages appeared in the tested windows. The user accepted relying on Slack. If bot messages show up, add a filter (sender without a `U…` ID, plus a user-managed blocklist).

## Resolved decisions (for reference)

- One engineering task at a time; global lock until PR merge or cleanup (ADR-030).
- Synapse does not need to isolate itself from the user's own work in the same checkout (user decision, 2026-11-05).
- Away-mode auto-replies to priority people with the tag `Sent using @claude` (ADR-033, resolves OQ-1).
- PR from `origin/<parent>` into `upstream/<parent>` (ADR-030, resolves OQ-3), with a branch confirmation step and a per-repo branch registry including deployment environments (ADR-035).
- Untrusted content isolation accepted, enforced by the orchestrator's request validator (ADR-032).
- Prompt-injection attempts shown as red flags per person on the dashboard (ADR-034).
- Collector worker profile accepted (ADR-031).
- Interactive Claude Code sessions observed via metadata only (ADR-036, resolves OQ-5).
