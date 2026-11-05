# Urgency Engine and Urgent Inbox

Covers screening and urgency logic. Rules live in `apps/api/src/intelligence/screening`, the assessment prompt and schema in `intelligence/urgency`, and the state in the `inbox` module (`slack_messages.urgency_*`).

## Purpose

Make sure the few messages that need the user now reach them immediately, without calling Claude for every message. It also gives the user a clear view of their priority people (requirement 5b).

## Responsibilities / Non-responsibilities

Responsibilities:

- Cheap rule-based screening of every new message (no AI).
- Contextual urgency assessment by Claude, for candidates only.
- Assigning Critical/High/Medium/Low with a reason.
- Urgent Inbox: notification, context, suggested response or action, acknowledgement and status tracking.
- Routing non-urgent messages to batch analysis.

Non-responsibilities:

- Sending responses or starting engineering work. Suggestions are drafts, and every external action needs approval.
- Setting people priority (People Memory, user only).

## Owned data

Fields on `slack_messages`: `screening` (JSON: matched rules, score), `urgency_level`, `urgency_reason`, `urgency_status` (new/acknowledged/in_progress/resolved/dismissed). Suggested responses are stored as drafts linked to an approval when the user chooses to send.

## Three signals

1. **People priority:** manual priority from `people_priority_settings`.
2. **Message urgency:** production incidents, explicit blockers, immediate deadlines, time-sensitive requests.
3. **Work context:** release blockers, deployment problems, delivery dependencies, work blocking a colleague (uses Engineering Brain milestones and Jira state).

People priority alone never makes a message urgent. It raises screening sensitivity and ordering only.

## Pipeline

```text
message.received
  → rule screening (no AI)
       keywords/patterns (prod, down, outage, urgent, blocker, ASAP, deadline, today, …)
       DM vs channel, mentions of the user, priority person, thread with the user,
       Jira keys of blocked/due issues, upcoming go-live projects
  → security rules scan (security-flags, ADR-034): suspected instructions to Claude → security_flags
  → message.screened {candidate: bool, score, matchedRules, securityFlag?}
       │
       ├─ candidate → urgency.assess (batched within a short window)
       │                → Critical / High / Medium / Low + reason
       │                → Critical/High: Urgent Inbox + notify + message.urgent_detected
       │                                 + suggested response/action (draft)
       │                → Medium/Low: normal processing
       └─ not candidate → batch analysis (commitments, people, brain)
```

## Screening consumer

`ScreeningService` (`modules/inbox/screening-service.ts`) is outbox consumer `inbox.screening` on `message.received` and `message.thread_updated`. Scoring is the pure `screenMessage` (`intelligence/screening/screen.ts`): keyword weights plus context (DM +1, group DM +0.5, mention +1, thread with the user +1, priority high/critical +1, extra attention +1). A candidate needs at least one signal keyword and a score at or above `urgency.candidateThreshold`, lowered by 1 (minimum 1) for priority or extra attention. Priority alone never makes a candidate. Own and expired messages are skipped; candidates older than `urgency.maxAgeHours` are `skip/too_old` (flagged, never assessed). Recent candidates enqueue one `urgency.assess` job per batch-window bucket (`urgency.batch:<bucket>`, priority 200). The `screening` JSON holds rule ids, scores and flags only; re-screening preserves `assessed`, `fallback` and `notified`. The handler never throws: a failure sets `screening.error = true` and logs the message id only. Invalid user-edited keyword regexes are skipped and the `screening-rules` health check reports `degraded`. `message.screened.candidate` carries the raw rule result (same as the stored record), so a `too_old` candidate emits true.

## Assessment job

`registerUrgencyJobs` (`workers/urgency.ts`) handles `urgency.assess` (timeout 360 s). It selects up to `urgency.assess.batchMax` messages with `screening.route = "assess"`, `assessed` false and text present (oldest first), builds the request in `intelligence/urgency/assess-prompt.ts` (system part with the level table, one `untrusted` part per message, `ToolSearch` only) and validates the output: an unknown or duplicate message id fails the run (`incomplete_ai_output`), a missing id gets the rule fallback (`fallback: true`). Each result is written in one immediate transaction (level, reason, `urgency_status = "new"` only if unset, merged `screening`, notification once per message, `message.urgent_detected`, `urgency.suggest_response` job). Any permission denial or tool result other than `ToolSearch` raises runtime security flags for the whole batch (`high` if a write or send tool is involved). Quota or auth deferral notifies critical-rule messages as "Likely incident (not yet assessed)" and rethrows; a terminal failure applies the rule level with the reason "Rule-based (assessment unavailable)". If more eligible messages remain, the next batch is enqueued (`urgency.batch:<jobId>:next`). Notification titles carry the sender and conversation name only, never message text.

