# Phase 11: Dashboard Customisation and Runtime Hardening — Design

**Authority:**
- ADR-023: customizable dashboard widgets.
- ADR-006 and ADR-007: the persistent runtime and systemd user services.
- ADR-018: retention.
- `concept.md` §16, "Local Runtime and Process Management", and its Phase 10 list: configurable widgets, layouts, settings, service installation, crash recovery, retention cleanup, backup and restore, operational monitoring.
- `docs/modules/web-dashboard.md` and `docs/modules/dashboard.md`.

Two parts on one branch. No AI runs, no external writes, and no new runtime dependency.

## Part D: Dashboard customisation (ADR-023)

### Principle

The page's sections are the widgets. The user can reorder, hide, collapse and resize them, and can save named layouts. Layouts live in the database, and the web only renders what the API returns (CLAUDE.md rule 6).

| # | Decision |
|---|---|
| D1 | **Table `dashboard_layouts`** (migration 0021): `id`, `name` (1–40 characters, unique), `is_active`, `layout` (json), `created_at`, `updated_at`. A partial unique index allows only one active row. |
| D2 | **Layout schema** (`packages/contracts/src/dashboard-layout.ts`, Zod, strict): `{ version: 1, sections: [{ id, visible: boolean, collapsed: boolean, width: "full" \| "half" }] }`.<br>`id` comes from the registry `DASHBOARD_SECTION_IDS`: every current section except the header (`overview`), which is always first and always shown. Examples: `triage`, `running`, `inbox`, `commitments`, `people`, `projects`, `engineering`, `jira`, `system`, plus any section added since Phase 7. The plan lists the exact ids from `apps/web`.<br>**Normalisation** (pure `normaliseLayout`, backend): unknown ids are dropped, duplicates keep their first occurrence, and missing ids are appended with their default (visible, expanded, default width). This means a new section appears for users who have an older stored layout.<br>`triage` (Needs you) is always `visible: true` and never `collapsed`, so pending approvals can never be hidden. A request that tries either is normalised back, not refused. |
| D3 | **Default layout** is the Phase 7 order and widths: `triage` and `running` half width, the rest full width. If the table is empty at first read, a row named "Default" is created and made active. |
| D4 | **API** (`routes/dashboard-layouts.ts`):<br>- `GET /api/dashboard/layouts` → `{ active: LayoutView, layouts: [{ id, name, isActive, updatedAt }] }`.<br>- `POST /api/dashboard/layouts {name, fromId?}` creates a layout, copied from `fromId` or the active one. 409 `name_taken`. At most 10 layouts: 409 `limit_reached`.<br>- `PUT /api/dashboard/layouts/:id {name?, layout?}` stores the normalised layout and returns it.<br>- `POST /api/dashboard/layouts/:id/activate`.<br>- `POST /api/dashboard/layouts/:id/reset` replaces the layout with the default and keeps the name.<br>- `DELETE /api/dashboard/layouts/:id` returns 409 `active_layout` for the active layout and 409 `last_layout` for the only one.<br>Every write is audited (`dashboard.layout_*`, ids only) and publishes `dashboard.layout_changed {layoutId}`. Error bodies are fixed codes. |
| D5 | **Web.**<br>- A "Customise" toggle in the header, also reachable from ⌘K ("Customise dashboard").<br>- In customise mode each section shows a toolbar: Move up, Move down, Hide (absent on Needs you), Collapse/Expand, and Half/Full width. These are buttons, keyboard accessible, with no drag-only interaction.<br>- A "Hidden sections" tray restores a hidden section.<br>- A layout picker: switch, save as new, rename, delete, reset.<br>- Changes are saved with PUT, debounced 500 ms. Failures show the toast "Couldn't save the layout" and the page reloads the stored layout.<br>- Outside customise mode, sections render in layout order. Hidden sections are not rendered and not in the sidebar.<br>- A collapsed section renders its header and its count badge only, and expands on click (local and temporary unless saved in customise mode).<br>- Two consecutive visible `half` sections share a row from 1100 px wide. A lone `half` section takes the full row. Below 1100 px everything stacks, as today.<br>- Sidebar badges keep their counts even when the section is collapsed. |

