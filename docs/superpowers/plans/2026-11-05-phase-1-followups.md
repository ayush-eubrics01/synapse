# Phase 1 — Follow-ups and Phase 2 Entry Gate

Phase 1 (core platform) passed per-task reviews and a final whole-branch review. This file keeps what was deliberately deferred, so it survives after the review workspace is deleted.

## Phase 2 entry gate — fix before collectors or executors land

These are harmless in Phase 1, where only heartbeat jobs exist and there are no executors. They become user-visible once Slack/Jira collectors and send/write executors exist.

| # | Item | Where | Why it matters in Phase 2 |
|---|---|---|---|
| G1 (done in Phase 2) | Per-claim lease owner token (`${workerId}:${newId()}` or match `attempts` in `owned()`) | `core/jobs/queue.ts`, `worker.ts` | After laptop suspend or a clock step, the reaper can requeue a job and the same worker id re-claims it, so a non-external job could run twice |
| G2 (done in Phase 2) | Persist handler-level `externalWrite` on the job at claim time | `worker.ts` / `queue.claim` | Today only the enqueue flag survives a crash; a crashed external write whose handler declares it could be retried |
| G3 | Boundary test misses `export … from`, side-effect `import "…"`, dynamic `import()`, bare `…/integrations` | `tests/boundaries.test.ts` | Becomes live once `apps/api/src/modules/` exists |
| G4 | Scheduler `tick` per-task isolation + cap `intervalSeconds` | `core/scheduler/scheduler.ts` | One bad user-set interval (e.g. huge) throws and stops every later schedule, including heartbeat |
| G5 | Don't store raw executor error messages; surface approvals left claimed by a crash | `core/approvals/approvals.ts`, health | Executor errors may contain message content; stuck claims are invisible |
| G6 | Timeout (or cache) for the `loginctl` linger check | `container.ts` `runCommand` | A hung `loginctl` hangs `/health/ready` and the dashboard badge |
| G7 (done in Phase 2) | Throttle "worker: claim failed" logging | `worker.ts` | About one line per second during a DB outage |
| G8 | Decide event ordering within an aggregate during consumer retries | `core/events/dispatcher.ts` | Later events are delivered while an earlier one is in backoff |

## Deferred minors (polish; fix opportunistically)

- **Shared:** `backoffMs` doesn't clamp `attempt < 1`/NaN; `FakeClock` accepts unparseable strings; no `isoAfter(clock, ms)` helper (several `new Date(clock + ms)` sites).
- **Contracts:** `STRICTNESS` typed `string[]`; event payload schemas not `.strict()`; `Job` contract has no `output`.
- **Database:**
  - `database-design.md` lacks some implementer-chosen columns (approvals/notifications `created_at`, `claude_runs` token column names, link-table id PKs).
  - Several status columns are untyped text.
  - No indexes on FK columns (e.g. `job_attempts.job_id`).
  - Heartbeat adds about 1,440 job rows a day with no retention yet.
- **Config/settings:** the loopback check is case-sensitive with no `[::1]`; `Number()` accepts `1e3`/`0x10` ports; `system.lastHeartbeatAt` isn't validated as an ISO datetime; an unknown runtime key gives a TypeError.
- **Outbox:**
  - LiveBus forwarding waits until all consumers settle.
  - Empty `catch {}` in live-bus.
  - A NULL `correlationId` is coerced to `""`.
  - One shared mutable event object is passed to all handlers.
  - No duplicate consumer-name guard.
- **Queue/worker:**
  - `closeAttempt` closes all running rows for the job.
  - Attempt numbers repeat after defer.
  - Shutdown aborts burn an attempt (use defer semantics).
  - `start()` during a pending `stop()` can create two loops.
  - A freed slot waits up to `pollMs`.
  - No option validation.
- **Leases/scheduler:** dedup is counted as enqueued; a cron with no future run silently stops; a few untested paths.
- **Approvals:**
  - Idempotency-key reuse with a different payload is silent.
  - `request(db, …)` without a tx isn't atomic.
  - `decidedAt` is overwritten by revoke/expire.
  - An unknown id maps to 409 instead of 404 in `execute`.
  - A new `correlationId` per event.
  - The expiry regex checks shape, not calendar validity.
- **Registry/health:** the FK pragma is forced ON rather than restored; `validate()` checks all persisted modules (stale rows after a rename would crash boot); module names are invented with no dependency edges.
- **API/process:**
  - `idleTimeout: 0` is global.
  - Mark-read on an unknown id returns 200.
  - The port-in-use path migrates before binding.
  - No startup log line.
  - Process tests pipe stderr without reading it.
  - Host allowlist uses the configured web port only.
- **Web:** overlapping refreshes and actions are unordered; approve/reject buttons aren't disabled in flight; `apps/web/app/**` is typechecked only by `next build`.
- **Setup:** `renderUnit` scans its output for leftovers; unit values are unquoted (spaces, `%` or `$` in paths); the installer doesn't mention `bun run --cwd apps/web build`; `next.config` captures `SYNAPSE_API_PORT` at build time.

## Controller rulings made during execution

| ID | Ruling |
|---|---|
| R1 | `scheduled_tasks.priority` (default 100) |
| R2 | `jobs.output` json replaces `output_ref` |
| R3 | Setting `system.lastHeartbeatAt` |
| R4 | `settings.set(..., { emit })`; heartbeat doesn't emit events |
| R5 | Notifications push LiveBus `{ type: "notification" }` |
| R6 | `test.noop` handler behind `SYNAPSE_TEST_HANDLERS=1` |
| R7 | Biome ignores generated code |
| R8 | Outbox consumer retries use backoff (`next_attempt_at`) |
| R9 | `audit_events.details` persisted |
| R10 | `quota_exhausted` without `retryAfter` defers 15 min |
| R11 | API tests are typechecked |
| R12 | Read-then-write transactions use `behavior: "immediate"` |
| R13 | `user_only` operations can't be requested via approvals |
| R14 | Reject/revoke `reason` stays optional |
| R15 | `next-env.d.ts` gitignored; Next's `AGENTS.md` committed |
| R16 | Final fix wave scope (critical + important before merge; rest deferred here) |
