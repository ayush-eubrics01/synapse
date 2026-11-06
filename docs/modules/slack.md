# Slack Integration and Inbox

Covers the `inbox` domain module (`apps/api/src/modules/inbox`) and the `slack/claude-connector` adapter (`apps/api/src/integrations/slack/claude-connector`).

## Purpose

Collect every human Slack message the user can see (DMs, group DMs, private channels, public channels, thread replies) into one local store, so nothing that needs the user's attention is lost in scattered Slack conversations. This is the data source for the urgency engine, commitments, People Memory and the Engineering Brain.

## Responsibilities / Non-responsibilities

Responsibilities:

- Incremental collection every 10 minutes (configurable) and a one-time 90-day backfill.
- Normalization, validation and deduplication of messages.
- Thread tracking: linking replies to parents and fetching full threads when needed.
- Sync checkpoints and recovery after interrupted collection.
- Rule-based screening hand-off (`message.screened`) and storing urgency results.
- Retention cleanup of message content after 180 days.
- Sending approved messages through `MessageSink`, with verify-before-retry.

Non-responsibilities:

- Deciding urgency (urgency engine), extracting commitments (commitments), building profiles (people).
- Running Claude directly. Every connector call is a `collector` job submitted to the orchestrator.
- Treating Slack as anything other than authoritative for message content.

## Owned data (tables)

`slack_conversations`, `slack_messages`, `slack_users`, `slack_attachments`, `slack_message_references`, plus rows in `integration_sync_states` for streams `slack.messages` and `slack.backfill`. Schema: `docs/architecture/database-design.md`.

Dedup key: unique(`conversation_id`, `ts`). `SourceMessage.externalId` = `${conversationId}:${ts}`.

## Ports used / provided

- Provides `MessageSource` and `MessageSink` (adapter `slack/claude-connector`).
- The inbox module consumes `MessageSource` / `MessageSink` only through port tokens.
- The adapter uses `ClaudeOrchestrator` to run collector jobs; it never spawns `claude`.

### Collection call (ADR-025)

Tool: `mcp__claude_ai_Slack__slack_search_public_and_private`. Arguments for every collection page:

| Param | Value |
|---|---|
| `query` | `after:<UTC date of the after value minus 2 days>` (wide day hint only; see Implementation notes) |
| `after` | `floor(checkpoint)` as a Unix seconds string (inclusive; the real filter). The incremental checkpoint is stored at most now − `slack.collection.indexLagSeconds` (R61); the first run uses now − 1 day |
| `sort` / `sort_dir` | `timestamp` / `asc` |
| `limit` | `20` (maximum) |
| `include_bots` | `false` (ADR-027) |
| `include_context` | `false` |
| `response_format` | `detailed` (never `concise`: it drops IDs and ts) |
| `cursor` | from the previous page's `pagination_info` |

Because the checkpoint is inclusive, the boundary message is returned again. Dedup absorbs it.

Thread fetch: `mcp__claude_ai_Slack__slack_read_thread` with `channel_id` + `message_ts` (parent). It returns a `Message TS` per reply.

Never used for collection: `slack_read_channel` (no per-message ts, only time to the second).

### Parser

The result is JSON `{ results: "<markdown>", pagination_info: "...cursor `X`..." }`. Each result block (`### Result n of m`) has the labels `Channel` (name + `ID`), `Participants`, `From` (name, email, `ID`), `Time`, `Message_ts`, `Permalink`, `Text`, and optionally `Reply count` and `Full notes`.

- `threadTs` comes from the permalink's `?thread_ts=` parameter. There is no thread field.
- `conversationType` comes from the result label (`DM`, group DM, `#channel`). Group DM IDs can start with `C`, so don't use the ID prefix.
- Each parsed message is validated with Zod. A block missing `Message_ts`, channel ID or sender ID is rejected and counted in the run stats.
- If the envelope or block structure doesn't match, raise `parse_failed`. Never guess.
- Contract tests run against recorded, anonymized fixtures of real search and read_thread output.

## Jobs

As implemented in `apps/api/src/workers/slack.ts` (handlers and schedules) and `InboxStore.persistPage` (thread enqueue). All jobs use the queue default of 3 attempts with the queue's retry policy per error kind.