## Part R: Runtime hardening

### Principle

Synapse holds months of Slack text and must survive crashes, restarts, a full disk and mistakes. Backups and restores stay on this machine. Monitoring is local and read-only.

| # | Decision |
|---|---|
| R1 | **Private files.** At startup, before migrations, the API sets the data directory (the parent of `SYNAPSE_DB_PATH`) to `0700`, and the database file plus its `-wal` and `-shm` to `0600`, when they are owned by the current user. `process.umask(0o077)` is set at startup. New files and backups are created private. If chmod fails, the API logs one fixed line and sets health `file_permissions` to degraded, with the hint "Synapse's data files are readable by other users; run chmod 700 on the data directory". The service units also get `UMask=0077`. Older manual backups found next to the database (`*.db.bak*`) are chmodded to `0600` the same way. |
| R2 | **Backups.**<br>- **When:** the job `ops.backup` runs daily, at or after `ops.backup.hour` local time (default 3). The mechanism is the same as the Phase 10b reminders: a 15-minute coalesced tick plus an internal `ops.backup.lastRunDate`. It runs again at startup if missed. It can also be run on demand with `POST /api/system/backups` (202 `{jobId}`; 409 `already_running`).<br>- **How:** `VACUUM INTO '<dir>/.synapse-<ts>.tmp'`, then open that file read-only, run `PRAGMA integrity_check` (must return exactly `ok`), and rename it to `synapse-YYYYMMDD-HHMMSS.db`. The directory is `ops.backup.dir` (default `<dataDir>/backups`, mode `0700`), and files are `0600`.<br>- **Retention and space:** keep the newest `ops.backup.keep` (default 7) and delete older `synapse-*.db` files in that directory only. Leftover `.tmp` files are deleted. Before writing, if free disk space is below 2 × the database size + 1 GiB, the backup is skipped with failure `insufficient_space`.<br>- **Results:** backups are listed from the directory, not recorded in a table. `GET /api/system/backups` → `[{ name, bytes, createdAt }]`. A failure is audited (`ops.backup_failed`, fixed code) and sets health `backup` to degraded. Success is audited as `ops.backup_created` (name and bytes).<br>- **Scope:** backups never leave the machine. There is no upload or remote target. |
| R3 | **Restore (CLI only, never from the web).** `bun scripts/ops/restore.ts <backup-file> --yes`:<br>(1) Refuse unless `--yes` is given.<br>(2) Refuse when the API answers on `127.0.0.1:<port>/api/health`, or when `BEGIN IMMEDIATE` on the live database fails (busy).<br>(3) Refuse unless the backup passes `PRAGMA integrity_check`.<br>(4) Refuse if the backup has applied migrations the current code does not know (its `__drizzle_migrations` holds a hash missing from the repo journal).<br>(5) Move the live `synapse.db`, `-wal` and `-shm` to `synapse.db.before-restore-<ts>` (0600).<br>(6) Copy the backup into place as 0600.<br>(7) Print "restored; start the API to apply any newer migrations".<br>It prints names and sizes only. Because it overwrites the user's data, it is listed in CLAUDE.md under commands that need the user's approval. |
| R4 | **Operational retention** (daily job `ops.retention`, after the backup).<br>- **Delete:** jobs in a terminal state (`COMPLETED`, `CANCELLED`, and `FAILED`) older than `retention.jobsDays` (30); read notifications older than `retention.notificationsDays` (30); delivered outbox events older than 7 days; audit rows older than `retention.auditDays` (365).<br>- **Compact `claude_runs` older than `retention.claudeRunsDays` (90):** null their large columns (raw stream, tool results, final text, whatever the schema holds; the plan lists them), keeping id, status, timing, usage and cost. A row with inbound foreign keys is compacted, never deleted, so no foreign key breaks.<br>- **Never touched:** approvals, outgoing messages, auto_replies, security flags, engineering tasks and commitments. They are the user's records; their text is already handled by Slack-content retention.<br>- **Finish and limits:** after pruning, `PRAGMA wal_checkpoint(TRUNCATE)` and `PRAGMA optimize`. Deletes run in batches of 500 per transaction, so the API stays responsive. Counts are audited as `ops.retention_ran`. |
| R5 | **Monitoring.** `GET /api/system/runtime` → `{ startedAt, uptimeSeconds, version (package.json version + git short sha read once at startup, or null), memoryRssBytes, dbBytes, walBytes, dataDirFreeBytes (statfs), lastBackup: { name, createdAt } \| null, backupCount, queue: { pending, running, retry, needsAttention, oldestPendingAgeSeconds } }`.<br>New health checks:<br>- `backup`: ok; degraded when there has been no successful backup in 36 h (only once the API has been up for 24 h), or when the last attempt failed; ok, with detail "disabled", when `ops.backup.enabled` is false.<br>- `disk`: degraded below `ops.disk.warnFreeGiB` (default 5) free in the data dir; failing below 1 GiB.<br>- `database`: the result of `PRAGMA quick_check` run at startup and daily in `ops.retention`.<br>- `file_permissions` (R1).<br>Each gets a label and hint in `health-hints.ts`. The web adds a "Runtime" panel in System, showing the values above, the backups list with "Back up now", and the retention last-run counts. |
| R6 | **Service units and status.**<br>- Unit templates gain: `StartLimitIntervalSec=300` and `StartLimitBurst=5` (in `[Unit]`), `TimeoutStopSec=30`, `UMask=0077`, `NoNewPrivileges=yes`; and for web, `After=` and `Wants=synapse-api.service`.<br>- Graceful shutdown in `main.ts` stops the scheduler, waits for the worker (10 s), releases leases held by this process, closes the server, checkpoints the WAL and closes the database. A second signal exits immediately.<br>- New read-only `bun scripts/setup/service-status.ts` prints, for each unit, `is-active`, `is-enabled` and linger on/off, plus the API health status from `/api/health`. It prints no journal content.<br>- Installing or enabling the units still needs the user's approval (CLAUDE.md). This phase does not run them. |
| R7 | **Settings** (Phase 10b settings API allowlist extended): `ops.backup.enabled` (true), `ops.backup.hour` (0–23, 3), `ops.backup.keep` (1–60, 7), `ops.disk.warnFreeGiB` (1–100, 5), `retention.jobsDays` (7–365, 30), `retention.notificationsDays` (7–365, 30), `retention.claudeRunsDays` (14–730, 90), `retention.auditDays` (90–3650, 365). `ops.backup.dir` is settable by env or config only, not the web: an absolute path, which must not be inside the repository. Internal: `ops.backup.lastRunDate`, `ops.retention.lastRun` (json counts). |

## Out of scope

- Multiple dashboard pages.
- Drag-and-drop.
- Per-widget data filters.
- Remote or cloud backups.
- Encrypting backups at rest (the files are 0600 under a 0700 directory; full-disk encryption is the OS's job).
- Automatic restore.

## Tests (beyond each unit's own)

- `normaliseLayout`: unknown ids, duplicates, missing ids, `triage` hidden or collapsed.
- The layout API error codes, including the last and the active layout.
- The web customise mode: move, hide, restore, width pairing, collapsed rendering, and the failure toast.
- R1 on a temp dir (modes before and after; a chmod failure becomes degraded health).
- Backup: integrity success; a corrupt tmp is deleted; the keep-N prune touches only `synapse-*.db`; insufficient space is skipped.
- Restore script: every refusal (no `--yes`, API up, busy DB, corrupt backup, unknown migration), and a successful swap on temp files.
- Retention: batch deletes; compaction keeps foreign keys valid (`PRAGMA foreign_key_check` empty); protected tables untouched.
- Runtime API shape.
- Health checks.
- Graceful shutdown releases leases.
