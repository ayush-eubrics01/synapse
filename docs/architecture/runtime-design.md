# Runtime Design

## Processes

| Service | Contents | Restart |
|---|---|---|
| `synapse-api.service` | Hono API on Bun (ADR-038, ADR-039), scheduler, job processor, event dispatcher, orchestrator, health monitor | `Restart=on-failure`, backoff |
| `synapse-web.service` | Next.js server | `Restart=on-failure` |

Both are **systemd user services**. The API runs independently of the web service. Don't build a custom supervisor.

### systemd requirements (from Phase 0)

- Lingering must be on (`loginctl enable-linger <user>`), or services stop at logout. Setup checks this and tells the user.
- The service environment doesn't inherit the shell's PATH. The unit sets `PATH` explicitly to include `~/.bun/bin` (Bun) and `~/.local/bin` (`claude`). Node isn't required. The installer writes absolute paths (`ExecStart=<home>/.bun/bin/bun run --cwd <repo>/apps/api start`, plus `SYNAPSE_DB_PATH`) into `~/.config/systemd/user/`; the web unit adds `After=` and `Wants=synapse-api.service`. Templates: `scripts/setup/systemd/`; check with `bun scripts/setup/check-env.ts`.
- `claude` runs with stdin from `/dev/null`.
- Graceful shutdown on `SIGTERM` or `SIGINT` (`core/system/shutdown.ts`, wired in `main.ts`), in this order: stop the timers, wait up to 10 s for the worker (`worker.stop`), release the leases this process holds, stop the server (`server.stop(true)`, which also closes live `/api/stream` connections; a plain `stop()` would wait for them forever), checkpoint the WAL (`TRUNCATE`) and close the database. A step that throws is logged by name and error class only, and the sequence continues. A second signal while shutting down exits at once. Jobs the worker did not finish have their leases expired, and recovery reclaims them under its usual rules (external-write jobs go through verify-first or `NEEDS_ATTENTION`, never a plain retry). **The `engineering` lease is never released** (ADR-030: it outlives restarts, and recovery decides). If shutdown outlasts `TimeoutStopSec`, systemd sends SIGKILL; outside systemd the process has no SIGKILL escalation of its own (parked in the follow-ups).
- **Unit hardening** (templates in `scripts/setup/systemd/`): `StartLimitIntervalSec=300` and `StartLimitBurst=5` in `[Unit]` (five crashes in five minutes stop the restart loop), `TimeoutStopSec=30`, `UMask=0077`, `NoNewPrivileges=yes`, `KillSignal=SIGTERM`. Installing or enabling units still needs the user's approval (CLAUDE.md).
- **Status:** `bun scripts/setup/service-status.ts` is read-only. It prints `is-active` and `is-enabled` for both units, linger on or off, and the API health status (`ok`, `degraded`, `down` or `unreachable`). It prints no journal content.
- **Private files (R1).** The process sets `umask 077` at startup, and before migrations `securePrivateFiles` (`infrastructure/private-files.ts`) tightens the database, `-wal`, `-shm` and manual `*.db.bak*` copies to `0600`, only when owned by the current user, and never follows symlinks. The data directory is set to `0700` **only when it is a dedicated directory**: it is skipped for a relative database path, `/`, the home directory, an ancestor of home and the current working directory (so pointing `SYNAPSE_DB_PATH` at `~/synapse.db` never changes the mode of `~`); the files are still made private. A directory that does not exist is created `0700`. If a chmod fails, one fixed line is logged (`synapse: could not make the data files private`) and the `file_permissions` health check is `degraded`.
- Logs go to journald (structured JSON lines).
- The machine must be awake. A suspended laptop stops all work; on resume, overdue schedules run once (no catch-up storm).

## Job processing

- Durable queue in the `jobs` table. A worker claims a job by setting `lease_owner` / `lease_expires_at` in one atomic `UPDATE … WHERE status='PENDING' AND run_after<=now`, so two workers can't claim the same job.
- Lifecycle: `PENDING → RUNNING → COMPLETED`, or `RUNNING → FAILED → RETRY → RUNNING`, or `→ NEEDS_ATTENTION` / `CANCELLED`.
- Max 3 automatic retries with exponential backoff and jitter. The retry decision uses the `ErrorKind` (`integration-contracts.md`): `auth_failed`, `permission_denied`, `invalid_input`, `parse_failed` and `output_too_large` (a tool result the CLI replaced as too large; retrying the same request cannot help) are never retried blindly.
- `quota_exhausted` defers the job to `resetsAt` and doesn't count as an attempt.
- Long jobs write checkpoints (`job_checkpoints`). The backfill checkpoints after every page.
- **Concurrency groups:** jobs in the `engineering` group also need the `engineering` lease (ADR-030). The orchestrator separately limits concurrent Claude runs (`orchestrator.maxConcurrent`, default 2; see `docs/modules/claude-orchestrator.md`).