| Job type | Trigger | Claude | Idempotency key | Notes |
|---|---|---|---|---|
| `slack.collect_incremental` | schedule `slack.collect_incremental`, every `slack.collection.intervalSeconds` (600 s), `coalesce: true` (R58) | collector / haiku, search tool only | `sched:slack.collect_incremental:<nextRunAt>` (scheduler) | Handler timeout 300 s (R36). Skips without Claude when `slack.collection.enabled` is false, when the last success is newer than half the interval, or when another incremental job is RUNNING (R52) |
| `slack.backfill` | `POST /api/slack/backfill` (start or resume), then self-enqueues after each run until complete | collector / haiku, search tool only | `slack.backfill:<generation>:<checkpoint>:<pagesDone>:<runAfter>` (R51) | Priority 10, group `slack.backfill`, handler timeout 300 s. Never starts by itself |
| `slack.fetch_thread` | enqueued by `InboxStore.persistPage` for every reply whose parent is not stored (R47) | collector / haiku, `slack_read_thread` only | `slack.thread:<conversationId>:<parentTs>` | Priority 50, group `slack.threads` (one at a time), handler timeout 300 s; input validated with Zod |
| `slack.retention_cleanup` | schedule `slack.retention_cleanup`, every 86 400 s, `coalesce: true` (R58) | none | `sched:slack.retention_cleanup:<nextRunAt>` (scheduler) | Handler timeout 60 s; calls `expireContent(retention.slackContentDays)`, then (wired by the container) the auto-reply, outgoing and follow-up text retention with the same days (`docs/modules/auto-reply.md`) |

A coalescing schedule enqueues nothing while a PENDING, RETRY or RUNNING job of its type exists, and still advances `nextRunAt` (R58), so a long auth or quota pause leaves at most one waiting job per schedule.

Sending is implemented in Phase 6: there is no `slack.send_message` job. The `slack.send` approval's executor runs inside the `approval.execute` job, and `outgoing.verify` (Claude-free) searches Slack afterwards. See "Sending (Phase 6)" below.

Each collector run fetches at most `slack.collector.pagesPerRun` (5) pages, with `--max-turns` = pages + 3. The checkpoint (`integration_sync_states.checkpoint` = newest stored `ts`) is committed after each page's messages are persisted, in the same transaction.

Cost note: every poll is a Claude run, even when nothing is new (~$0.005 API-equivalent on Haiku, ≈ $0.70/day at 10 minutes). Polling frequency is the main steady-state cost lever. The 90-day backfill is estimated at 115–270 pages, about 25–55 runs.

## Slack rate limits (official, checked 2026-11-05)

Slack says the same limits apply whether an action goes through the MCP server or the Web API. Claude.ai and Claude Code are listed partner clients of Slack's MCP server.

| Action (tool) | Limit | Impact on Synapse |
|---|---|---|
| Search messages (`slack_search_public_and_private`, backed by `assistant.search.context`) | Workspace: 10+ requests/min with bursts (larger teams up to 400+). **Per user: 10/min with burst; sustained use at or above this hits a daily per-user limit (number not published).** Every paginated request counts. Max 20 results per page | The main constraint. Fine for 10-minute polling, but the backfill must be paced |
| Read a thread (`slack_read_thread`) | Tier 3: 50+/min | Fine |
| Read a channel (`slack_read_channel`) | Tier 3: 50+/min | Not used for collection |
| Send message (`slack_send_message`) | Special (`chat.postMessage`: about 1 message per second per channel) | Fine; auto-replies are capped anyway |
| Search users/channels, list user channels | Tier 2: 20+/min | Fine |
| Read user profile, list channel members | Tier 4: 100+/min | Fine |

When a limit is hit, Slack returns HTTP 429 with `Retry-After` (seconds). Slack doesn't document how the MCP server passes this on to the client. The adapter treats an error tool_result mentioning `ratelimited`/`rate_limited`/429 as `rate_limited`, honours a `Retry-After` value if present, and otherwise backs off.

