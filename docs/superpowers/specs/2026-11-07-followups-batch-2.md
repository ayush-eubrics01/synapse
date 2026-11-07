# Follow-ups Batch 2: Dashboard Fixes, Engineering History, Develop Retry and Runtime Polish — Design

**Authority:**
- ADR-023 (dashboard widgets), ADR-030 (one engineering task, lock), ADR-040 (sandboxed test commands), ADR-018 (retention).
- `docs/modules/web-dashboard.md`, `docs/modules/engineering-tasks.md`.
- The follow-ups files `2026-11-07-phase-11-followups.md` and `2026-11-06-phase-10-followups.md`. This batch closes the items named below and ticks them there.

No AI runs, no external writes, no new runtime dependency. One migration only if the plan finds a column is needed for H2 (the preference is none).

## H1: Dashboard layout and composer fixes (Phase 11 follow-ups)

| # | Decision |
|---|---|
| H1.1 | **Composer drafts survive remounts.** An unsent reply draft (Inbox composer, code-answer edit box, and any other textarea whose loss the plan finds on a customise action) is kept in a small module-level draft store in `apps/web` keyed by `<kind>:<id>` (for example `reply:<messageId>`). The component reads its initial value from the store and writes every change to it. The entry is cleared on a successful send or an explicit discard. The store lives in memory only (no `localStorage`: drafts may hold Slack text, and Slack text is never persisted by the web). A page reload loses drafts, as today. Collapsing, hiding then restoring, moving and resizing a section, or switching layout, keep the draft. |
| H1.2 | **Layout switch is serialised.** While a switch (activate) is in flight, customise actions are disabled (buttons `disabled`, ⌘K "Customise dashboard" still opens). Before activating, any pending debounced save of the current layout is flushed and awaited. If the flush fails, the switch does not happen and the failure toast "Couldn't save the layout" shows. An action can therefore never land on the wrong layout or be dropped. |
| H1.3 | **A switch uses the server's answer.** `POST /api/dashboard/layouts/:id/activate` returns the same body as `GET /api/dashboard/layouts`. The web applies that body directly, so a failed follow-up fetch can no longer leave the previous active id on screen. If the activate call itself fails, the toast "Couldn't switch the layout" shows and the page keeps the old layout. |

## H2: Engineering history shows cleanup outcomes (Phase 10 follow-up)

| # | Decision |
|---|---|
| H2.1 | **API.** The engineering task list (`GET /api/engineering/tasks`) includes, for each terminal task (`completed`, `cancelled`, `failed`), a `cleanup` field: `null`, or `{ branchKept: boolean, pushedNotPr: boolean, dirtyTree: boolean, priorStatus: string \| null }`, read from what the cleanup step already records. Fixed values only; no paths, branch names or text. If a value is not recorded today the plan says so and the field is `false`/`null`, not a new guess. |
| H2.2 | **Web.** History rows show small badges: "Branch kept", "Pushed, no PR", "Uncommitted changes left", and "Cancelled from <priorStatus label>" when present. No badge when `cleanup` is `null`. |

## H3: Retry the develop step (Phase 10 / batch 1 follow-up)

| # | Decision |
|---|---|
| H3.1 | **API.** `POST /api/engineering/tasks/:id/retry-develop` is allowed only when the task is `needs_attention` at step `develop` with reason `sandbox_unavailable`, `sandbox_disabled` or `sandbox_path_too_long`. The engineering lock is still held by the task (needs_attention keeps it). Checks, in order: task exists (404 `not_found`); status/step/reason match (409 `not_retryable`); `engineering.sandbox.enabled` is true (409 `sandbox_disabled`); the `sandbox` health check (bwrap and socat present) is ok (409 `sandbox_unavailable`). Then, in one transaction, the task returns to the status it has while develop runs, its reason is cleared, and a fresh develop step job is enqueued (new idempotency key, for example `<taskId>:develop:<attempt>`). Audited as `engineering.develop_retried` (ids only). A second call while the job is pending is 409 `not_retryable`. |
| H3.2 | **Web.** The Needs-you card for those three reasons gets a "Try again" button (keeping the existing hint). The cancel action stays available. Errors map to short fixed messages. |
| H3.3 | **`sandbox_path_too_long`** keeps its current hint; retry only helps after the user shortens `XDG_CACHE_HOME` and restarts. |

## H4: Runtime and configuration polish (Phase 11 and Phase 10 follow-ups)

| # | Decision |
|---|---|
| H4.1 | **Backups and quick_check off the event loop.** `VACUUM INTO`, the backup's `PRAGMA integrity_check` and the daily `PRAGMA quick_check` run in a Bun `Worker` (`new Worker(new URL(...))`, built in, no dependency) that opens its own `bun:sqlite` connection to the database file (WAL lets it read while the API writes). The main thread awaits a message `{ ok, code?, ... }`. The worker has a timeout (backup 10 minutes, quick_check 5 minutes); on timeout it is terminated, the temp file removed, and the failure is the fixed code `timeout`. All existing behaviour (names, keep-N, space check, audits, health) stays the same. Tests run the real worker against a temp database. |
| H4.2 | **Missed backup runs at startup.** Once the server is listening, the daily tick runs once immediately (then every 15 minutes as today), so a backup due while the API was down happens at start. |
| H4.3 | **Runtime panel note.** When `ops.backup.enabled` is false, the Runtime panel shows "Automatic backups are off; Back up now still makes one". |
| H4.4 | **Snapshot retention.** `ops.retention` also deletes `quota_snapshots` and `auth_snapshots` rows older than `retention.snapshotsDays` (new setting, 7–365, default 30), always keeping the newest row of each table. Counts join the `ops.retention_ran` audit. |
| H4.5 | **Relative `SYNAPSE_DB_PATH`** is resolved to an absolute path at config load (against the process cwd), so the data-directory mask is absolute. |
| H4.6 | **Run root inside a mask.** When the instance run root (`<XDG_CACHE_HOME or ~/.cache>/synapse/<8hex>`) is inside a sandbox mask (a home deny entry, `/tmp`, `/run`, `/var/run`, the data or backup dir), the develop step fails with the fixed reason `sandbox_root_masked` (needs_attention) and the hint "Set XDG_CACHE_HOME to a directory outside ~/.config and the other protected folders, then restart Synapse and try again." The `sandbox` health check is degraded with the same hint. `retry-develop` (H3.1) also accepts this reason. |
| H4.7 | **Old instance directories are pruned.** At startup, after this instance's own sweep, directories `~/.cache/synapse/<8 hex>` other than this instance's are removed when they are real directories (no symlinks), and nothing inside them was modified in the last 7 days. Anything else is left. Counts are logged as one fixed line. |
| H4.8 | **Lint warning.** The unused Hono import in the check output is removed. |

## Out of scope

- Network-enabled sandboxes (needs its own ADR).
- Approval expiry, multi-repo tasks, non-GitHub hosts.
- Persisting drafts across reloads.
- The idempotency-key audit after retention (recorded, not addressed).