## Recovery on restart

1. Release expired job leases. Jobs whose lease expired while `RUNNING` go to `RETRY`, unless they may have done an external write.
2. For a possible external write (send, push, PR, merge): verify the outcome first (for example, look up the sent message or PR), then mark it done or retry.
3. Engineering lock: if the holder's lease expired, inspect the repository (`RepositoryProvider.getStatus`). Clean tree and no merge in progress → release and mark the task `failed` or resumable. Otherwise → `NEEDS_ATTENTION`, and the lock stays held.
4. Undispatched outbox events are dispatched again; consumers are idempotent.
5. Failed job history is kept until `retention.jobsDays` (30) has passed, then operational retention deletes it.

## Health monitoring

`core/health` exposes `/health/live` and `/health/ready` and runs periodic checks:

| Check | Signal |
|---|---|
| Database (`database`) | Writable, `journal_mode` is WAL, and the last `PRAGMA quick_check` (at startup and in the daily retention job; it runs in a worker with a read-only connection and a 5-minute timeout, and a timeout counts as failed). `ok`; `degraded` when not in WAL; `down` when quick_check failed |
| Job processor | Queue depth, oldest pending job, stuck leases |
| Claude Code | CLI present, last successful run, connector status at last init |
| Quota | Latest five-hour/seven-day utilization and reset times |
| Auth | `expiresAt`/`refreshTokenExpiresAt` recorded in `auth_snapshots` after each run (ADR-037). Detects whether the refresh expiry slides. Warns at 48 h and 2 h (`auth.expiry_warning`). `auth_failed` pauses all Claude jobs, one notification, NEEDS_ATTENTION; resume after a healthy check |
| Integrations | Last successful collection per stream, consecutive failures |
| Engineering lock | Holder, age, heartbeat |
| Backups (`backup`) | `ok` with detail "disabled" when `ops.backup.enabled` is false. `degraded` when the last attempt (`ops.backup_created` or `ops.backup_failed` in the audit log) failed, or when the newest backup is older than 36 h and the API has been up for 24 h or more. Otherwise `ok` |
| Disk (`disk`) | Free space in the data directory: `ok`; `degraded` below `ops.disk.warnFreeGiB` (5) or when unknown; `down` below 1 GiB |
| File permissions (`file_permissions`) | `degraded` when the startup chmod failed for any path (hint: run chmod 700 on the data directory) |

Every check reports `ok`, `degraded` or `down`. The overall status is the worst of them. Each new check has a label and a hint in `modules/dashboard/health-hints.ts`. `GET /api/system/runtime` returns `startedAt`, `uptimeSeconds`, `version` (package version plus git short sha, read once at startup, or null), `memoryRssBytes`, `dbBytes`, `walBytes`, `dataDirFreeBytes`, `lastBackup`, `backupCount`, `queue` counts and the retention last-run counts. The System section renders it as the Runtime panel.

## Claude execution runtime

- Each run is a child process in its own process group. Timeout or cancel kills the group.
- Stdout `stream-json` is parsed incrementally. Stderr is captured for diagnostics; it's noisy (plugin hooks), so don't treat it as failure on its own.
- Each run is recorded in `claude_runs`. The quota from each `rate_limit_event` is saved to `quota_snapshots`.
- Config: `SYNAPSE_CLAUDE_BIN` (default `~/.local/bin/claude`) and `SYNAPSE_CLAUDE_CREDENTIALS` (default `~/.claude/.credentials.json`; only the two expiry fields are read). Runs use `<data dir>/scratch` (next to the database) as the working directory.
- Credentials are shared with the user's interactive Claude Code sessions. Watch for auth failures that might come from a refresh-token rotation race (not observed yet).

## Backups and retention

Backups never leave the machine: there is no upload or remote target.