The May 2025 throttle for non-Marketplace apps (`conversations.history`/`replies` at 1 request/min, 15 objects) is tied to how an app is distributed. Slack's pages don't say it applies to the MCP server or its partner clients. Synapse doesn't depend on those methods for collection either way.

### Pacing rules

| Situation | Calls | Rule |
|---|---|---|
| Incremental poll (every 10 min) | 1 search, plus 1 more per extra 20 new messages | About 6 searches/hour. Far below limits |
| Backfill (90 days ≈ 115–270 pages) | 1 search per page | At most 5 pages per run (a burst), at least 3 minutes between runs: about 100 pages/hour, done in roughly 1.5–3 hours. On `rate_limited`, double the gap (up to 30 min) and resume from the checkpoint |
| Thread fetches | 1 `slack_read_thread` per unknown parent | One job per missing parent, uncapped; jobs run one at a time (group `slack.threads`, R47) |
| Daily per-user search limit | unknown | Count searches per day in `integration_sync_states`. If a daily-limit error appears, pause the backfill until the next day, keep incremental polling, and record the count it happened at |

The backfill also yields to quota and to the user's own Claude Code activity (ADR-029, ADR-036).

## Implementation notes (Phase 3)

Where the Phase 3 code differs from, or is stricter than, the sections above. Rulings are in `docs/superpowers/plans/2026-11-05-phase-3-followups.md` (R35-R62).

### Collection and parsing

