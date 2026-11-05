# Phase 3 — Slack Collector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A persistent local store of every human Slack message the user can see. It is collected through the claude.ai Slack connector via the Phase 2 orchestrator: a 10-minute incremental poll, a user-started 90-day backfill, thread completion and 180-day content retention. The data is shown in the dashboard. Before any of that, the Phase 3 entry-gate items from Phase 2 are closed.

**Architecture:**
- `integrations/slack/` holds pure parsers for the connector's markdown-in-JSON output, plus a `SlackConnectorSource` (the `MessageSource` port). It builds collector `ClaudeJobRequest`s, runs them through `ClaudeOrchestrator`, verifies every page's tool input and cursor chain, and parses only raw tool results.
- `modules/inbox/` owns the Slack tables. It persists pages with deduplication, advances checkpoints in the same transaction, links threads and emits events.
- Job handlers in `workers/slack.ts` wire the port into the module.
- Routes and a dashboard panel expose the inbox and sync status.

**Tech Stack:** Bun 1.4.4, TypeScript 7, Hono, Zod 4, Drizzle (bun-sqlite), Next.js 16. No new runtime dependencies.

**Spec:** `docs/modules/slack.md`, `docs/architecture/integration-contracts.md` §2, `docs/architecture/database-design.md` (Slack tables, platform `integrations*`), `docs/architecture/event-system.md`, ADR-025, ADR-026, ADR-027, ADR-017, ADR-018, ADR-037 §4, `docs/superpowers/plans/2026-11-05-phase-2-followups.md` (Phase 3 entry gate P1–P8), and `apps/api/test/fixtures/slack/README.md` (the observed output format).

**Out of scope:** `MessageSink` and sending (Phase 4/6 drafts and approvals); conversation discovery via `slack_list_user_channels` (conversations are derived from messages); urgency screening (Phase 4); People Memory (Phase 5).

## Global Constraints

- Everything in the Phase 1 and 2 Global Constraints still applies. That includes R11, R12 and R34; never running the real `claude` binary in tests; and never logging content.
- Collection uses only `mcp__claude_ai_Slack__slack_search_public_and_private`. Every page's arguments are exactly:
  - `query: "after:<YYYY-MM-DD of checkpoint>"` (plus `before:<date>` for the backfill upper bound)
  - `after: "<checkpoint unix seconds>"`
  - `before: "<unix seconds>"` (backfill only)
  - `sort: "timestamp"`, `sort_dir: "asc"`, `limit: 20`
  - `include_bots: false`, `include_context: false`, `response_format: "detailed"`
  - `cursor` from the previous page (absent on page 1).

  `slack_read_channel` is never used for collection.
- Threads use only `mcp__claude_ai_Slack__slack_read_thread` with `channel_id`, `message_ts` and `limit: 100`.
- **Trust:** data comes only from `RawToolResult`s whose `toolName` and `input` match the request the code asked for. A page whose input differs (wrong args, or a cursor that isn't the previous page's next cursor) ends the accepted chain at the previous page.
- **Dedup key:** unique(`conversation_id`, `ts`). The checkpoint is the newest stored `ts`, committed in the same transaction as that page's rows.
- Every message must have a `U…` sender ID, a channel ID and a `Message_ts`. Anything else is rejected and counted, never stored. Only human senders get through: `include_bots: false` plus the sender-ID check (ADR-027, OQ-7 minimal check).
- Message text may be returned by the inbox API to the local dashboard. It is never written to logs, audit rows or event payloads (events carry ids and counts only).
- **Pacing (docs/modules/slack.md):**
  - incremental every `slack.collection.intervalSeconds` (600), up to `slack.collector.pagesPerRun` (5) pages per run;
  - backfill runs at least `slack.backfill.minMinutesBetweenRuns` (3) apart;
  - on `rate_limited`, the backfill gap doubles up to `slack.backfill.maxBackoffMinutes` (30);
  - at most `slack.threads.maxFetchesPerRun` (5) thread fetches per run.
- **The backfill never starts by itself.** The user starts it from the dashboard or API.

## Review Focus

