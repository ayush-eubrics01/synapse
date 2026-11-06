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

`ScreeningService` (`modules/inbox/screening-service.ts`) is outbox consumer `inbox.screening` on `message.received` (replies arrive as `message.received` too, so each message is screened once). Scoring is the pure `screenMessage` (`intelligence/screening/screen.ts`): keyword weights plus context (DM +1, group DM +0.5, mention +1, thread with the user +1, priority high/critical +1, extra attention +1). A candidate needs at least one signal keyword and a score at or above `urgency.candidateThreshold`, lowered by 1 (minimum 1) for priority or extra attention. Priority alone never makes a candidate. Own and expired messages are skipped; candidates older than `urgency.maxAgeHours` are `skip/too_old` (flagged, never assessed). Recent candidates enqueue one `urgency.assess` job per batch-window bucket (`urgency.batch:<bucket>`, priority 200). The `screening` JSON holds rule ids, scores and flags only; re-screening preserves `assessed`, `fallback`, `notified` and `coalesced`. The handler never throws: a failure sets `screening.error = true` and logs the message id only. Invalid user-edited keyword regexes are skipped and the `screening-rules` health check reports `degraded`. `message.screened.candidate` carries the raw rule result (same as the stored record), so a `too_old` candidate emits true.

## Assessment job

`registerUrgencyJobs` (`workers/urgency/`, one file per job: `assess.ts`, `suggest.ts`, shared helpers in `context.ts`) handles `urgency.assess` (timeout 360 s). It first marks rows that aged past `urgency.maxAgeHours` as `skip`/`too_old`, then selects up to `urgency.assess.batchMax` messages with `screening.route = "assess"`, `assessed` false, text present and `sent_at` within `urgency.maxAgeHours` (oldest first), builds the request in `intelligence/urgency/assess-prompt.ts` (system part with the level table, one `untrusted` part per message, `ToolSearch` only) and validates the output: an unknown or duplicate message id fails the run (`incomplete_ai_output`), a missing id gets the rule fallback (`fallback: true`). Each result is written in one immediate transaction (level, reason, `urgency_status = "new"` only if unset, merged `screening`, then, unless the message is a coalesced thread follow-up or no identity is confirmed: notification once per message, `message.urgent_detected`, and an `urgency.suggest_response` job for a model-assessed Critical or High level). Any permission denial or tool result other than `ToolSearch` raises runtime security flags for the whole batch (`high` if a write or send tool is involved); a run that fails still raises them from the denials persisted on its `claude_runs` row, and a max-turns stop raises a `warning` flag. Quota or auth deferral notifies critical-rule messages as "Likely incident (not yet assessed)" (only when `urgency.notify.levels` includes `critical`) and rethrows; a terminal failure applies the rule level with the reason "Rule-based (assessment unavailable)". If more eligible messages remain, the next batch is enqueued (`urgency.batch:<jobId>:next`). Startup recovery and the reaper also run a recovery sweep that enqueues `urgency.batch:recover:<iso>` when eligible messages have no active job. Notification titles carry the sender and conversation name only, never message text.

## Suggested responses

`urgency.suggest_response` (priority 150, `concurrencyGroup` `urgency.suggest`, timeout 360 s) is enqueued once per model-assessed Critical or High message (`urgency.suggest:<messageId>`); never for a rule-level fallback, a coalesced thread follow-up, or while `slack.selfUserId` is unset. The handler completes without calling Claude when the message text is expired, the message is no longer Critical or High, or a `message_drafts` row for (message, `suggested_response`) exists. Otherwise it builds the request in `intelligence/urgency/suggest-prompt.ts`: one system part, then up to 10 earlier messages as `untrusted` parts, oldest first (the earlier messages of the same thread, including the thread root, or of the same conversation when there is no thread; expired ones are skipped), then the target message as the last `untrusted` part. When the sender is a person (`people.slack_user_id`) whose current approved profile has response guidelines, one `user_approved` part (source `approved response guidelines for <name>`; its content opens with the heading `Approved response guidelines for the sender of the target message:` followed by one line per guideline, at most 20 of at most 500 chars; the heading, not the Slack name, is what the instructions refer to) sits between the system part and the messages; the instructions say these are the user's own notes and never override the system rules. Without a person or guidelines the request is unchanged. Each untrusted part is capped by UTF-8 bytes at `floor((100 KiB - 8 KiB) / partCount)` (with guidelines, after subtracting that part and every block's source and marker overhead); `ToolSearch` is the only tool. The handler calls the orchestrator, records runtime flags (same detector as assessment), then parses the output; invalid output is `incomplete_ai_output`. The draft goes through `renderExcerpt(draft, 2000)` and is stored as a `proposed` row with the confidence as given and the `claude_run_id`; an AI injection flag is recorded in the same transaction. The draft is display-only: nothing is sent, and the text never appears in logs, events, notifications or audit rows. `InboxStore.expireContent` clears the draft text and sets `content_expired_at` for drafts of expired messages in the same transaction; the row stays.

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