## Suggested responses

`urgency.suggest_response` (priority 150, `concurrencyGroup` `urgency.suggest`, timeout 360 s) is enqueued once per Critical or High message (`urgency.suggest:<messageId>`). The handler completes without calling Claude when the message text is expired, the message is no longer Critical or High, or a `message_drafts` row for (message, `suggested_response`) exists. Otherwise it builds the request in `intelligence/urgency/suggest-prompt.ts`: one system part, then up to 10 earlier messages as `untrusted` parts, oldest first (the earlier messages of the same thread, including the thread root, or of the same conversation when there is no thread; expired ones are skipped), then the target message as the last `untrusted` part. Each part is capped by UTF-8 bytes at `floor((100 KiB - 8 KiB) / partCount)`; `ToolSearch` is the only tool. The handler calls the orchestrator, records runtime flags (same detector as assessment), then parses the output; invalid output is `incomplete_ai_output`. The draft goes through `renderExcerpt(draft, 2000)` and is stored as a `proposed` row with the confidence as given and the `claude_run_id`; an AI injection flag is recorded in the same transaction. The draft is display-only: nothing is sent, and the text never appears in logs, events, notifications or audit rows. `InboxStore.expireContent` clears the draft text and sets `content_expired_at` for drafts of expired messages in the same transaction; the row stays.

## Urgency levels

| Level | Meaning | Behaviour |
|---|---|---|
| Critical | Production incident or severe immediate impact | Immediate notification |
| High | Time-sensitive request or important blocker | Immediate notification |
| Medium | Needs attention but can wait | Normal processing |
| Low | Informational or routine | Normal processing |

## Ports used / provided

- `ClaudeOrchestrator`, intelligence profile, for `urgency.assess` and drafting. Message text is untrusted input. The worker has no send or write tools (ADR-032).
- Reads `people`, `jira-tracking` and `engineering-brain` public services for signals 1 and 3.
- `NotificationService` for alerts.

## Jobs

| Job type | Trigger | Profile / model | Idempotency key | Retry |
|---|---|---|---|---|
| `urgency.assess` | candidates from screening, micro-batched (e.g. 2 min window or 10 messages) | intelligence / haiku | `urgency.batch:<bucket>` (follow-ups: `urgency.batch:<jobId>:next`); concurrency group `urgency.assess` | 3; on final failure, fall back to rule level |
| `urgency.suggest_response` | Critical/High result | intelligence / haiku or sonnet | `urgency.suggest:<messageId>` | 3 |

Urgent assessment jobs get high queue priority. The quota gate (ADR-029) may still defer them when the five-hour window is exhausted. In that case the rule-based level is shown with "not yet assessed."

Requirement 5c (answering questions while the user is out): `urgency.suggest_response` uses the **intelligence** profile with read-only access to the registered repository and the Engineering Brain to draft a technical answer. It never uses the engineering profile, which must not see raw Slack text (ADR-032). When away mode is on and the sender is a priority person, the draft goes to the auto-reply policy (ADR-033). Otherwise it waits for approval.

Away-mode acknowledgements: when away mode is on, a Critical/High message from a priority person that can't be answered with confidence gets an `acknowledgement` auto-reply (ADR-033), and the full draft is queued for approval.

## Events

Emitted: `message.screened`, `message.urgent_detected`.

Consumed: `message.received`, `message.thread_updated`, `person.profile_approved` (priority refresh), `jira.issue_blocked`, `claude.job_completed` / `failed`.

## Permissions and approvals

Assess and suggest: allowed. Send a suggested response: approval required. Start engineering work from an urgent message: approval required (goes to `engineering-tasks` as a proposal).

## Failure handling

- Assessment fails or quota blocks it → keep the rule-based screening score, mark it "unassessed", and still notify if the rules indicate a likely incident.
- Invalid AI output → retry; after max attempts fall back as above.
- Notification adapter failure → in-app notification remains; health reports degraded.

## Configuration

| Key | Default |
|---|---|
| `urgency.rules.keywords` | default list, user-editable |
| `urgency.assess.batchWindowSeconds` | `120` |
| `urgency.assess.batchMax` | `10` |
| `urgency.notify.levels` | `critical,high` |
| `urgency.model` | `haiku` |

## Implementation notes (Phase 4)

Where the Phase 4 code differs from, or is stricter than, the sections above. Rulings are in the Phase 4 plan workspace (R1-R14).

### Screening (no AI)

