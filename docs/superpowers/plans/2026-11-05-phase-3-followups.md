# Phase 3 Follow-ups and Phase 4 Entry Gate

Phase 3 (Slack collector) passed per-task reviews, a final whole-branch review, one final fix wave, and a controller smoke run against the real Claude Code CLI. This file keeps the controller rulings and the items that were deliberately deferred, so they survive after the review workspace is deleted.

## Smoke result

Run on 2026-11-05: `bun scripts/dev/slack-smoke.ts --pages 1` against the real CLI and Slack connector, on a temp DB that was deleted afterwards. Only counts were printed.

| pages | inserted | duplicates | rejected | conversations | threads enqueued | searches | run |
|---|---|---|---|---|---|---|---|
| 1 | 20 | 0 | 0 | im=3, mpim=1, channel=0 | 0 | 1 | ok |

Real-format parsing, page-chain verification and persistence all worked end to end with zero rejections.

Also found while running it: the orchestrator and auth tests never removed their temp credential fixtures (fake values only), and about 2,000 directories had piled up in `/tmp`. Both tests now clean up in `afterEach`.

## Phase 4 entry gate (urgency screening, drafts)

| # | Item | Why it matters for Phase 4 |
|---|---|---|
| Q1 | **DONE.** Done in Phase 4 (Task 8): `POST /api/slack/incremental/skip` and the "Skip unreadable page" button. **Recovery for a fail-closed parse stall.** One Slack message whose text contains a literal `### Result k of N` line makes every incremental poll fail with `parse_failed` at the same checkpoint (R41). Add a user action to skip the page or advance the checkpoint by 1 s, audited | Screening depends on the inbox staying current |
| Q2 | **DONE.** Done in Phase 4 (Task 8): failed `collect` runs carry `details.searches`; the worker counts them. **Count searches on failed runs.** `searchesToday` only counts successful runs, so the daily-limit case it exists for is under-counted. Count `tool_use` calls for the search tool on every run | Needed to learn the real daily search limit |
| Q3 | **Measure Slack search index latency** (open question). The 300 s lag (R61) is a guess | Too small an overlap silently drops messages; too large wastes search results |
| Q4 | **DONE.** Done in Phase 4 (Tasks 5 and 6): fake-binary tests through the real provider and orchestrator for assessment and suggestion. **Provider-level integration tests for every Claude-calling path.** Tests against a fake orchestrator hid the I1 mismatch. New intelligence and screening paths should each have one fake-binary test through the real `ClaudeCliProvider` | Screening adds new request shapes |
| Q5 | **DONE.** Done in Phase 4 (Task 8): documented in `docs/modules/slack.md`; the stored copy is first-seen, edits and deletes are not tracked. **Track Slack message edits and deletes**, or document that the stored copy is first-seen | Screening and commitments read stored text |

## Deferred minors (polish)

- **Orchestrator auth gate:**
  - The concurrency test relies on microtask ordering.
  - The P3 test only asserts "not quota".
  - The `recoverOrphanRuns` count is not audited.
  - A malformed `auth.pausedAt` (NaN) disables the timer probe.
  - The in-flight non-probe `auth_failed` path and the R40 ordering are untested.
  - A `settings.get` throw inside `pauseAuth` yields a spurious `auth_paused`.
- **Schema:**
  - Enum-like text columns have no SQL CHECK.
  - Several foreign keys are untested.
- **Contracts:**
  - `collection.completed` counts lack `nonnegative()`.
  - `sentAt` is not ISO-validated.
  - Some schema exports are unused.
- **Parsers:**
  - The final `Full notes:`/`Files:` lines are ambiguous (the plan mandates this form).
  - Thread pagination beyond 100 replies is ignored.
  - A marker string inside a thread reply drops the whole thread. This can hide content but cannot forge it.
- **Connector source:**
  - Dropped threads are not counted.
  - The floor lower bound, the thread-window rejection and `\b429\b` matching are untested.
- **Inbox store:**
  - The `before` cursor skips same-millisecond ties at a page boundary. A `(sentAt, id)` cursor would fix it.
  - The `expireContent` input is unguarded (NaN or negative).
  - `SyncStateService.update` loses column typing.
  - Test gaps: parent later in the page, `threadTs === ts`, rollback.