1. **The model mangles or skips a cursor** in a multi-page run: data from pages after the break must not be stored, and the checkpoint must not jump past unfetched pages. Test in Task 5.
2. **Message text contains `---`, `Text:` or `### Result`-like lines:** the parser must not split or mis-assign fields. Test in Task 4.
3. **The connector returns an empty result or zero messages:** the run must succeed with 0 new messages, the checkpoint must stay unchanged, and nothing may loop. Test in Tasks 4 and 7.
4. **A reply arrives whose parent was never collected:** it is stored with `thread_ts`, and exactly one fetch-thread job is enqueued (idempotent across polls). Test in Task 6.
5. **Claude auth fails while polling every 10 minutes:** one NEEDS_ATTENTION job and one notification, after which other Claude jobs defer (they don't each fail) until a probe succeeds. Test in Task 1.

---

## File Structure

```text
packages/contracts/src/{messages.ts, events.ts, errors.ts}        MessageSource types; new events; auth_paused kind
packages/database/src/schema/platform.ts (+ new migration)          integrations*, slack_* tables
apps/api/src/core/orchestrator/{orchestrator.ts, quota-gate.ts, stream-parser.ts, auth.ts}   entry gate P1–P4, P6
apps/api/src/integrations/slack/
  search-parser.ts        parseSearchResult(content) (pure)
  thread-parser.ts        parseThreadResult(content, channelId) (pure)
  connector-source.ts     SlackConnectorSource implements MessageSource
apps/api/src/modules/inbox/
  store.ts                InboxStore: persistPage, conversations/users, thread linkage, retention
  sync-state.ts           SyncStateService over integration_sync_states
apps/api/src/workers/slack.ts                 job handlers + schedules
apps/api/src/routes/{inbox.ts, slack.ts}
apps/web/app/components/{InboxPanel.tsx, SlackStatus.tsx}
scripts/dev/slack-smoke.ts                    controller-only real collection on a temp DB
```

---

### Task 1: Orchestrator entry gate (P1 auth pause, P2 reset cap, P3 quota text, P4 top-level rate info, P6 orphan runs)

**Files:**
- Modify: `packages/contracts/src/errors.ts`, `apps/api/src/core/orchestrator/{orchestrator.ts, quota-gate.ts, stream-parser.ts, auth.ts}`, `apps/api/src/integrations/claude-code/cli-provider.ts`, `apps/api/src/container.ts` / `main.ts`, `apps/api/src/core/config/settings.ts`
- Test: `apps/api/test/orchestrator/*.test.ts`, `packages/contracts/test/errors.test.ts`

**Interfaces:**
- Produces:
  - `ErrorKind` gains `"auth_paused"`, with `retryDecision("auth_paused") === "defer"`.
  - Settings `auth.pausedAt: string | null` and `auth.pausedRefreshExpiresAt: string | null`.
  - `ClaudeOrchestrator.run`:
    - If `auth.pausedAt` is set, it throws `JobError({ kind: "auth_paused", retryAfter: now + 15 min })` without spawning.
    - Exception (the probe): if `pausedAt` is ≥ 30 min old, or the current credentials `refreshExpiresAt` differs from `auth.pausedRefreshExpiresAt`, one run is allowed through. Success clears the pause.
    - When a run returns `auth_failed`, it sets the pause (if not already set), creates one notification `{ kind: "claude.auth_paused", severity: "high" }` and still throws `auth_failed`. That job goes to NEEDS_ATTENTION; later jobs defer.
  - `AuthMonitor.record()` is called once at startup, in `main.ts` after `createContainer`.
  - **P2:** any window `resetsAt` later than `observedAt + 8 days` is capped to `observedAt + 8 days`, in the parser or when the snapshot is built.
  - **P3:** the provider's text-based quota regex becomes `/usage limit|rate limit|quota (exceeded|exhausted|reached)/i`.
  - **P4:** when `rate_limit_info.unifiedWindows` is absent, the top-level `rate_limit_info.{status, resetsAt, rateLimitType}` maps onto window `five_hour` or `seven_day` according to `rateLimitType` (`"five_hour"` or `"seven_day"`; anything else → `five_hour`).
  - **P6:** `recoverOrphanRuns(db, clock): number` marks every `claude_runs` row with status `running` as `failed`, with error `{ kind: "unknown", message: "interrupted by restart" }`. It is called at startup next to `recoverOnStartup`.
  - `ClaudeOrchestrator` gains a `notifications: NotificationService` dependency.

- [ ] **Step 1: Write failing tests:**
  - an `auth_failed` result → pause set, one notification, and a second `run` throws `auth_paused` with no provider call;
  - after 30 min, a probe run goes through and its success clears the pause;
  - a changed refresh expiry lets a probe through immediately;
  - a 20-day `resetsAt` is capped at 8 days;
  - "the quota was refreshed" is not classed as `quota_exhausted`, while "usage limit reached" is;
  - a top-level-only rejected `rate_limit_event` with `rateLimitType: "seven_day"` → the seven-day window is rejected;
  - `recoverOrphanRuns` marks running rows failed and leaves other rows untouched;
  - `retryDecision("auth_paused") === "defer"`.
- [ ] **Step 2: Run** `bun test apps/api/test/orchestrator packages/contracts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same tests, then `bun run check` → PASS.
- [ ] **Step 5: Commit** `fix(orchestrator): auth pause, reset cap, narrower quota text, top-level rate info, orphan run sweep`.

### Task 2: Database schema for integrations and Slack

**Files:**
- Modify: `packages/database/src/schema/platform.ts`; new generated migration `0005_slack`
- Modify: `docs/architecture/database-design.md`
- Test: `packages/database/test/slack-schema.test.ts`

**Interfaces:**
- Produces tables per `database-design.md`, plus these additions:
  - `integrations` (`id`, `kind`, `adapter`, `config` json, `enabled`, `created_at`); unique (`kind`, `adapter`).
  - `integration_capabilities` (per the doc).
  - `integration_sync_states`: `id`, `integration_id` FK, `stream`, `checkpoint` (text, Slack ts), `cursor`, `status` (`idle` | `running` | `paused` | `complete` | `error`), `last_success_at`, `last_error` json, `upper_bound` (text, nullable; the backfill's `before`), `pages_done` int default 0, `search_count_date` (text YYYY-MM-DD, nullable), `search_count` int default 0, `next_run_after` (text, nullable), `backoff_minutes` int default 0; unique (`integration_id`, `stream`).
  - `slack_conversations`: `id`, `external_id` unique, `type` (`im` | `mpim` | `channel`), `name`, `accessible` bool default true, `last_seen_ts`.
  - `slack_users`: `id`, `external_id` unique, `name`, `email`, `is_bot` nullable.
  - `slack_messages`: `id`, `conversation_id` FK, `ts`, `thread_ts`, `sender_user_id` FK, `text` (nullable), `full_notes` (nullable), `permalink`, `reply_count`, `sent_at`, `collected_at`, `content_expired_at`, `screening` json, `urgency_level`, `urgency_reason`, `urgency_status`; unique (`conversation_id`, `ts`); indexes on (`sent_at`), (`conversation_id`, `thread_ts`), (`urgency_level`, `urgency_status`).
  - `slack_attachments` and `slack_message_references`: per the doc.

- [ ] **Step 1: Write failing tests:**
  - migrations create all eight tables;
  - inserting a duplicate (`conversation_id`, `ts`) throws;
  - a duplicate (`integration_id`, `stream`) throws;
  - the `slack_messages.sender_user_id` FK is enforced.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Generate the migration with `bunx --bun drizzle-kit generate --name slack` from `packages/database`; never edit old migrations. Update the doc for the added columns.
- [ ] **Step 4: Run** `bun test packages/database` and `bun run check` → PASS.
- [ ] **Step 5: Commit** `feat(database): integrations and slack tables`.

### Task 3: Message contracts and events

**Files:**
- Create: `packages/contracts/src/messages.ts`
- Modify: `packages/contracts/src/events.ts`, `index.ts`, `apps/web/lib/live-events.ts`, `docs/architecture/integration-contracts.md` §2, `docs/architecture/event-system.md`
- Test: `packages/contracts/test/messages.test.ts`

**Interfaces:**
- Produces:
  - `type ConversationType = "im" | "mpim" | "channel"`. Public and private channels can't be told apart from the label; update the contracts doc.
  - `interface SourceMessage { externalId: string /* `${conversationId}:${ts}` */; conversationId: string; conversationType: ConversationType; conversationName?: string; ts: string; threadTs?: string; senderId: string; senderName?: string; senderEmail?: string; text: string; fullNotes?: string; permalink?: string; replyCount?: number; sentAt: string /* ISO from ts */ }`
  - `sourceMessageSchema`, a Zod schema: `senderId` matches `/^U[A-Z0-9]+$/`, `ts` matches `/^\d{10}\.\d{6}$/`, `conversationId` matches `/^[CDG][A-Z0-9]+$/`.
  - `interface MessagePage { messages: SourceMessage[]; rejected: number; nextCursor?: string }`
  - `interface CollectRequest { afterTs: string; beforeTs?: string; maxPages: number }` and `interface CollectResult { pages: MessagePage[]; searches: number; complete: boolean /* no next cursor after the last accepted page */ }`
  - `interface MessageSource { collect(req: CollectRequest, signal: AbortSignal): Promise<CollectResult>; fetchThreads(requests: { conversationId: string; parentTs: string }[], signal: AbortSignal): Promise<{ conversationId: string; parentTs: string; messages: SourceMessage[] }[]> }`
  - Events with id/count payloads only:
    - `message.received` `{ messageId: string }`
    - `message.thread_updated` `{ messageId: string }`
    - `collection.completed` `{ stream: string; pages: number; inserted: number; duplicates: number; rejected: number }`
    - `collection.failed` `{ stream: string; kind: ErrorKind }`
  - These are added to the catalog, the catalog-key tests and `LIVE_EVENT_TYPES`.

- [ ] **Step 1: Write failing tests:**
  - `sourceMessageSchema` accepts a valid message;
  - it rejects a bot-like sender `B0123`, a bad ts `1793872884`, and a bad conversation id;
  - the new events parse, and reject `{}`;
  - the exact catalog key set is updated.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test packages/contracts apps/web` and `bun run check` → PASS.
- [ ] **Step 5: Commit** `feat(contracts): message source types and collection events`.

### Task 4: Slack output parsers

**Files:**
- Create: `apps/api/src/integrations/slack/{search-parser.ts, thread-parser.ts}`
- Test: `apps/api/test/integrations/slack-parsers.test.ts` (uses `apps/api/test/fixtures/slack/*.json`)

**Interfaces:**
- Consumes: `SourceMessage`, `sourceMessageSchema`, `MessagePage`.
- Produces:
  - `class SlackParseError extends Error`.
  - `parseSearchResult(content: string): MessagePage`:
    - JSON-parses the envelope. It must have string `results`; `pagination_info` is a string or missing. Anything else → `SlackParseError`.
    - Splits blocks on lines matching `^### Result \d+ of \d+$`.
    - Header fields are read only from the lines before the first `Text: ` line. The text is every line after `Text: ` up to an optional final `Full notes: ` line, or up to the block's trailing `\n\n---\n` separator. Only the block's LAST `---` counts as the separator.
    - Maps:
      - `Channel` label: `DM` → `im`, `Group DM` → `mpim`, `#name` → `channel`, with the name taken without `#`. Any other label → `SlackParseError`.
      - `From: Name <email> (ID: U…)` gives name, email and id.
      - `Message_ts`.
      - `Reply count`.
      - The permalink's `thread_ts` query parameter gives `threadTs`, set only when it differs from `ts`.
      - `sentAt` is computed from `ts`.
    - Each block is validated with `sourceMessageSchema`. Failures increment `rejected`.
    - `nextCursor` comes from `` /cursor `([^`]+)`/ `` in `pagination_info`.
    - A body without the `# Search Results for:` header → `SlackParseError`.
    - A body with a `## Messages (0 results)` header (or no blocks) → `{ messages: [], rejected: 0 }`.
  - `parseThreadResult(content: string, conversationId: string): SourceMessage[]`:
    - JSON envelope with string `messages`.
    - Sections `=== THREAD PARENT MESSAGE ===` and `=== THREAD REPLIES (N total) ===`; replies are split on `--- Reply i of N ---`.
    - Each message: `From: Name <email> (U…)`, `Time:`, `Message TS:`, text lines, and an optional final `Files:` line, which is excluded from the text.
    - The parent's `ts` becomes `threadTs` for every reply. The parent itself gets no `threadTs`.
    - `conversationType` is passed in or looked up later; use `"im"` as a placeholder. The store keeps the existing conversation row's type.
    - A missing parent section → `SlackParseError`.