- `ScreeningService` (`modules/inbox/screening-service.ts`) is an outbox consumer (`inbox.screening`) of `message.received` and `message.thread_updated`. It runs in the dispatcher's transaction, so a failure can never block message storage. An exception is logged as one content-free line and the message gets `screening.error = true`. The stored result is `slack_messages.screening` (`ScreeningRecord`); `message.screened` carries the raw `candidate` value.
- **Scoring** (pure function `screenMessage`, only the first 8,000 characters are scanned; invalid user-edited keyword patterns are skipped and reported by the `screening-rules` health check as degraded):

| Signal | Score |
|---|---|
| Each matched keyword rule | its weight (`incident` 3, `blocker` 2, `urgent` 2, `deadline` 2, `today` 1, `question` 0) |
| Direct message (`im`) | +1 |
| Group DM (`mpim`) | +0.5 |
| Mentions the user | +1 |
| In a thread the user took part in | +1 |
| Sender priority is `high` or `critical` | +1 |
| Sender has extra attention | +1 |

- **Candidate rule.** A message is a candidate when at least one matched rule is an urgency signal (`incident`, `blocker`, `urgent`, `deadline`, `today`; `question` is not) and the score reaches `urgency.candidateThreshold` (default 2). A priority or extra-attention sender lowers the threshold by 1 (minimum 1). The rule level is the highest `level` among matched rules, or `low`.
- **Skips, with no Claude run.** The user's own messages (sender equals `slack.selfUserId`; with no identity set nothing counts as own), messages whose content has expired (`text = null`) and non-candidates are never assessed. Non-candidates get route `batch` (stored, never sent to Claude).
- **Age gate.** A candidate whose `sent_at` is older than `urgency.maxAgeHours` (default 24) gets route `skip` with reason `too_old`: it is screened and flagged but never assessed and never notified, so a 90-day backfill cannot cause a Claude run or a notification burst.
- **Idempotency.** Re-screening (retry, replay, thread update) keeps `assessed`, `fallback` and `notified`, creates no second flag and enqueues no second assessment.

### Batched assessment

- A candidate with route `assess` enqueues `urgency.assess` (priority 200) with the bucket key `urgency.batch:<bucket>`, where bucket = floor(now / `urgency.assess.batchWindowSeconds`) x window, and `runAfter` = end of the bucket. Messages arriving in the same window share one job. The bucket key cannot strand messages: a bucket's job runs only after the bucket closes, and a handler that leaves messages over enqueues `urgency.batch:<jobId>:next`.
- **Concurrency group (R11).** Every `urgency.assess` enqueue uses `concurrencyGroup: "urgency.assess"`, so a deferred job and a later bucket's job never run at once and never select the same messages (no double Claude spend).
- The handler selects up to `urgency.assess.batchMax` unassessed `assess` messages with text, oldest first. The code caps `batchMax` at 10.
- **R13 byte cap.** Each message's text is capped by UTF-8 bytes at floor((100 KiB - 8 KiB) / batch length) so the request passes the orchestrator's 100 KiB prompt validator. The cut is on a code-point boundary and ends with a truncation marker. A long message is assessed on its prefix.
- **Batch validation.** The model's output is parsed by the handler itself (R12) with `urgencyAssessmentSchema`. An id outside the batch or a duplicate id fails the whole run with `incomplete_ai_output` (retried). A batch message the model omitted gets the rule level for that message only, flagged `fallback`. Invalid output also fails with `incomplete_ai_output`.
- **Output handling.** Each result stores `urgency_level`, a rendered and capped `urgency_reason` and sets `assessed`. `urgency_status` is set to `new` only when unset. A `suspectedInjection` result is forwarded to security-flags as an AI flag. Priority is never read from or written by the model.
- **Runtime flags (R12).** Because the handler calls the orchestrator and then parses, runtime flags are recorded from the run result even when the output is invalid: any permission denial or any tool result other than `ToolSearch` raises a runtime flag on every message of the batch (`high` if a write/send tool was involved, else `warning`). Reasons hold tool names only. Assessment and suggestion requests carry untrusted message text, so the orchestrator allows them no write, send or network tools (ADR-032).

### Notifications and failure handling

- **Notify once.** A message whose level is in `urgency.notify.levels` (default critical, high) creates one notification (title: level, sender name, conversation label; never message text), publishes `message.urgent_detected` and enqueues the suggestion job. `screening.notified` makes this once per message.
- **Deferral ("not yet assessed").** When a run is deferred (quota or auth pause), no message is assessed, but each batch message whose rule level is `critical` still notifies once with "Likely incident (not yet assessed)". The Urgent Inbox shows such messages at their rule level, labelled not yet assessed. They are assessed after the pause. The suggestion job is enqueued after the later real assessment.
- **Terminal fallback.** When a job fails terminally (attempts exhausted, `needs_attention` or `fail`), every message of the batch takes its rule level, marked `fallback` with a fixed reason, and the usual notification rule applies. The next batch is then enqueued.
- A retryable failure just rethrows; the queue retries with backoff.

