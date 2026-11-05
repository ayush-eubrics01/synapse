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
| `query` | `after:<checkpoint date YYYY-MM-DD>` (day-level hint only) |
| `after` | checkpoint as a Unix timestamp string (inclusive; the real filter) |
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

| Job type | Trigger | Profile / model | Idempotency key | Retry |
|---|---|---|---|---|
| `slack.collect_incremental` | `scheduled_tasks`, every 10 min | collector / haiku | `slack.collect:<scheduled slot>` | 3 attempts, exponential backoff; skipped if previous run still active |
| `slack.backfill_page_batch` | setup step, then self-enqueues until done | collector / haiku | `slack.backfill:<checkpoint ts>` | 3 attempts; resumes from checkpoint |
| `slack.fetch_thread` | `message.thread_updated` for an unknown parent, or on demand | collector / haiku | `slack.thread:<conversation>:<parent ts>` | 3 attempts |
| `slack.retention_cleanup` | daily | none (no Claude) | `slack.retention:<date>` | 3 attempts |
| `slack.send_message` | `approval.approved` for a send | collector / haiku, send tool only | approval's `idempotency_key` | verify via `findSentMessage` before any retry |

Each collector run fetches at most ~5 pages (`maxPages`), with `--max-turns` = pages + 3. The checkpoint (`integration_sync_states.checkpoint` = newest stored `ts`) is committed after each page's messages are persisted, in the same transaction.

Cost note: every poll is a Claude run, even when nothing is new (~$0.005 API-equivalent on Haiku, ≈ $0.70/day at 10 minutes). Polling frequency is the main steady-state cost lever. The 90-day backfill is estimated at 115–270 pages, about 25–55 runs.

## Events

Emitted: `message.received`, `message.thread_updated`, `message.screened`, `message.urgent_detected` (after the urgency result is stored), `collection.completed`, `collection.failed`.

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
  → collection.completed {pages, new, duplicates, rejected, newCheckpoint}
```

Thread handling: a reply (`threadTs` set) whose parent is already stored emits `message.thread_updated`. If the parent is unknown, a `slack.fetch_thread` job is enqueued, and the reply is still stored with `thread_ts`.

Backfill: start checkpoint = now − 90 days, `sort_dir: asc`, ~5 pages per job, a checkpoint after every page, self-enqueue until there's no next cursor, then mark `slack.backfill` complete and hand off to `slack.messages`.

Send (approval required):

```text
draft (commitments/urgency) → approval.requested → user approves
→ revalidate permission → MessageSink.sendMessage (idempotency key)
→ on timeout/uncertain: findSentMessage before retry
→ audit → followup.sent / message reference stored
```

## Permissions and approvals

Read Slack: allowed. Send, schedule or draft a message, react, create a conversation: approval required. Collector runs get only `ToolSearch` + the read tools they need. The send job gets only `slack_send_message`. All other Slack write tools are always in `--disallowedTools`.

## Failure handling

| Situation | Handling |
|---|---|
| Connector `pending` / not connected | `connector_not_ready` → retry with backoff |
| No real tool_result from the search tool | `incomplete_ai_output` → retry; the run's text reply is ignored |
| Format change | `parse_failed` → `NEEDS_ATTENTION`, checkpoint not advanced |
| Slack rate limit | `rate_limited` → retry after delay |
| Quota above threshold | job deferred until `resetsAt` (orchestrator) |
| Auth failure | `auth_failed` → `NEEDS_ATTENTION`, notification |
| Interrupted run | next run resumes from the last committed checkpoint; dedup handles overlap |
| Uncertain send | verify via `findSentMessage`; never blind-retry |

## Configuration

| Key | Default |
|---|---|
| `slack.collection.intervalMinutes` | `10` |
| `slack.collection.maxPagesPerRun` | `5` |
| `slack.backfill.days` | `90` |
| `slack.retention.days` | `180` |
| `slack.collection.conversationTypes` | `im,mpim,private_channel,public_channel` |
| `slack.collection.onlyMyChannels` | `false` |

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
- Expired message cleanup → text cleared, IDs/permalink and derived records kept.
- Frontend closed → collection continues.

## Open questions

- OQ-1: away-mode replies vs the approval rule (affects sends).
- OQ-6: sustained Slack rate limits during backfill (only a 5-page burst tested).
- OQ-7: local bot-filter safety net (deferred per ADR-027). Slack's `include_bots: false` is trusted; the connector exposes no bot flag.

See `docs/product/open-questions.md`.