- [ ] **Step 1: Write failing tests**, one fixture each:
  - `search-group-dm` → 2 messages, `mpim`, conversation `C0SYNTHGDM1`, sender emails, nextCursor `U1lOVEhFVElDQ1VSU09SMQ==`;
  - `search-channel` → `channel`, name `synthetic-team-channel`, the multi-line text containing `---` and `Text: not a label inside text` preserved exactly, `fullNotes` "synthetic huddle notes" kept out of the text, nextCursor undefined;
  - `search-thread-replies` → the reply has `threadTs` `1793872920.000500`, the parent has no `threadTs` and `replyCount` 2;
  - `search-missing-ts` → 1 message, `rejected` 1;
  - `search-format-drift` → `SlackParseError`;
  - a body with `## Messages (0 results)` → empty page;
  - `read-thread` → 3 messages, both replies with `threadTs` of the parent, the mention text kept, the `Files:` line excluded.
- [ ] **Step 2: Run** `bun test apps/api/test/integrations/slack-parsers.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same test and `bun run check` → PASS.
- [ ] **Step 5: Commit** `feat(slack): parsers for connector search and thread output`.

### Task 5: Slack connector source (MessageSource over the orchestrator)

**Files:**
- Create: `apps/api/src/integrations/slack/connector-source.ts`
- Test: `apps/api/test/integrations/slack-connector-source.test.ts`

**Interfaces:**
- Consumes: `ClaudeOrchestrator.run` (Phase 2), the Task 4 parsers, `MessageSource`, `JobError`.
- Produces `class SlackConnectorSource implements MessageSource { constructor(deps: { orchestrator: Pick<ClaudeOrchestrator, "run">; clock: Clock }) }`.
  - **`collect(req, signal)`:**
    - Builds one collector request:
      - `workerProfile: "collector"`, `priorityClass: req.beforeTs ? "backfill" : "collection"`;
      - `allowedTools: [SEARCH]`, `expectedToolNames: [SEARCH]`, `maxTurns: req.maxPages + 3`;
      - instructions that name the tool and the exact JSON arguments for page 1, then: "If the result's pagination_info contains a cursor and you have made fewer than N calls, call the tool again with identical arguments plus that cursor. Stop when there is no cursor. Reply DONE."
    - Then walks `result.toolResults` in order, keeping only `toolName === SEARCH` and `!isError`. Page k is accepted only if:
      - its `input` equals the expected arguments exactly (deep-equal, ignoring key order);
      - for k ≥ 2, `input.cursor` equals page k−1's `nextCursor`.
    - The first mismatch ends the chain.
    - `complete` = the last accepted page has no `nextCursor`. `searches` = the count of search tool_results.
    - Error classification:
      - an error tool_result whose text matches `/ratelimit|rate.limit|429/i` → throw `JobError({ kind: "rate_limited", retryAfter })`, where retryAfter is the `Retry-After` seconds if present in the text, else now + 60 s; if the text matches `/daily/i`, the next UTC midnight;
      - zero accepted pages when the first result is a non-error with a mismatched input → `JobError(incomplete_ai_output)`;
      - a `SlackParseError` on any page → `JobError(parse_failed)`, with no partial data from that page onward.
  - **`fetchThreads(requests, signal)`:**
    - Takes at most `requests.length` read_thread calls in one collector run: `allowedTools: [THREAD]`, `maxTurns: n + 3`, instructions listing each exact `{ channel_id, message_ts, limit: 100 }`.
    - Accepts only results whose input matches one requested pair, and parses each with `parseThreadResult`.
    - Unanswered requests are simply missing from the output.
- Constants: `SEARCH = "mcp__claude_ai_Slack__slack_search_public_and_private"`, `THREAD = "mcp__claude_ai_Slack__slack_read_thread"`.

- [ ] **Step 1: Write failing tests** with a fake orchestrator returning canned `AIExecutionResult`s built from the Task 4 fixtures:
  - a 2-page chain (page 2 input carries page 1's cursor) → 2 pages accepted, complete;
  - page 2 with a wrong cursor → only page 1 accepted, `complete` false;
  - page 1 with `include_bots: true` → `incomplete_ai_output`;
  - a parse error on page 2 → `parse_failed`;
  - a rate-limit error tool_result containing "Retry-After: 30" → `rate_limited` with retryAfter now + 30 s;
  - "daily limit" → next UTC midnight;
  - the request the fake receives has `priorityClass` `backfill` iff `beforeTs` is set, the exact arguments (page-1 JSON includes `before` only for backfill), and `maxTurns` = pages + 3;
  - `fetchThreads` with 2 requested and 1 answered → 1 result; an answer for an unrequested pair is ignored.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same test and `bun run check` → PASS.
- [ ] **Step 5: Commit** `feat(slack): connector source with page-chain verification`.

### Task 6: Inbox store and sync state

**Files:**
- Create: `apps/api/src/modules/inbox/{store.ts, sync-state.ts}`
- Test: `apps/api/test/modules/inbox-store.test.ts`, `apps/api/test/modules/sync-state.test.ts`

**Interfaces:**
- Consumes: Task 2 tables, Task 3 types and events, `EventPublisher`, `JobQueue.enqueue`, `Clock`.
- Produces:
  - `class SyncStateService { constructor(db, clock); ensureIntegration(kind: "slack", adapter: "claude-connector"): string; get(stream: "slack.messages" | "slack.backfill"): SyncState; update(tx, stream, patch: Partial<SyncState>): void; countSearches(tx, stream, n: number): number /* resets per UTC day, returns today's count */ }`
  - `interface SyncState { stream; checkpoint: string | null; upperBound: string | null; status; pagesDone: number; lastSuccessAt: string | null; lastError: ClassifiedError | null; nextRunAfter: string | null; backoffMinutes: number; searchCount: number; searchCountDate: string | null }`
  - `class InboxStore { constructor(deps: { db; clock; events: EventPublisher; queue: JobQueue; sync: SyncStateService }) }`:
    - `persistPage(stream, page: MessagePage, opts: { maxThreadFetches: number }): { inserted: number; duplicates: number; threadFetches: number }`. In ONE immediate transaction it:
      - upserts users and conversations (an existing conversation's type is kept);
      - inserts messages with `onConflictDoNothing` on (`conversation_id`, `ts`);
      - for each inserted message emits `message.received`, plus `message.thread_updated` if `threadTs` is set and the parent row exists;
      - if the parent is missing, enqueues `slack.fetch_thread` with idempotency key `slack.thread:<conversationId>:<threadTs>`, up to `maxThreadFetches` per page;
      - advances the stream checkpoint to the max `ts` of the page if that is greater than the current checkpoint.
    - `storeThread(conversationId, messages: SourceMessage[]): { inserted: number }` does the same dedup, with no checkpoint change.
    - `listMessages({ limit, beforeSentAt?, conversationId? })`, newest first, joined with the conversation and sender names.
    - `expireContent(olderThanDays: number): number` sets `text = NULL`, `full_notes = NULL` and `content_expired_at = now` for messages with `sent_at < now − days` and `content_expired_at IS NULL`.

- [ ] **Step 1: Write failing tests:**
  - the same page persisted twice → second time `inserted` 0 and `duplicates` 2, with no duplicate events;
  - checkpoint advances to the max ts and never moves backwards;
  - a reply with an unknown parent → stored with `thread_ts` and exactly one fetch job, even across two polls (idempotent);
  - a reply whose parent exists → `message.thread_updated`;
  - a page with 0 messages → checkpoint unchanged;
  - event payloads contain no text (assert the text string is absent from `domain_events`);
  - `countSearches` resets on a new UTC day;
  - `expireContent` clears the text but keeps ts and permalink;
  - `listMessages` order and filter.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** `modules/inbox` must not import `integrations/**` (boundary test).
- [ ] **Step 4: Run** the tests and `bun run check` → PASS.
- [ ] **Step 5: Commit** `feat(inbox): store with dedup, checkpoints, thread linkage, retention`.

### Task 7: Slack jobs and schedules

**Files:**
- Create: `apps/api/src/workers/slack.ts`
- Modify: `apps/api/src/container.ts` (register handlers and schedules), `apps/api/src/core/config/settings.ts`
- Test: `apps/api/test/workers/slack-jobs.test.ts`

**Interfaces:**
- Consumes: `MessageSource`, `InboxStore`, `SyncStateService`, `JobQueue`, `SettingsService`, `EventPublisher`.
- Produces:
  - New settings:
    - `slack.collection.enabled` (bool, true)
    - `slack.backfill.minMinutesBetweenRuns` (3)
    - `slack.backfill.maxBackoffMinutes` (30)
    - `slack.threads.maxFetchesPerRun` (5)
  - `registerSlackJobs(deps): Map<string, HandlerRegistration>`, plus schedules. The handlers:
    - **`slack.collect_incremental`:** timeout = orchestrator collector timeout + 30 s; schedule every `slack.collection.intervalSeconds`, skipped when not enabled.
      - On first run, sets the `slack.messages` checkpoint to `now − 1 day`.
      - Calls `collect({ afterTs: floor(checkpoint), maxPages })`, then `persistPage` for each page.
      - Counts searches.
      - Emits `collection.completed`.
      - On JobError, emits `collection.failed` and rethrows.
    - **`slack.backfill`:**
      - Started by `startBackfill()`, which sets stream `slack.backfill` status `running`, checkpoint = now − `slack.backfill.days`, upper bound = the incremental start, and enqueues the first job. It is idempotent: it does nothing if the status is running or complete.
      - Each run calls `collect({ afterTs, beforeTs: upperBound, maxPages })` and persists the pages.
      - If `complete` → status `complete`.
      - Otherwise it re-enqueues itself with `runAfter = now + minMinutes + backoff`.
      - On `rate_limited` it doubles `backoffMinutes`, to at most the maximum, and re-enqueues with `runAfter = retryAfter ?? now + backoff`, instead of failing.
      - On success the backoff resets to 0.
      - Idempotency key `slack.backfill:<checkpoint>`.
    - **`slack.fetch_thread`:** calls `fetchThreads` for its single pair, then `storeThread`.
    - **`slack.retention_cleanup`:** daily schedule; no Claude; calls `expireContent(retention.slackContentDays)`.
  - `startBackfill(): { started: boolean; state: SyncState }` is exported for the route.

- [ ] **Step 1: Write failing tests** with a fake `MessageSource`:
  - the first incremental run sets a now − 1 day checkpoint and persists;
  - an empty collect → `collection.completed` with inserted 0, and no re-enqueue loop;
  - backfill start → running; one run → re-enqueued with the min gap; a complete run → status complete with no further job;
  - `rate_limited` → backoff doubles 0 → 3 → 6 … capped at 30 and the job is deferred, not failed;
  - a second `startBackfill` while running does nothing;
  - retention calls `expireContent` with 180;
  - `slack.collection.enabled=false` → the scheduled job skips without calling the source.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests and `bun run check` → PASS.
- [ ] **Step 5: Commit** `feat(slack): incremental, backfill, thread and retention jobs`.

### Task 8: Routes, dashboard, wiring, P5 and P7

**Files:**
- Create: `apps/api/src/routes/{inbox.ts, slack.ts}`, `apps/web/app/components/{InboxPanel.tsx, SlackStatus.tsx}`
- Modify: `apps/api/src/app.ts`, `apps/api/src/container.ts`, `apps/web/app/page.tsx`, `apps/web/lib/api.ts`, `apps/api/src/core/health/checks.ts` (P5), `tests/boundaries.test.ts` (P7)
- Test: `apps/api/test/routes.test.ts`, `apps/web/test/api.test.ts`, `tests/boundaries.test.ts`

**Interfaces:**
- Produces:
  - `GET /api/inbox/messages?limit=1..200&before=<iso>&conversationId=` → `{ id, conversation: { id, name, type }, sender: { id, name }, sentAt, text: string | null, permalink, threadTs, replyCount }[]`, newest first.
  - `GET /api/slack/status` → `{ incremental: SyncState, backfill: SyncState, searchesToday: number }`.
  - `POST /api/slack/backfill` → `startBackfill()` result (200).
  - The container builds `SlackConnectorSource(orchestrator)`, `InboxStore` and `SyncStateService`, registers the Slack jobs, and exposes `Container.inbox` and `Container.sync`.
  - `lib/api.ts`: `getInboxMessages(limit?)`, `getSlackStatus()`, `startBackfill()`.
  - `InboxPanel` lists the latest 50 messages: conversation, sender, time, a text snippet (or "content expired") and a link. `SlackStatus` shows the incremental checkpoint and last success, the backfill state with a "Start 90-day backfill" button (disabled unless `idle`), and searches today. Both refresh on `message.received`, `collection.completed` and `collection.failed`.
  - **P5:** `claudeCheck` caches the provider health for 60 s (an injectable TTL).
  - **P7:** a boundary test fails if any file other than `apps/api/src/core/orchestrator/**` and `apps/api/src/container.ts` references `.provider.execute(` or imports `ClaudeCliProvider`.

- [ ] **Step 1: Write failing tests:**
  - **Routes** (fake provider, in-memory container):
    - messages newest first, filter by conversation, limit 0 → 400;
    - status returns both streams;
    - `POST /api/slack/backfill` starts once, and a second call reports already running.
  - **P5:** two `/health/ready` calls within 60 s → the provider's `getHealth` is called once.
  - **P7:** the boundary test passes on the current tree and fails on a planted violation (test the scanner function with a synthetic file string).
  - **Web:** API URLs.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, `bun run check` and `bun run --cwd apps/web build` → PASS.
- [ ] **Step 5: Commit** `feat(api,web): inbox and slack status routes and panels; health cache; provider boundary`.

### Task 9: Smoke script, docs, follow-ups

**Files:**
- Create: `scripts/dev/slack-smoke.ts`, `scripts/dev/test/slack-smoke.test.ts`
- Modify: `CLAUDE.md` (Commands), `docs/modules/slack.md` (implementation notes: page-chain verification, conversation types, backfill start), `docs/superpowers/plans/2026-11-05-phase-2-followups.md` (mark P1–P8 done), `docs/superpowers/plans/2026-11-05-phase-1-followups.md` if relevant
- Test: argument parsing / summary formatting only

**Interfaces:**
- Produces `bun scripts/dev/slack-smoke.ts [--pages N]` (default 1, max 3). It builds a real container on a TEMP DB, runs one incremental collect with `afterTs = now − 1 day`, persists the pages, and prints only counts: pages, inserted, duplicates, rejected, conversations by type, threads enqueued, search count, run status. It never prints message text, names or emails. The temp dir is deleted at the end. The test covers only argument parsing and a `summarize` that is proven to drop text.

- [ ] **Step 1: Write the failing tests.**
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement the script and docs.**
- [ ] **Step 4: Run** `bun test scripts/dev` and `bun run check` → PASS.
- [ ] **Step 5: Commit** `feat(dev): slack smoke script; docs for slack collector`.
- [ ] **Step 6 (controller only, after the final review):** run `bun scripts/dev/slack-smoke.ts --pages 1` once. This is a real but tiny read of the user's Slack, on a temp DB that is then deleted. Record the counts in the PR.

---

## Phase 3 Definition of Done

- `bun run check` passes, with no real `claude` in tests.
- The incremental poll stores new human messages with no duplicates, and its checkpoint advances only through verified page chains.
- The backfill starts only on request, paces itself, survives rate limits and finishes.
- Missing thread parents are fetched once. Content expires after 180 days.
- The dashboard shows the inbox and sync status, with a backfill start button.
- The entry-gate items P1–P8 are closed.
- A real smoke collection succeeds and prints counts only.