### Desktop notifications (R14)

`NotificationService` writes the in-app row, then (when `notifications.desktop.enabled`, default true, and severity is at least `notifications.desktop.minSeverity`, default `warning`) hands the notification to the `DesktopNotifier` port (`packages/contracts`). The adapter (`infrastructure/notifier.ts`) runs `notify-send --app-name=Synapse --urgency=<critical|normal|low> <title>` through `Bun.spawn` with an argv array (no shell), title only (sender name, conversation label and level, never message text), with a 5 s timeout. Callers write inside their own synchronous transaction, so the desktop call is deferred to a macrotask after the transaction ends, re-checks the row still exists (rolled-back notifications never pop up) and is fire-and-forget: a failure logs one content-free line and the in-app row remains. The `desktop-notifier` health check is `degraded` when `notify-send` is not on PATH or the last call failed. Tests and the smoke scripts inject `NoopDesktopNotifier`; `main.ts` injects the real adapter.

### Suggested responses

- `urgency.suggest_response` (priority 150, group `urgency.suggest`, key `urgency.suggest:<messageId>`) runs for each critical or high message, including after a deferral notification.
- **Skips.** `expired_or_missing` (message gone or text expired), `not_urgent` (level not critical or high), `draft_exists` (one draft per message, so a discarded draft is not regenerated) and `raced` (a draft appeared, or the text expired, while the run was in flight).
- Context is up to a fixed number of earlier messages of the same thread (or conversation if there is no thread). The draft is stored in `message_drafts` as `proposed`, rendered and capped at 2,000 characters, with the model's confidence. **Nothing is sent**; sending needs approval and is out of scope (below).
- **Draft retention.** A draft quotes the conversation, so `expireContent` clears `message_drafts.text` and sets `content_expired_at` when its message expires. The row stays and the API shows no text.
- A model run with a suspected injection records an AI flag; an empty draft fails with `incomplete_ai_output`.

### Runtime and AI flags

Both are recorded through `SecurityFlagsService` (see `security-flags.md`): AI flags from `suspectedInjection.detected` in assessment and suggestion output, runtime flags from denials or unexpected tools in the run result.

### Routes (localhost)

| Route | Result |
|---|---|
| `GET /api/urgent?status=open\|all` | Urgent Inbox items: critical/high assessed messages plus unassessed ones notified during a pause, with the proposed draft, level, reason, flags `assessed` and `fallback`, and allowed status transitions. Message and draft text appear only here |
| `POST /api/urgent/:messageId/status` | Body `{ status }`. Allowed transitions only (resolved and dismissed are terminal); 409 on an invalid transition, 404 for an unknown or non-urgent message |
| `GET /api/people`, `PUT /api/people/:slackUserId/priority` | People list and priority setting (`priority`, optional `rationale` up to 500 characters, `extraAttention`) |
| `GET/PUT /api/slack/identity` | The user's own Slack identity (`slack.selfUserId`) with a suggestion |
| `GET /api/security/flags`, `GET /api/security/flags/person/:slackUserId`, `POST /api/security/flags/:id/review` | See `security-flags.md` |

### Out of scope for Phase 4

- Sending a reply and away-mode auto-replies (ADR-033): moved to Phase 6. Phase 4 produces display-only drafts and sends nothing.
- Jira and Engineering Brain urgency signals: Phases 7 and 8.

### Smoke

`bun scripts/dev/urgency-smoke.ts [--pages N]` collects real pages on a temporary database, drains the outbox so screening runs, runs `urgency.assess` once and prints counts only. It never runs the suggestion job.

## Tests

- Priority person + routine message → not urgent.
- Non-priority person + production incident → Critical.
- Non-candidate messages never trigger a Claude run.
- Quota exhausted → rule fallback, notification still sent for likely incidents.
- Invalid assessment output → retry, then fallback.
- Suggested response never sent without approval, except an ADR-033 auto-reply (away mode on + priority sender + policy checks pass).
- Away mode on, priority sender, low-confidence answer → acknowledgement auto-sent, full draft queued.
- Message with an open warning/high security flag → never auto-replied; draft queued.
- Intelligence output schemas include `suspectedInjection`; a positive value is forwarded to security-flags.
- Acknowledge/resolve status transitions.

## Open questions

- OQ-1 resolved by ADR-033 (away-mode auto-replies to priority people).
- **OQ-2 (deferred):** notifications and approvals while away for non-priority senders. Desktop notifications don't reach the user when they're out, and the app is localhost-only. Their drafts wait until the user returns.

See `docs/product/open-questions.md`.