**Backup (R2)** — `core/ops/backup.ts`, job `ops.backup` (`workers/ops.ts`):

- **When.** The 15-minute scheduler tick runs the job once a day, at or after `ops.backup.hour` local time (default 3), using the internal `ops.backup.lastRunDate`. Startup enqueues the daily tick once right after the server binds (`runNow`, coalesced); the handler's `dailyDue` decides, so a missed run happens at startup, not up to 15 minutes later. The date is recorded even when the backup fails, so a failure does not retry on every tick. `POST /api/system/backups` runs one on demand (202 `{jobId}`; 409 `already_running`); a manual backup runs even when `ops.backup.enabled` is false. `GET /api/system/backups` lists `{name, bytes, createdAt}` from the directory.
- **How.** The directory is `ops.backup.dir` / `SYNAPSE_BACKUP_DIR` (an absolute path that must not be inside the repository) or `<data dir>/backups` by default (`<data dir>/synapse-backups` when the data dir is not dedicated: relative path, `/`, home, an ancestor of home or the cwd), mode `0700`; an existing directory is chmodded only when it is the dedicated default, files `0600`. Leftover `.synapse-*.tmp` files are deleted first. If free space is below 2 x the database size (plus WAL) + 1 GiB, the backup fails with `insufficient_space`. Otherwise, in a worker (below), `VACUUM INTO` a private temp file, `PRAGMA integrity_check` on the copy (must be exactly `ok`), then a hard link to `synapse-YYYYMMDD-HHMMSS.db` (local time) that never replaces an existing file (`name_conflict`), then the temp file is removed.
- **Keep N.** After success the newest `ops.backup.keep` (default 7) `synapse-*.db` files are kept, by modification time; only files matching that name are ever deleted.
- **Failure.** Failure codes are fixed: `insufficient_space`, `vacuum_failed`, `integrity_failed`, `timeout`, `name_conflict`, `dir_unavailable`, `unexpected` (plus an optional errno-style cause). The audit row is `ops.backup_failed`, the job ends FAILED (not retried), and health `backup` is degraded until the next success. Success is audited as `ops.backup_created` (name, bytes, pruned count).
- `VACUUM INTO` and the integrity check run in a Bun Worker (`core/ops/db-worker.ts`, started by `db-task.ts`) with its own read-only connection (`busy_timeout` 5 s), so a large database does not pause the API. The worker is terminated after it answers, and on a 10-minute timeout (`timeout`; the temp file is removed). A worker crash is `unexpected`. The job handler's timeout is the worker's plus one minute.

**Restore (R3, CLI only, never from the web)** — `bun scripts/ops/restore.ts <backup-file> --yes`. It is listed in CLAUDE.md under the commands that need the user's approval, because it replaces the live database. Order:

1. Refuse without `--yes` (`no_confirm`), with a missing backup (`backup_missing`) or a backup with a `-wal` next to it (`backup_has_wal`).
2. Probe the API at `/health/live`. It fails closed: only a refused connection means "down"; any answer is `api_running` and a timeout or other error is `api_state_unknown`.
3. If a live database exists, take a write lock and a full `wal_checkpoint(TRUNCATE)`. Failure or a non-zero `busy` means `database_busy`. A live database that is corrupt (not a database, or malformed) is allowed; it will be moved aside.
4. Check the backup: `PRAGMA integrity_check` exactly `ok` (`integrity_failed`), a `__drizzle_migrations` table (`not_a_synapse_backup`), and every applied migration hash known to this code (`unknown_migration`, a backup from a newer version).
5. Check free space for the copy (`insufficient_space`) and that the aside names are free (`aside_exists`).
6. **Copy the backup to a private temporary file next to the database first** (0600, fsync). A failure here changes nothing.
7. Move the live `synapse.db`, `-wal` and `-shm` to `synapse.db.before-restore-<timestamp>-<suffix>` (0600, by hard link then unlink, which never overwrites). Rename the temporary copy into place and fsync the directory. If any step fails, the moved files are renamed back and the temporary file is removed (rollback), and the result is `restore_failed`.
8. Print `restored; start the API to apply any newer migrations`.

It then prints a fixed reminder line (see the warning below). It prints names, sizes and fixed refusal codes only. A refusal exits 1. The old files are kept on disk until the user deletes them.