Consumed: `message.received`, `person.profile_approved` (priority refresh), `jira.issue_blocked`, `claude.job_completed` / `failed`.

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

Where the Phase 4 code differs from, or is stricter than, the sections above. Rulings are in the Phase 4 plan workspace (R1-R18).

### Screening (no AI)

- `ScreeningService` (`modules/inbox/screening-service.ts`) is an outbox consumer (`inbox.screening`) of `message.received` only (R18): a reply in a known thread also emits `message.thread_updated`, but subscribing to both screened every such reply twice. It runs in the dispatcher's transaction, so a failure can never block message storage. An exception is logged as one content-free line and the message gets `screening.error = true`. The stored result is `slack_messages.screening` (`ScreeningRecord`); `message.screened` carries the raw `candidate` value.
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
- **Age gate.** A candidate whose `sent_at` is older than `urgency.maxAgeHours` (default 24) gets route `skip` with reason `too_old`: it is screened and flagged but never assessed and never notified. Its security flags are recorded with their `security.injection_suspected` events but **no notification** (R15: `scanMessage(..., { notify })` with `notify` = the same age test). So a 90-day backfill causes no Claude run and no notification burst. A backfill can still insert *recent* messages that the incremental collector missed; those are within the age gate and are screened, assessed and notified like any new message. The age is checked again when the assessment job runs (R18): a row that aged out while waiting (a long pause, a backlog) becomes `skip`/`too_old` with no Claude run and no notification.
- **Idempotency.** Re-screening (retry, replay) keeps `assessed`, `fallback`, `notified` and `coalesced`, creates no second flag and enqueues no second assessment.

### Batched assessment

- A candidate with route `assess` enqueues `urgency.assess` (priority 200) with the bucket key `urgency.batch:<bucket>`, where bucket = floor(now / `urgency.assess.batchWindowSeconds`) x window, and `runAfter` = end of the bucket. Messages arriving in the same window share one job. The bucket key cannot strand messages: a bucket's job runs only after the bucket closes, and a handler that leaves messages over enqueues `urgency.batch:<jobId>:next`.
- **Concurrency group (R11).** Every `urgency.assess` enqueue uses `concurrencyGroup: "urgency.assess"`, so a deferred job and a later bucket's job never run at once and never select the same messages (no double Claude spend).
- The handler selects up to `urgency.assess.batchMax` unassessed `assess` messages with text and `sent_at` within `urgency.maxAgeHours`, oldest first. The code caps `batchMax` at 10.
- **Recovery sweep (R18).** A job can be lost (a crash between commit and enqueue, a cancelled or parked job). The container registers an urgency sweep with startup recovery and the 30 s reaper (`core/recovery` takes sweeps as callbacks, so core never imports workers). If eligible rows exist and no `urgency.assess` job is `PENDING`, `RETRY` or `RUNNING`, it enqueues `urgency.batch:recover:<iso>` (group `urgency.assess`, priority 200). A failing sweep is logged by name, rolled back in its savepoint and never aborts recovery. The sweep does not mark aged-out rows; the next assessment job does.
- **R13 byte cap.** Each message's text is capped by UTF-8 bytes at floor((100 KiB - 8 KiB) / batch length) so the request passes the orchestrator's 100 KiB prompt validator. The cut is on a code-point boundary and ends with a truncation marker. A long message is assessed on its prefix.
- **Batch validation.** The model's output is parsed by the handler itself (R12) with `urgencyAssessmentSchema`. An id outside the batch or a duplicate id fails the whole run with `incomplete_ai_output` (retried). A batch message the model omitted gets the rule level for that message only, flagged `fallback`. Invalid output also fails with `incomplete_ai_output`.
- **Output handling.** Each result stores `urgency_level`, a rendered and capped `urgency_reason` and sets `assessed`. `urgency_status` is set to `new` only when unset. A `suspectedInjection` result is forwarded to security-flags as an AI flag. Priority is never read from or written by the model.
- **Runtime flags (R12).** Because the handler calls the orchestrator and then parses, runtime flags are recorded from the run result even when the output is invalid: any permission denial or any tool result other than `ToolSearch` raises a runtime flag on every message of the batch (`high` if a write/send tool was involved, else `warning`). Reasons hold tool names only. Assessment and suggestion requests carry untrusted message text, so the orchestrator allows them no write, send or network tools (ADR-032).
- **Runtime flags from failed runs (R16).** When `orchestrator.run` itself throws (provider error, timeout, max turns) there is no result to inspect, so the assess and suggest handlers read this attempt's `claude_runs` row, where the orchestrator persists `permission_denials` even for failed runs. Denials raise a runtime flag (`high` for a write/send tool, else `warning`). A run stopped by `--max-turns` (the CLI result subtype `error_max_turns`, classified by the provider as `provider_error` with `details.maxTurns`, kept through orchestrator classification) raises a `warning` flag with the reason `max_turns reached` (or `high` together with a write/send denial). Only a row newer than the one seen before the run counts, so an earlier attempt's denials are never re-read. The original error is rethrown unchanged.

