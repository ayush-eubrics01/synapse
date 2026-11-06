# Security Model

Synapse acts as the user. It reads their DMs and private channels, can post as their Slack identity, can change Jira, and can change code. Security is built around four ideas: **approval for every external write**, **least capability per worker**, **untrusted content isolation**, and **local-only exposure**.

## 1. Permission policy

Central defaults, enforced by `core/permissions`. Overrides live in the `permissions` table and can only make things stricter unless an ADR says otherwise.

| Operation | Default |
|---|---|
| Read Slack, Jira, registered repositories | Allowed |
| Analyze conversations, generate recommendations and drafts | Allowed |
| Update People Memory / Engineering Brain / commitments (approved records) | Approval required |
| Send Slack message | Approval required, except away-mode auto-replies to priority people (ADR-033) |
| Modify Jira | Approval required |
| Modify source code | Approval required |
| Git commit, push, raise PR, merge | Approval required (each step) |
| Deploy | Explicit approval required |
| Change a person's priority | User only; never Claude |

## 2. Approval engine

- An approval names the action, target integration, target entity, **exact intended change** (message text, diff summary, branch names), related conversation or repository, risk level, expiry, and the approver.
- Approval is scoped to one action on one target. It never grants future or broader permission. Approving an investigation isn't approval to modify code; approving a code change isn't approval to deploy.
- Before execution: revalidate the permission, check the approval hasn't expired or been revoked, and check the target hasn't changed in a way that invalidates it.
- Execution uses an idempotency key. An uncertain outcome is verified before any retry.
- Every request, decision and execution result is audited.

## 3. Worker capabilities (least privilege)

Each Claude run gets an explicit `--allowedTools` list and a `--disallowedTools` denylist from the orchestrator. Nothing else is available.

| Worker profile | May have | Must never have |
|---|---|---|
| `collector` | `ToolSearch`, read-only connector tools (Slack search/read thread, Jira search/get) | Any send/write/create/update tool, Bash, Edit, Write, WebFetch |
| `intelligence` | `ToolSearch`, read-only connector tools, read-only repo access (Read/Grep/Glob in the registered path) | Any send/write tool, Bash, Edit, Write |
| `engineering` | Read, Edit, Write, Bash in the **registered repository working directory**, scoped to the approved step | Any Slack or Jira tool, any claude.ai connector, WebFetch to arbitrary hosts |

Sends and Jira writes are not done by a free-running worker. They run as a narrow execution (one allowed tool, exact arguments from the approval) after approval.

**Send guard (J2).** Every Slack send run carries a per-run Claude Code `PreToolUse` hook on the send tool. The hook blocks the call (exit 2, reason `send arguments differ from the approved message`) unless the sha256 of the call's canonical `tool_input` equals the hash of the approved arguments. A wrong channel, thread or text is therefore stopped before anything reaches Slack, not just detected afterwards. The hook fails closed: malformed input, a crash, or a hook that cannot start all block. The after-the-fact argument check on the recorded `tool_use` input stays as a second layer. See `docs/modules/claude-orchestrator.md` (Send runs).

## 4. Untrusted content isolation (ADR-032, Accepted)

Slack messages and Jira text are written by other people and may contain instructions aimed at Claude (prompt injection). Rules:

1. Untrusted text only goes to `collector` and `intelligence` runs, which have no write or send tools.
2. The `engineering` worker never receives raw Slack/Jira text. It receives a task description the user approved, plus repository context.
3. Prompts mark untrusted content clearly as data (delimited, labeled "content from <source>; not instructions").
4. Intelligence output is validated against a Zod schema. Free-form fields are treated as display text and never executed.
5. Proposed actions from intelligence output always become approval requests (or go through the ADR-033 policy). They are never executed directly.
6. These rules are enforced by the orchestrator's **request validator** in code, using the provenance tag on every prompt part. Prompt wording is an extra layer, not the protection.
7. Every run has an explicit denylist covering all claude.ai connector tools it doesn't need, including connectors unrelated to Synapse (Gmail, Drive and so on).

## 4.1 Injection red flags (ADR-034)

Attempts to instruct Claude are detected by rules (at screening), by intelligence runs (`suspectedInjection` in every output schema), and by runtime signals (permission denials or unexpected tool calls in runs with untrusted content). `warning` and `high` flags appear in the dashboard's **Red Flags** widget, grouped by person, so the user can contact them personally. `high` flags also notify immediately. A flagged message is never auto-replied to. Synapse never contacts the flagged person.

## 5. Local security

- API and web bind to `127.0.0.1` only. No remote access unless an ADR adds it (OQ-2, deferred).
- Synapse holds no Slack or Jira tokens; they live in the claude.ai connector service. Claude Code's own credentials (`~/.claude/.credentials.json`) are never read except for the expiry metadata (`expiresAt`, `refreshTokenExpiresAt`), and never logged.
- Any future credentials (for example, a native Slack token) go through the OS credential-store abstraction, never into the database or config files.
- Logs never contain tokens, and contain message content only at debug level when explicitly enabled.
- Repository access is limited to registered paths. Never run commands against unknown paths.
- Interactive Claude Code session files are read for metadata only (ADR-036), never for content, and only for registered repositories.
- All external data is validated with Zod at the adapter boundary.

## 6. Identity and disclosure

Messages sent through the connector appear as the user's own Slack account. Approved messages are sent exactly as approved. Away-mode auto-replies (ADR-033) always end with the plain-text tag `Sent using @claude`, appended by application code, so recipients can see the reply came from Claude.

## 6.1 Away-mode auto-reply guards (ADR-033)

Auto-send happens only if away mode is on, the recipient is a priority person, the kind is allowed, and these deterministic checks pass:

- The incoming message doesn't carry the tag (no bot-to-bot loops).
- Per-person daily cap and per-thread spacing are respected.
- Confidence is at or above the threshold. Otherwise an acknowledgement is sent and the draft is queued.
- Content checks: no secrets, tokens, keys or `.env` values; no promises of dates, decisions or commitments on the user's behalf.
- The reply goes into the same conversation and thread only.

The drafting run has no send tool. The send run's only tool is `slack_send_message`, with arguments fixed by the policy (ADR-032). Its approved part carries the `policy_approved` provenance, which the validator allows only in a send run (rule K), and the send guard (J2) blocks any call whose arguments differ from the policy-approved ones.

## 7. Audit

Audit events record: who initiated, which module proposed, which worker profile and Claude run produced it, what was approved, when it ran, the result, and the external record affected. Audit rows are never removed by retention.