- **Search tool and filter (R44).** Collection uses `slack_search_public_and_private`. The exact filter is the Unix `after` (and, for backfill, `before`) argument. The `query` text carries only a wide day hint (`after:` two days earlier, `before:` two days later), because Slack's day modifiers are exclusive and timezone-dependent and could silently drop a day.
- **Page-chain verification (R35).** The model's text is never trusted. A page is accepted only if the tool input of that `tool_result` equals the requested arguments (first page) or the requested arguments plus the previous page's cursor. Primitive values compare as strings, key order is ignored, and extra or missing keys mismatch. The first mismatch ends the chain; later pages are discarded. `complete` means no next cursor after the last accepted page.
- **Fail-closed parsing (R41, R43).** The search parser takes the result count from the `## Messages (N results)` line and requires block headers `### Result 1 of N` ... `### Result N of N` consecutively. The thread parser requires exactly one parent marker, one replies marker and consecutive `--- Reply i of M ---` markers. Any extra, missing or out-of-order marker fails the whole page with `parse_failed` (`NEEDS_ATTENTION`), so message text cannot forge structure. The only accepted empty result is the exact observed "No results found." form. A message that fails Zod validation is rejected and counted. A thread reply with no parsable sender (bot or app) is rejected and counted (R45).
- **ts window (R42).** A message is kept only if its `ts` is within `[floor(afterTs), beforeTs or now + 5 min]`. Others are rejected and counted. This bounds a forged or garbled `ts`.
- **ADR-026 in the source (R57).** Slack requests do not set `expectedToolNames`: the provider would turn a run whose only expected-tool results are errors into `incomplete_ai_output` and drop the results, which hid Slack rate limits. `SlackConnectorSource` classifies instead. Search: any error result matching the rate pattern → `rate_limited` (with `Retry-After`, capped at 24 h; a daily limit waits until the next UTC midnight); no search tool result → `incomplete_ai_output`; no accepted page and only non-rate error results → `provider_error`; no accepted page otherwise → `incomplete_ai_output`. Thread: a rate-pattern error → `rate_limited`; no thread tool result at all → `incomplete_ai_output`; a non-rate error result for the requested pair leaves it unavailable (R46). A pair is marked unavailable only when some thread tool result's input matches it (error, parse drop or parent mismatch); a requested pair with no matching result → `incomplete_ai_output` (R62). Covered end to end through the real provider and orchestrator with the fake binary (`apps/api/test/integration/slack-provider-e2e.test.ts`).
- **Index lag (R61, supersedes R59).** There is no query offset: `after` and the R42 lower bound are `floor(checkpoint)`. Instead, the incremental stream's stored checkpoint is capped at now − `slack.collection.indexLagSeconds` (default 300): checkpoint = max(current, min(page max, now − lag)), via `persistPage(..., { checkpointLagSeconds })`. Messages from the last `lag` seconds are re-read on the next poll, so a message the search index returns late is still collected, and dedup absorbs the repeats. Every run reads from the checkpoint onwards, so any result past the checkpoint advances it. The R59 offset could stall forever when 100 or more stored messages lay in the re-read window. The backfill stream keeps plain R48. The real latency is unmeasured (OQ-8).
- **Run attribution (R60 M3).** `CollectRequest.jobId` and `ThreadFetchRequest.jobId` carry the queue job id to the orchestrator, so `claude_runs.job_id` links each Claude run to its job.
- **Conversation types.** `im` (D ids), `mpim` (group DMs, recognised by the connector's "Group DM" label) and `channel` (public and private channels). The type is derived by the parser and stored on `slack_conversations`.

### Storage and checkpoint

- **`InboxStore.persistPage`** runs in one immediate transaction: upserts conversations and users, inserts messages, publishes `message.received` for each new message, and decides the thread handling for replies. The dedupe key is unique(`conversation_id`, `ts`); the inclusive boundary message and repeated pages count as duplicates.
- **Checkpoint rules (R48).** After a page the checkpoint becomes max(current, min(newest ts of the page, now)). It never moves backwards and never beyond now, and only pages from a verified chain are persisted. For the incremental stream `now` is replaced by now − `slack.collection.indexLagSeconds` (R61).
- **`SyncStateService`** owns `integration_sync_states` rows for the streams `slack.messages` and `slack.backfill`: status, checkpoint, pages done, per-day search count, stall count, generation, last success and last error.
- **Thread fetch jobs (R45, R47).** A reply whose parent is not stored enqueues one `slack.fetch_thread` job per missing parent, with no cap. The idempotency key `slack.thread:<conversation>:<parentTs>` prevents duplicates. Jobs run one at a time (group `slack.threads`) at lower priority than collection. The parent `ts` must equal the requested one. An unanswered request completes and writes the audit row `slack.thread_unavailable` (R46). Thread parse errors drop only that thread.
- **Retention.** After `retention.slackContentDays` (default 180) days, `expireContent` clears `slack_messages.text` and `fullNotes` and sets `contentExpiredAt` for messages older than the cutoff. `slack_users` names and emails are kept as the people directory. Ids, permalinks and derived records stay. `text` is `null` in the API afterwards.

### Jobs

- **Incremental (R52).** `slack.collect_incremental` completes without calling Claude when the last success is newer than half the interval, or when another incremental job is running. Quota and auth deferrals are pauses, not failures: they write no `lastError` and emit no `collection.failed`.
- **Backfill (R49-R51).** It starts only on request (`POST /api/slack/backfill`), never automatically. The upper bound is the incremental checkpoint, or now if there is none (R37). Runs are paced by `slack.backfill.minMinutesBetweenRuns`, in group `slack.backfill`, and a new run is enqueued only if no PENDING or RETRY backfill job exists. Each start or resume gets a new generation, which is part of the idempotency key (`slack.backfill:<generation>:<checkpoint>:<pagesDone>:<runAfter>`), so crashes and resumes cannot create duplicate chains. Backfill is complete only when the last accepted page has no cursor. Three consecutive runs that leave the checkpoint unchanged (stall) set status `error` and stop. A terminal job failure also sets `error`, except `auth_failed`: the job still parks in `NEEDS_ATTENTION`, but the backfill stays `running` (R60 M5). Starting again from `error` (or from `running` with no live job, reported as `resumable` by the status route) resumes from the current checkpoint. A `paused` backfill is not reset by a start request.
- **Scheduling (R58).** Both Slack schedules coalesce: a tick enqueues nothing while a job of the same type is PENDING, RETRY or RUNNING, so deferrals during an auth or quota pause never pile up. The flag lives in code at registration (schedules are re-registered on every start), so it needs no column.

### HTTP routes (localhost, no auth beyond the bind)

| Route | Result |
|---|---|
| `GET /api/inbox/messages?limit&before&conversationId` | Newest-first messages. `limit` 1..200 (default 50); `before` is an ISO datetime with offset; `conversationId` matches `/^[CDG][A-Z0-9]+$/`. Items hold conversation (id, name, type), sender, `sentAt`, `text` (null once expired), permalink, `threadTs`, `replyCount`. Invalid params return 400 |
| `GET /api/slack/status` | `{ incremental, backfill, searchesToday }`; each state has status, checkpoint, pages done, last success, last error and stall count. `backfill.resumable` is true when the status is `running` and no PENDING, RETRY or RUNNING `slack.backfill` job exists; the dashboard then offers "Resume backfill" (R60 M4) |
| `POST /api/slack/backfill` | Starts or resumes the backfill. Returns `{ started, state, reason? }`; `started: false` with a reason if already running, paused or complete |
| `POST /api/slack/incremental/skip` | Q1 recovery for a fail-closed parse stall. Allowed only when the incremental `lastError.kind` is `parse_failed`, otherwise 409. Advances the checkpoint by exactly 1 s (the 6-digit fraction is kept), clears `lastError`, writes the audit row `slack.checkpoint_skipped` (old and new checkpoint only) and enqueues an incremental run (the R52 half-interval rule may skip it; the next scheduled run follows). Returns `{ checkpoint }`. The dashboard shows "Skip unreadable page" only in that state. Messages in the skipped second are lost. Because the incremental checkpoint trails now by the index lag (R61), a stall can recur and may need another skip |

### Stored copy and edits (Q5)

The stored copy of a message is the first one seen. Edits and deletes in Slack are not tracked: a later poll returns the changed text, but the dedupe key (conversation, `ts`) counts it as a duplicate and the stored text is not updated. Screening, urgency and the Engineering Brain therefore read the original text. Slack stays authoritative; the permalink opens the current message.

### Search counting (Q2)

`searchesToday` counts the search results of every run that returned a result, including runs that then failed validation: a `JobError` thrown by `SlackConnectorSource.collect` after the Claude run returned (no tool result, rate-limited result, parse failure) carries `details.searches`, and the worker adds it to the day's count on failure. A run that fails inside the orchestrator (provider error, timeout, max turns, quota or auth) returns no tool results, so its searches are not counted and `searchesToday` can under-count. A successful run is counted from `CollectResult.searches` as before.

### Dev smoke

`bun scripts/dev/slack-smoke.ts [--pages N]` runs one real incremental collection through the orchestrator on a temporary database and prints counts only. See `CLAUDE.md`.

## Sending (Phase 6)

Slack sends are the only Slack writes. The adapter is `SlackSender` (`integrations/slack/sender.ts`); the contract is in `integration-contracts.md` (MessageSink).

- **One narrow run per message.** Profile `collector`, priority class `send`, haiku, 3 turns, allowed tools `slack_send_message` and `ToolSearch` only. The prompt is a system instruction plus the approved `{channel_id, message, thread_ts?}` JSON as the only `user_approved` part; there is no untrusted text in the run. All other Slack write tools stay in `--disallowedTools`.
- **Approval first.** `POST /api/followups/:id/send` or `POST /api/urgent/:messageId/reply` stores the edited text (1..4000 characters after trimming trailing whitespace, otherwise unchanged) and requests a `slack.send` approval (medium risk, 7-day expiry). The approvals view shows the exact text, recipient and conversation. The sink is called only after the user approves; revoke, reject or expiry before the claim sends nothing and returns the draft.
- **Arguments are checked by code** from the `tool_use` input of the raw tool result. The check runs after the send tool ran, so a mismatch is detected after the fact, not prevented: a message with the changed arguments may already be in Slack. A mismatch is never reported as sent and never re-sent automatically: the message goes to `needs_attention` with a `high` runtime flag and the notification "Send went out with changed arguments — check Slack for a stray message" (R20).
- **Delivery is verified by search.** `findSent` runs the Phase 3 search collector (incremental, two pages, with the extra query term `from:<@self>` so other workspace traffic cannot fill the pages, R19) and matches conversation, sender (`slack.selfUserId`), thread and text. Both texts are decoded first (`&amp;` `&lt;` `&gt;`, and URL link markup `<url|label>` → label, `<url>` → url), `http(s)://` prefixes are removed, and the result is whitespace-normalised. The prefix removal (J3) is needed because Slack autolinks a typed URL as `<https://host/path|host/path>`: the label drops the scheme. This format was confirmed on a real send on 2026-11-06. A found message becomes `sent`; an unverified send keeps `sent_unverified` and notifies after `outgoing.verify.maxAttempts`. An auth pause, quota stop or Slack rate limit during the search defers the verify job without spending an attempt (R18).
- **Slack index lag.** Search may not show a fresh message yet, so the first verify waits `outgoing.verify.delaySeconds` (120 s) and each attempt searches from 5 s before the send started.
- **Thread placement.** The sender never decides it: the draft's `thread_ts` is fixed when the draft is made (see `commitments.md`, follow-up drafts). A DM nudge posts top-level; a channel or group DM follow-up threads under the source; a source that expired posts without a thread, and only if the user approves that.
- **Self id.** Verification needs `slack.selfUserId`; without it `findSent` returns "cannot tell" and the user resolves the message by hand.
- **Dev smoke for sends:** none. No script sends. `commitments-smoke.ts` injects a sink that throws.

### Inbox views

Read-only views for the dashboard (`modules/inbox/conversations.ts`):

- `GET /api/inbox/conversations?limit=1..100` (default 50): `ConversationSummary[]`, newest `lastMessageAt` first. Carries the DM partner, whether they wrote last, a pending send approval and open urgent items.
  - **Self DM.** `isSelfDm` is true only for an `im` with no non-self sender (`partner: null`) whose stored `slack_conversations.name` is non-null and equals the self user's stored `slack_users.name`. Being partner-less alone isn't enough: a DM the user started that has no reply yet looks the same. Today the collector stores no name for DMs (the connector's search label is just `DM`, and `read_thread` carries no conversation name), so in practice every partner-less DM comes back with `isSelfDm: false`, `partner: null` and `theyWroteLast: false`. The web titles it by its name, or "Direct message" when it has none. It never shows a false "Notes to self". A reliable self-DM signal is a follow-up (see `docs/superpowers/plans/2026-11-06-phase-7-followups.md`).
- `GET /api/inbox/conversations/:id/thread?limit=1..500` (default 200): `ConversationThread`, the newest `limit` messages oldest first, each annotated with its highest-severity security flag, its latest non-rejected commitment and whether it was sent via Synapse (a sent or sent_unverified outgoing row with the same normalised text, at or up to 1 h after `sendingAt`). Unknown id: 404; id not matching `[CDG][A-Z0-9]+`: 400. `permalink` passes through `safePermalink`: anything but an http(s) link is `null`. Message text is never logged.

## Events

Emitted: `message.received`, `message.thread_updated` (no consumer yet; screening listens to `message.received` only), `message.screened`, `message.urgent_detected` (after the urgency result is stored), `collection.completed`, `collection.failed`.

Consumed: `approval.approved` / `approval.rejected` / `approval.expired` (sends), `settings.changed` (frequency, retention), `claude.job_completed` / `claude.job_failed` (collector runs).

## Workflows

Incremental collection:

```text
scheduler → slack.collect_incremental
  → orchestrator collector run (search pages from checkpoint)
  → adapter parses RawToolResults only (ADR-026)
  → validate → upsert users/conversations → insert messages (dedup)
  → commit checkpoint + outbox events per page
  → message.received / message.thread_updated
  → collection.completed {stream, pages, inserted, duplicates, rejected}
```

Thread handling: a reply (`threadTs` set) whose parent is already stored emits `message.thread_updated`. If the parent is unknown, a `slack.fetch_thread` job is enqueued, and the reply is still stored with `thread_ts`.

Backfill: start checkpoint = now − 90 days, `sort_dir: asc`, ~5 pages per job, at least 3 minutes between jobs (see Pacing rules), a checkpoint after every page, self-enqueue until there's no next cursor, then mark `slack.backfill` complete and hand off to `slack.messages`.

Send (approval required):

```text
draft (commitments/urgency) → user edits and requests the send → slack.send approval
→ user approves the exact text, recipient and conversation shown
→ approval.execute job → claim pending→sending → SlackSender.send (one narrow run)
→ sent_unverified (tool ran, arguments verified) → followup.sent → outgoing.verify (search)
→ uncertain / lost outcome → needs_attention → verify, then the user decides (never an automatic resend)
```

## Permissions and approvals

Read Slack: allowed. Send, schedule or draft a message, react, create a conversation: approval required. Collector runs get only `ToolSearch` + the read tools they need. The send job gets only `slack_send_message`. All other Slack write tools are always in `--disallowedTools`.

## Failure handling

| Situation | Handling |
|---|---|
| Connector `pending` / not connected | `connector_not_ready` → retry with backoff |
| No real tool_result from the search or thread tool | `incomplete_ai_output` → retry; the run's text reply is ignored (R57) |
| Only non-rate error results from the search tool | `provider_error` → retry (R57) |
| Non-rate error result for a requested thread | thread is unavailable: the job completes with audit `slack.thread_unavailable` (R46, R57) |
| Format change | `parse_failed` → `NEEDS_ATTENTION`, checkpoint not advanced |
| Slack rate limit | `rate_limited` → honour `Retry-After` if given, else exponential backoff (backfill gap doubles up to 30 min); a daily-limit error pauses the backfill until the next day |
| Quota above threshold | job deferred until `resetsAt` (orchestrator) |
| Auth failure | `auth_failed` → `NEEDS_ATTENTION`, notification. A backfill stays `running` (not `error`) and shows as resumable (R60 M5) |
| Interrupted run | next run resumes from the last committed checkpoint; dedup handles overlap |
| Uncertain send | verify via `findSent` (search); never blind-retry; the user decides |

## Configuration

Every key the Slack code reads (`settings.get`), from the settings registry in `apps/api/src/core/config/settings.ts`:

| Key | Default | Read |
|---|---|---|
| `slack.collection.intervalSeconds` | `600` | At schedule registration (startup): a change needs a restart to change the poll interval. Also read on each incremental run for the R52 half-interval skip |
| `slack.collection.enabled` | `true` | Each incremental run; `false` skips without calling Claude |
| `slack.collection.indexLagSeconds` | `300` | Each incremental run: the stored checkpoint trails now by this many seconds (R61, OQ-8) |
| `slack.collector.pagesPerRun` | `5` | Each incremental and backfill run (`maxPages`) |
| `slack.backfill.minMinutesBetweenRuns` | `3` | Each backfill run (gap and minimum backoff) |
| `slack.backfill.maxBackoffMinutes` | `30` | Each backfill run (backoff cap on `rate_limited`) |
| `slack.backfill.days` | `90` | Backfill start (not on resume) |
| `retention.slackContentDays` | `180` | Each retention run |

Not implemented: per-conversation-type filters and an "only my channels" switch. Collection covers everything the search returns.

## Tests

- Duplicate retrieval (inclusive checkpoint, repeated pages) → no duplicate rows.
- Interrupted backfill → resumes from the last committed page.
- Slack auth failure → `NEEDS_ATTENTION`, no retry loop.
- Run returns success text but no tool_result → job fails (fabricated output).
- Connector `pending` at start → retried.
- Parser fixtures: search detailed, read_thread, group DM `C` IDs, reply permalink with `thread_ts`, missing `Message_ts` → rejected.
- Format drift → `parse_failed`, checkpoint unchanged.
- Reply whose parent was never collected → stored + thread fetch enqueued.
- Send timeout with uncertain result → verified, no duplicate message.
- Send tool called with changed arguments → detected after the fact (not prevented), `needs_attention`, `high` flag, never reported sent, never re-sent automatically.
- Expired message cleanup → text cleared, IDs/permalink and derived records kept.
- Frontend closed → collection continues.

## Open questions

- OQ-1 resolved by ADR-033: away-mode auto-replies go through `MessageSink` with the tag `Sent using @claude` (not built; Phase 6 sends only user-approved text).
- OQ-6 partly resolved: official limits and pacing rules are above. Still unknown: the daily per-user search limit, observed during the backfill.
- OQ-7: local bot-filter safety net (deferred per ADR-027). Slack's `include_bots: false` is trusted; the connector exposes no bot flag.

See `docs/product/open-questions.md`.