### Notifications and failure handling

- **Notify once.** A message whose level is in `urgency.notify.levels` (default critical, high) creates one notification (title: level, sender name, conversation label; never message text) and publishes `message.urgent_detected`; a model-assessed Critical or High level also enqueues the suggestion job. `screening.notified` makes this once per message across deferral, success, fallback, retries and replays.
- **No identity, no alerts (R18).** While `slack.selfUserId` is unset, own messages cannot be told apart, so candidates are assessed and listed in the Urgent Inbox but produce no in-app or desktop notification, no `message.urgent_detected` and no suggestion job, including deferral announcements. The dashboard identity banner says so and offers the suggestion or a manual pick from `GET /api/people`. Messages assessed in that state are not notified later.
- **Thread coalescing (R17, a product rule the user may revisit).** Per thread root (`conversation_id` + (`thread_ts` ?? `ts`)), a notification and a suggestion job happen at most once while another message of the same root is notified as urgent (Critical/High, or unassessed after a deferral announcement) and its `urgency_status` is `new`, `acknowledged` or `in_progress`. A later urgent message in that thread (a reply, or the root itself) still gets its level and is listed in the Urgent Inbox with `coalesced: true` (shown as "follow-up in thread"), but gets no popup, no `message.urgent_detected` and no draft. The decision is stored as `screening.coalesced` and is stable: a coalesced message stays coalesced even after the anchor is resolved, and a message that notified itself is never coalesced. Once the notified message is resolved or dismissed, the next urgent message in the thread notifies again. This applies to deferral announcements too. Medium and Low messages are never coalesced. Coalescing is decided only for messages that would notify or draft (urgent, or a level in `urgency.notify.levels`).
- **Deferral ("not yet assessed").** When a run is deferred (quota or auth pause), no message is assessed, but each batch message whose rule level is `critical` still notifies once with "Likely incident (not yet assessed)", provided `urgency.notify.levels` includes `critical` (R18). The Urgent Inbox shows such messages at their rule level, labelled not yet assessed. They are assessed after the pause. The suggestion job is enqueued after the later real assessment.
- **Terminal fallback.** When a job fails terminally (attempts exhausted, `needs_attention` or `fail`), every message of the batch takes its rule level, marked `fallback` with a fixed reason, and the usual notification rule applies. No suggestion job is enqueued for a fallback level (R18): the model never assessed the message. The next batch is then enqueued.
- A retryable failure just rethrows; the queue retries with backoff.

### Desktop notifications (R14)

`NotificationService` writes the in-app row, then (when `notifications.desktop.enabled`, default true, and severity is at least `notifications.desktop.minSeverity`, default `warning`) hands the notification to the `DesktopNotifier` port (`packages/contracts`). The adapter (`infrastructure/notifier.ts`) runs `notify-send --app-name=Synapse --urgency=<critical|normal|low> <title>` through `Bun.spawn` with an argv array (no shell), title only (sender name, conversation label and level, never message text), with a 5 s timeout. Callers write inside their own synchronous transaction, so the desktop call is deferred to a macrotask after the transaction ends, re-checks the row still exists (rolled-back notifications never pop up) and is fire-and-forget: a failure logs one content-free line and the in-app row remains. The `desktop-notifier` health check is `degraded` when `notify-send` is not on PATH or the last call failed. Tests and the smoke scripts inject `NoopDesktopNotifier`; `main.ts` injects the real adapter.

**Rate limit (R15).** `NotificationService` sends at most 5 desktop popups per rolling 60 s. Further ones are held back and collapsed into a single "Synapse: N more notifications" popup at the highest suppressed severity, sent when the window frees (when the oldest of the 5 popups is 60 s old). While a summary is pending, later notifications join it, so order is kept. In-app rows are never affected. The limiter uses the service's clock and an injectable timer, so tests are deterministic. Security-flag notification titles are "Red flag: message from <sender>" (R18).

