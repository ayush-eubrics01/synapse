# Phase 11 follow-ups

Items parked during Phase 11 (dashboard customisation and runtime hardening). None blocks the phase.

## Backup and database

- ~~**`VACUUM INTO` and `quick_check` run synchronously on the API thread.**~~ **Done in follow-ups batch 2.** Both run in a Bun Worker with their own connection. Original note: A large database pauses requests while they run. Fine at about 1 MB; move them off the event loop (a worker or a separate process) before the database grows a lot.
- ~~**A missed daily backup waits for the first 15-minute tick after startup.**~~ **Done in follow-ups batch 2.** The API runs the backup tick right after the port binds. Original note: There is no run at startup itself. A backup that was due while the API was down happens within 15 minutes of the next start.
- ~~**A manual backup runs even when `ops.backup.enabled` is false.**~~ **Done in follow-ups batch 2.** The Runtime panel now says so when automatic backups are off. Original note: Intended (the user asked), but the Runtime panel does not say so.
- **Backup names use local time.** In the DST fall-back hour two backups can sort by name differently from their mtime. Pruning and listing use mtime, so nothing is deleted wrongly.

## Retention

- ~~**`quota_snapshots` and `auth_snapshots` are not pruned.**~~ **Done in follow-ups batch 2.** Pruned by `retention.snapshotsDays` (30), keeping the newest row of each table. Original note: They grow slowly; add them to `ops.retention` with a setting if the size ever matters.
- **Retention frees the idempotency keys of deleted jobs.** After `retention.jobsDays` (30) a job with the same key can be enqueued again. The domain state guards the known replays, but this has not been audited per job type. Two consequences seen in review: read commitment reminders are pruned with their notifications, so an overdue commitment can be reminded about again after about 30 days; and a failed repository inspection may run again after about 30 days.
- **`reminders.ts` keeps its own minutes helper.** It already imports `localDateString` from `core/ops/daily.ts`; only the minutes helper is still local.

## Shutdown

- **No SIGKILL escalation outside systemd.** Under systemd, `TimeoutStopSec=30` ends a stuck shutdown. Run by hand, a shutdown that hangs after the first signal needs a second signal (which exits at once).
- **`USER` unset.** `service-status.ts` falls back to `os.userInfo().username` (then `unknown`) for the linger query; fixed after the final review.
- **Shutdown order test.** Review parked a stronger test of the shutdown step order as a minor.

## Dashboard layouts (web)

- ~~**A failed `getLayouts` after a layout switch keeps the old active id.**~~ **Done in follow-ups batch 2.** Original note: The switch succeeded on the server, the refetch failed, and the page shows the previous layout's id until the next refresh.
- ~~**An edit between a save flush and the lock can be lost.**~~ **Done in follow-ups batch 2.** Original note: A customise action made after a layout switch starts flushing, but before the switch takes effect, may be applied to the old layout or dropped.
- ~~**An unsent composer draft is lost when a customise action remounts or collapses a section.**~~ **Done in follow-ups batch 2.** Scope (decision 1): only the composer draft survives a customise action; other forms do not (see the new item below). Original note: Component-local state is not preserved across the remount.
- **Navigation reveals are temporary and local.** Going to a hidden or collapsed section shows it until the next layout load; it is not saved.
- **`list()` re-activates a layout when none is active** (for example after a manual database edit): the most recently updated row, audited as actor `system`.
- **Other form fields still lose text on a remount.** Only the composer draft is kept. The engineering text edits (commit message, PR title and body), New task, Register repository, project notes, commitment edits, Jira setup and the recommendation reason are component-local state and are lost when a customise action remounts their section.
- **`terminate()` cannot interrupt an in-flight native `VACUUM`.** When the backup worker times out, the process-side `terminate()` does not stop a `VACUUM INTO` already running in native code; the temporary file and its disk space are held until it finishes.

## Final review of follow-ups batch 2 (parked)

- **"Try again" after a mid-run `sandbox_unavailable` with edits always answers `changes_left`.** The button is still shown; the user must cancel and propose again.
- **`runTmpTooLong` assumes the 8-hex scratch name.** A 12- or 16-hex fallback name can pass the pre-check and then be refused again; harmless.
- **The instance-root prune walk is synchronous and unbounded.** It runs once at startup over `<cache>/synapse`.
- **A tiny walk-to-`rm` race** in that prune: an entry touched between the age walk and the removal can still be deleted.
- **Retention's `wal_checkpoint(TRUNCATE)` can block the event loop** for up to `busy_timeout` while a worker read snapshot is open; `PASSIVE` would avoid it.
- **"Back up now" answers 409 while a scheduled backup tick is queued.** `backupJobLive` counts any live `ops.backup` job, including the 15-minute tick that is not due. With both worker slots busy the tick can wait for minutes. A sharper rule: manual jobs live, or a scheduled job running (the in-service guard already prevents a real overlap). The comment on `triggerBackup` in `apps/web/lib/api.ts` still says "manual backup".
