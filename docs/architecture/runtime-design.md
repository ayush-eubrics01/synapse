# Runtime Design

## Processes

| Service | Contents | Restart |
|---|---|---|
| `synapse-api.service` | Hono API on Bun (ADR-038, ADR-039), scheduler, job processor, event dispatcher, orchestrator, health monitor | `Restart=on-failure`, backoff |
| `synapse-web.service` | Next.js server | `Restart=on-failure` |

Both are **systemd user services**. The API runs independently of the web service. Don't build a custom supervisor.

### systemd requirements (from Phase 0)

- Lingering must be on (`loginctl enable-linger <user>`), or services stop at logout. Setup checks this and tells the user.
- The service environment doesn't inherit the shell's PATH. The unit sets `PATH` explicitly to include `~/.bun/bin` (Bun) and `~/.local/bin` (`claude`). Node isn't required. The installer writes absolute paths (`ExecStart=<home>/.bun/bin/bun run --cwd <repo>/apps/api start`, plus `SYNAPSE_DB_PATH`) into `~/.config/systemd/user/`; the web unit adds `After=synapse-api.service`. Templates: `scripts/setup/systemd/`; check with `bun scripts/setup/check-env.ts`.
- `claude` runs with stdin from `/dev/null`.
- Graceful shutdown on `SIGTERM`: stop claiming jobs, let running non-engineering Claude runs finish within a grace period or abort them, keep the engineering lock lease (recovery decides), flush logs.
- Logs go to journald (structured JSON lines).
- The machine must be awake. A suspended laptop stops all work; on resume, overdue schedules run once (no catch-up storm).

## Job processing

- Durable queue in the `jobs` table. A worker claims a job by setting `lease_owner` / `lease_expires_at` in one atomic `UPDATE … WHERE status='PENDING' AND run_after<=now`, so two workers can't claim the same job.
- Lifecycle: `PENDING → RUNNING → COMPLETED`, or `RUNNING → FAILED → RETRY → RUNNING`, or `→ NEEDS_ATTENTION` / `CANCELLED`.
- Max 3 automatic retries with exponential backoff and jitter. The retry decision uses the `ErrorKind` (`integration-contracts.md`): `auth_failed`, `permission_denied`, `invalid_input` and `parse_failed` are never retried blindly.
- `quota_exhausted` defers the job to `resetsAt` and doesn't count as an attempt.
- Long jobs write checkpoints (`job_checkpoints`). The backfill checkpoints after every page.
- **Concurrency groups:** jobs in the `engineering` group also need the `engineering` lease (ADR-030). The orchestrator separately limits concurrent Claude runs (`orchestrator.maxConcurrent`, default 2; see `docs/modules/claude-orchestrator.md`).

## Recovery on restart

1. Release expired job leases. Jobs whose lease expired while `RUNNING` go to `RETRY`, unless they may have done an external write.
2. For a possible external write (send, push, PR, merge): verify the outcome first (for example, look up the sent message or PR), then mark it done or retry.
3. Engineering lock: if the holder's lease expired, inspect the repository (`RepositoryProvider.getStatus`). Clean tree and no merge in progress → release and mark the task `failed` or resumable. Otherwise → `NEEDS_ATTENTION`, and the lock stays held.
4. Undispatched outbox events are dispatched again; consumers are idempotent.
5. Failed job history is kept.

## Health monitoring

`core/health` exposes `/health/live` and `/health/ready` and runs periodic checks:

| Check | Signal |
|---|---|
| Database | Writable, WAL OK, last backup age |
| Job processor | Queue depth, oldest pending job, stuck leases |
| Claude Code | CLI present, last successful run, connector status at last init |
| Quota | Latest five-hour/seven-day utilization and reset times |
| Auth | `expiresAt`/`refreshTokenExpiresAt` recorded in `auth_snapshots` after each run (ADR-037). Detects whether the refresh expiry slides. Warns at 48 h and 2 h (`auth.expiry_warning`). `auth_failed` pauses all Claude jobs, one notification, NEEDS_ATTENTION; resume after a healthy check |
| Integrations | Last successful collection per stream, consecutive failures |
| Engineering lock | Holder, age, heartbeat |

## Claude execution runtime

- Each run is a child process in its own process group. Timeout or cancel kills the group.
- Stdout `stream-json` is parsed incrementally. Stderr is captured for diagnostics; it's noisy (plugin hooks), so don't treat it as failure on its own.
- Each run is recorded in `claude_runs`. The quota from each `rate_limit_event` is saved to `quota_snapshots`.
- Config: `SYNAPSE_CLAUDE_BIN` (default `~/.local/bin/claude`) and `SYNAPSE_CLAUDE_CREDENTIALS` (default `~/.claude/.credentials.json`; only the two expiry fields are read). Runs use `<data dir>/scratch` (next to the database) as the working directory.
- Credentials are shared with the user's interactive Claude Code sessions. Watch for auth failures that might come from a refresh-token rotation race (not observed yet).

## Backups and retention

- Daily database backup to a configured directory, keeping N copies. A restore procedure is documented in `scripts/maintenance/`.
- Daily retention job (180-day Slack content) as described in `database-design.md`.

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

The quota thresholds are starting values, to be tuned once real usage data exists. What each level allows is defined in `docs/modules/claude-orchestrator.md`.

## Approval execution path

`approval.approved` (outbox) -> consumer `approvals.execute` -> job `approval.execute` (key `approval.execute:<approvalId>`, priority 180, `externalWrite`) -> `ApprovalEngine.execute` -> executor. Wired by `registerApprovalExecution` (`core/approvals/execution.ts`).

- Executors are registered per `(action, targetIntegration)` with `registerIntegrationExecutor`; one routing executor per action dispatches on `approval.targetIntegration`. An unknown integration fails the approval with `"no executor"`.
- The engine's claim (`execution_started_at`) guarantees at-most-once execution, so a re-delivered event or re-run job never executes twice. An executor error is terminal: the approval becomes `failed` and the job completes without retry, because the side effect may have happened. Only bookkeeping failures surface as a job error, and they never carry the payload or result.
- People profile recommendations (action `records.update`, target `people`) are applied by `ProfileService.apply` in one immediate transaction, so a failure leaves no partial version; its errors are content-free because the engine stores `e.message`. A skipped apply (stale base, superseded) ends as an executed approval with a skipped result. Because a failed approval is terminal, `retryApply` requests a fresh approval (`people.rec:<id>:<n>`) for the still-pending recommendation. See `docs/modules/people-memory.md`.
- `approval.rejected` / `approval.expired` / `approval.revoked` get no generic consumer; modules subscribe through `dispatcher.subscribe`.