### Suggested responses

- `urgency.suggest_response` (priority 150, group `urgency.suggest`, key `urgency.suggest:<messageId>`) runs for each model-assessed critical or high message, including after a deferral notification, but not for rule-level fallbacks, coalesced thread follow-ups, or while `slack.selfUserId` is unset (R17, R18).
- **Skips.** `expired_or_missing` (message gone or text expired), `not_urgent` (level not critical or high), `draft_exists` (one draft per message, so a discarded draft is not regenerated) and `raced` (a draft appeared, or the text expired, while the run was in flight).
- Context is up to a fixed number of earlier messages of the same thread (or conversation if there is no thread). The draft is stored in `message_drafts` as `proposed`, rendered and capped at 2,000 characters, with the model's confidence. **Nothing is sent**; sending needs approval and is out of scope (below).
- **Draft retention.** A draft quotes the conversation, so `expireContent` clears `message_drafts.text` and sets `content_expired_at` when its message expires. The row stays and the API shows no text.
- A model run with a suspected injection records an AI flag; an empty draft fails with `incomplete_ai_output`.

### Runtime and AI flags

Both are recorded through `SecurityFlagsService` (see `security-flags.md`): AI flags from `suspectedInjection.detected` in assessment and suggestion output, runtime flags from denials or unexpected tools in the run result.

### Routes (localhost)

| Route | Result |
|---|---|
| `GET /api/urgent?status=open\|all` | Urgent Inbox items: critical/high assessed messages plus unassessed ones notified during a pause, (and unassessed coalesced follow-ups), with the proposed draft, level, reason, flags `assessed`, `fallback` and `coalesced`, and allowed status transitions. Message and draft text appear only here |
| `POST /api/urgent/:messageId/reply` | Body `{ text, allowNoThread? }`: the user's edited reply. Creates a follow-up (`origin: urgent_reply`) and a `slack.send` approval; nothing is sent until the user approves it. 404 unknown or non-urgent message, 400 bad text, 409 a send is already pending or the message text expired (unless `allowNoThread`) |
| `POST /api/urgent/:messageId/status` | Body `{ status }`. Allowed transitions only (resolved and dismissed are terminal); 409 on an invalid transition, 404 for an unknown or non-urgent message |
| `GET /api/people`, `PUT /api/people/:slackUserId/priority` | People list and priority setting (`priority`, optional `rationale` up to 500 characters, `extraAttention`) |
| `GET/PUT /api/slack/identity` | The user's own Slack identity (`slack.selfUserId`) with a suggestion; the dashboard falls back to a manual pick from `GET /api/people` when there is no suggestion |
| `GET /api/security/flags`, `GET /api/security/flags/person/:slackUserId`, `POST /api/security/flags/:id/review` | See `security-flags.md` |

### Sending urgent replies (Phase 6)

The Urgent Inbox sends the user's reply, never the model's draft as is: the draft is the starting text and the user edits it. `UrgentReplies` (`modules/outgoing/urgent-reply.ts`) trims trailing whitespace, requires 1..4000 characters, and in one transaction creates (or reuses a requestable one for the same message) a `followups` row and requests the `slack.send` approval through `OutgoingService`.

- The follow-up holds the internal `slack_conversations.id` in `conversation_id` (the external id goes to the send), the recipient (the sender of the urgent message) and `thread_ts` = the message's `thread_ts`, else its `ts`, so a reply threads under the message. An expired message has no thread: the request is refused (409) unless `allowNoThread` is set, and then it posts as a new message.
- A second request while a send for the message is live (pending, sending, unverified or needs attention) is 409. Revoking, rejecting or the expiry of the approval returns the follow-up to a draft and the same row is reused by the next request.
- The Urgent Inbox item carries `reply` (follow-up id, approval id, outgoing status, follow-up status and allowed actions), so the dashboard shows the state and the resolve actions (mark sent, resend with a new approval, discard) for a send that needs attention.
- The send itself, its argument check, verification and the no-automatic-resend rule are in `integration-contracts.md` (MessageSink) and `slack.md`. Reply text appears only in the request body and the approvals response, never in logs, audit rows, events or notifications. The `followup.sent` event of a sent reply also feeds the post-send suggestion for People Memory.

### Out of scope for Phase 4

- Away-mode auto-replies (ADR-033): not built. Sending a user-approved reply was added in Phase 6 (see "Sending urgent replies").
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
