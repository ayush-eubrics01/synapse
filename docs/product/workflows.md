# Workflows

End-to-end user-visible workflows. Module docs hold the detailed steps; this document shows how modules work together.

## W1 — First-run setup

1. **Runtime:** create the database, run migrations, validate config, register modules.
2. **Claude Code check:** CLI present, logged in, a headless test run succeeds, connectors report `connected` (retrying while `pending`), the `rate_limit_event` is readable, and the auth expiry metadata is readable.
3. **Slack:** run a test search; start the 90-day backfill as a resumable background job (~5 pages per run, checkpoint after every page).
4. **People selection:** list individual contacts seen in the backfill → the user picks people to evaluate → profile recommendations → the user approves → profiles saved. The user sets each person's priority manually.
5. **Jira:** resolve and store `cloudId`; the user sets the backfill scope (JQL); initial sync.
6. **Engineering Brain:** the user registers repository paths → Synapse proposes tracked branch, remotes and deployment environments (for example `flexi-demo`: stage→`stage`, prod→`prod`) → the user confirms → discovery → knowledge recommendations → the user reviews.
7. **Start:** enable schedules, the job processor, notifications and health monitoring.

## W2 — Collection cycle (every 10 minutes by default)

```text
scheduler ─▶ collect job ─▶ orchestrator (collector profile, Haiku)
                               │  slack_search_public_and_private after=<checkpoint>
                               ▼
                         raw tool_results ─▶ parse + validate ─▶ dedup + store
                               │                                     │
                     checkpoint advanced                 message.received events
                                                                     │
                                                     rule screening (no AI)
                                         ┌───────────────────────────┴───────────┐
                                  urgent candidate                          normal
                                         │                                       │
                            urgency assessment job                  batched analysis job
                                         │                        (summaries, commitments,
                              Urgent Inbox + notify                 people recommendations)
```

- If collection finds nothing new, no intelligence job runs. The collection run itself is still one small Claude run (~$0.005 API-equivalent on Haiku).
- If the five-hour quota is above threshold, collection keeps running (it's cheap) but non-urgent analysis is deferred until `resetsAt`. The thresholds are in `claude-orchestrator.md`.

## W3 — Urgent message

1. Screening flags a candidate (incident keywords, blocker language, deadline, high-priority sender plus a time-sensitive signal).
2. An urgency assessment (intelligence worker) returns a level and reason, with the source message as evidence.
3. Critical/High: added to the Urgent Inbox, desktop notification, suggested response drafted.
4. The user acknowledges, edits the draft, or dismisses. Sending goes through W7.

## W4 — Question from someone while the user is away (UR-5c)

1. The message is screened as a question about a known project or repository.
2. The intelligence worker answers from the registered repository (read-only tools) and the Engineering Brain.
3. **Away mode on and the sender is a priority person:** the auto-reply policy checks caps, loop protection, confidence and content (ADR-033). If they pass, the answer is sent in the same thread with the tag `Sent using @claude`. If confidence is too low, an acknowledgement is sent and the full draft is queued.
4. **Otherwise:** the draft goes to the approval queue with its sources.
5. When the user switches away mode off, a digest shows everything auto-sent and everything held.

## W5 — Reported bug or small task (UR-5d)

1. A message or Jira issue is classified as a bug or task, and an engineering task is proposed.
2. If the spec is unclear, follow-up questions are drafted for the reporter (W7) instead of starting work.
3. Investigation (read-only) → analysis and implementation plan → shown to the user.
4. The user approves the plan and **confirms the branch** (ADR-035): repository, environment, parent branch, PR `origin/<parent>` → `upstream/<parent>`, with an option to remember it as the tracked branch. Then the task waits for the **global engineering lock** (ADR-030). The engineering worker receives only the approved task description, never the raw message (ADR-032).
5. With the lock: create the task branch → develop → test → `git pull origin <parent>` && `git pull upstream <parent>` → merge into the parent locally → push the parent to `origin` → PR from `origin/<parent>` into `upstream/<parent>` → merge. Each write step needs approval. A conflict stops the task (NEEDS_ATTENTION).
6. When the user returns, they see the list of small issues, who raised them, and what's ready, then approve or reject the remaining steps.
7. After the PR merges or the task is cleaned up, the lock is released and the next task can start.

## W6 — Commitment and stalled conversation (UR-5f)

1. Analysis extracts a commitment ("I'll check and let you know") with owner, owed-to, source and any due date.
2. The user approves it (or it's auto-recorded as a pending recommendation).
3. When it's due or stale, a reminder goes to the user. A follow-up to the other person is auto-sent with the tag if away mode is on and they're a priority person (ADR-033); otherwise it goes to the approval queue (W7).
4. It closes only on confirmed completion or when the user marks it done.

## W7 — Any external write (send, Jira change, commit, push, PR, merge)

The only exception is ADR-033 away-mode auto-replies, which replace the user decision with a deterministic policy check. Revalidation, idempotency, verification and audit still apply.

```text
proposed ─▶ permission check ─▶ approval request ─▶ user decides
                                                     │
                     rejected/expired ◀──────────────┤
                                                     ▼
                                 revalidate (still allowed? target unchanged?)
                                                     ▼
                                execute (idempotency key) ─▶ verify ─▶ audit
```

An uncertain result (timeout) is verified (for example, `MessageSink.findSentMessage`) before any retry.

## W8 — Jira monitoring

Scheduled JQL sync (cursor pagination, `duedate` requested) → update local issues → detect blockers, stale issues and approaching due dates → link to Slack conversations, commitments and projects → dashboard and notifications.

## W10 — Red flag: someone instructing Claude

1. A message trying to instruct Claude is caught by a rule at screening, by an intelligence run, or by a runtime signal (ADR-034).
2. A security flag is recorded with the person, message link, evidence excerpt and severity.
3. `warning`/`high` show in the Red Flags widget; `high` also notifies.
4. That message is excluded from auto-replies; its draft waits for approval.
5. The user contacts the person personally and marks the flag contacted, acknowledged or dismissed.

## W9 — Retention cleanup (daily)

Find messages older than 180 days → make sure derived records keep their `source_external_ref` → null the content and delete local attachments → record the run in audit.