**Warning: a restore rewinds external-action state.** An older snapshot brings approvals and outgoing messages back in their pre-execution state. An approval or message that was executed after the snapshot was taken can show as pending or approved again, and approving it again could send it twice. After any restore, check the Outgoing and Inbox views (and Slack/Jira themselves) before approving anything.

**Operational retention (R4)** — job `ops.retention`, enqueued by the backup tick after the backup attempt (even a disabled or failed one) and run once a day. What is deleted, compacted and never touched, and the side effects (job dedupe keys held for `retention.jobsDays` only; a possible re-remind of overdue commitments and a possible repeat of a failed inspection after about 30 days), are in `database-design.md`, "Operational retention". It ends with a WAL checkpoint, `PRAGMA optimize` and `PRAGMA quick_check` (the `database` health check).

Slack-content retention (180 days) is the separate job described in `database-design.md`.

## Configuration defaults

| Key | Default |
|---|---|
| `slack.collection.intervalSeconds` | 600 |
| `slack.backfill.days` | 90 |
| `slack.collector.pagesPerRun` | 5 |
| `retention.slackContentDays` | 180 |
| `jobs.maxAttempts` | 3 |
| `orchestrator.maxConcurrent` | 2 |
| `orchestrator.quota.fiveHour.soft/hard/stop` | 0.60 / 0.85 / 0.95 |
| `orchestrator.quota.sevenDay.soft/hard` | 0.70 / 0.90 |
| `health.authExpiryWarningHours` | 48 |
| `server.host` | 127.0.0.1 |
| `ops.backup.enabled` | true |
| `ops.backup.hour` | 3 (0-23, local time) |
| `ops.backup.keep` | 7 (1-60) |
| `ops.disk.warnFreeGiB` | 5 (1-100) |
| `retention.jobsDays` | 30 (7-365) |
| `retention.notificationsDays` | 30 (7-365) |
| `retention.claudeRunsDays` | 90 (14-730) |
| `retention.auditDays` | 365 (90-3650) |
| `retention.snapshotsDays` | 30 (7-365): `quota_snapshots` and `auth_snapshots` older than this are deleted; the newest row of each table is kept |
| `SYNAPSE_BACKUP_DIR` (env) | `<data dir>/backups`; absolute, outside the repository. `ops.backup.dir` is the stored equivalent and is not editable from the web |

The nine `ops.*` and `retention.*` keys above are in the settings API allowlist and the Runtime panel. `ops.backup.lastRunDate` and `ops.retention.lastRun` are internal.

The quota thresholds are starting values, to be tuned once real usage data exists. What each level allows is defined in `docs/modules/claude-orchestrator.md`.

## Approval execution path

`approval.approved` (outbox) -> consumer `approvals.execute` -> job `approval.execute` (key `approval.execute:<approvalId>`, priority 180, `externalWrite`) -> `ApprovalEngine.execute` -> executor. Wired by `registerApprovalExecution` (`core/approvals/execution.ts`).

- Executors are registered per `(action, targetIntegration)` with `registerIntegrationExecutor`; one routing executor per action dispatches on `approval.targetIntegration`. An unknown integration fails the approval with `"no executor"`.
- The engine's claim (`execution_started_at`) guarantees at-most-once execution, so a re-delivered event or re-run job never executes twice. An executor error is terminal: the approval becomes `failed` and the job completes without retry, because the side effect may have happened. Only bookkeeping failures surface as a job error, and they never carry the payload or result.
- People profile recommendations (action `records.update`, target `people`) are applied by `ProfileService.apply` in one immediate transaction, so a failure leaves no partial version; its errors are content-free because the engine stores `e.message`. A skipped apply (stale base, superseded) ends as an executed approval with a skipped result. Because a failed approval is terminal, `retryApply` requests a fresh approval (`people.rec:<id>:<n>`) for the still-pending recommendation. See `docs/modules/people-memory.md`.
- `approval.rejected` / `approval.expired` / `approval.revoked` get no generic consumer; modules subscribe through `dispatcher.subscribe`.

**Database path and Runtime panel note.** A relative `SYNAPSE_DB_PATH` is resolved against the process cwd at config load (`:memory:` is unchanged), so every path derived from it, including the sandbox masks, is absolute. When `ops.backup.enabled` is off the Runtime panel says "Automatic backups are off; Back up now still makes one".