- **Jobs:** R52 can skip one scheduled poll after a late-finishing run. This was accepted; the next poll runs on schedule.
- **Routes and web:**
  - No React component tests (`SlackStatus` button states, "content expired").
  - The `zValidator` 400 body returns raw zod issues (same as `jobs.ts`).
  - The backfill button has no in-flight disable and gives no feedback on `started:false`.
- **Search counting:** see Q2.
- **Provider boundary (P7):** the regex scanner misses aliasing (`const p = this.provider; p.execute()`), destructured `execute`, `aiProvider.execute` and `this["provider"]`. An AST- or type-level boundary would close these.

## Controller rulings made during execution (Phase 3)

| ID | Ruling |
|---|---|
| R35 | Page-chain input comparison normalises primitives (`String(value)`) and ignores key order. Extra or missing keys still mismatch |
| R36 | Slack job handler timeout is 300 s |
| R37 | The backfill upper bound is the incremental checkpoint, or now if there is none |
| R38 | A failed auth probe re-arms the pause silently and throws `auth_paused`. Only the first `auth_failed` parks a job |
| R39 | `AUTH_RE` is narrowed to explicit auth phrases |
| R40 | The auth notification is sent before the pause keys are written |
| R41 | The search parser is fail-closed. It reads N from the count line and requires the block headers `Result 1..N of N` exactly; anything else throws |
| R42 | Messages outside `[floor(afterTs), beforeTs ?? now+5 min]` are rejected. The checkpoint never passes now. A thread parent's ts must equal the requested one |
| R43 | The exact observed empty-search form is accepted as zero results |
| R44 | Query date modifiers are a wide hint (±2 days). The unix `after`/`before` arguments are the exact filter |
| R45 | Bot or app thread replies are rejected and counted. Parse errors drop only that thread |
| R46 | A thread the source did not return completes the job with the audit row `slack.thread_unavailable` |
| R47 | Every missing parent enqueues one `slack.fetch_thread` job (no cap). The jobs run one at a time in group `slack.threads` |
| R48 | Checkpoint = `max(current, min(pageMax, now))` |
| R49 | A terminal backfill failure sets status `error`. `startBackfill` resumes from the checkpoint |
| R50 | Backfill is complete when the last page has no cursor. Three stalled runs set `error` |
| R51 | Backfill uses group `slack.backfill`, skips the enqueue when a PENDING or RETRY job exists, and uses generation-scoped keys |
| R52 | Incremental skips when the last success is within interval/2, or when another incremental run is RUNNING |
| R53 | State reads and writes happen in immediate transactions. Pauses are not failures. Non-JobError failures are recorded generically. `fetch_thread` input is validated |
| R54 | The dashboard backfill button is enabled for `idle` (start) and `error` (resume) |
| R55 | P7 scanner hardening. The P5 cache shares the in-flight promise; non-ok results are cached for 10 s. `before` is normalised. The paused backfill is refused |
| R56 | Retention docs state exactly what is cleared. The smoke script cleans its temp dir on signals |
| R57 | Slack requests don't set `expectedToolNames`. The source enforces ADR-026 itself, so error results stay visible: rate-limit → `rate_limited`; non-rate search error → `provider_error`; non-rate thread error → unavailable; no tool result → `incomplete_ai_output` |
| R58 | Schedules support opt-in coalescing. No enqueue while a non-terminal job of the same type exists (incremental, retention) |
| R59 | Incremental collection overlaps by `slack.collection.indexLagSeconds` (300 s) for search index lag. Mechanism superseded by R61 |
| R60 | Docs match code. `jobId` reaches `claude_runs`. Backfill `resumable` drives the dashboard Resume. `auth_failed` leaves the backfill resumable. SSE refresh is debounced |
| R61 | The incremental checkpoint is capped at `now − indexLagSeconds`, and queries read strictly after it. This is stall-free; late-indexed messages are re-read on the next poll |
| R62 | A thread pair is marked unavailable only when a THREAD tool result's input matches it. Otherwise the run fails with `incomplete_ai_output` |
