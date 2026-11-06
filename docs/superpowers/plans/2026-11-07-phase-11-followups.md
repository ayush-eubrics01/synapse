# Phase 11 follow-ups

Items parked during Phase 11 (dashboard customisation and runtime hardening). None blocks the phase.

## Backup and database

- **`VACUUM INTO` and `quick_check` run synchronously on the API thread.** A large database pauses requests while they run. Fine at about 1 MB; move them off the event loop (a worker or a separate process) before the database grows a lot.
- **A missed daily backup waits for the first 15-minute tick after startup.** There is no run at startup itself. A backup that was due while the API was down happens within 15 minutes of the next start.
- **A manual backup runs even when `ops.backup.enabled` is false.** Intended (the user asked), but the Runtime panel does not say so.
- **Backup names use local time.** In the DST fall-back hour two backups can sort by name differently from their mtime. Pruning and listing use mtime, so nothing is deleted wrongly.

## Retention

- **`quota_snapshots` and `auth_snapshots` are not pruned.** They grow slowly; add them to `ops.retention` with a setting if the size ever matters.
- **Retention frees the idempotency keys of deleted jobs.** After `retention.jobsDays` (30) a job with the same key can be enqueued again. The domain state guards the known replays, but this has not been audited per job type. Two consequences seen in review: read commitment reminders are pruned with their notifications, so an overdue commitment can be reminded about again after about 30 days; and a failed repository inspection may run again after about 30 days.
- **`reminders.ts` keeps its own local-time helper.** It is not yet folded into `core/ops/daily.ts` (`dailyDue`, `localDateString`), which the backup tick uses.

## Shutdown

- **No SIGKILL escalation outside systemd.** Under systemd, `TimeoutStopSec=30` ends a stuck shutdown. Run by hand, a shutdown that hangs after the first signal needs a second signal (which exits at once).
- **`USER` unset.** `service-status.ts` falls back to `os.userInfo()` for the linger query when `USER` is not set; review parked it as a minor.
- **Shutdown order test.** Review parked a stronger test of the shutdown step order as a minor.

## Dashboard layouts (web)

- **A failed `getLayouts` after a layout switch keeps the old active id.** The switch succeeded on the server, the refetch failed, and the page shows the previous layout's id until the next refresh.
- **An edit between a save flush and the lock can be lost.** A customise action made after a layout switch starts flushing, but before the switch takes effect, may be applied to the old layout or dropped.
- **An unsent composer draft is lost when a customise action remounts or collapses a section.** Component-local state is not preserved across the remount.
- **Navigation reveals are temporary and local.** Going to a hidden or collapsed section shows it until the next layout load; it is not saved.
- **`list()` re-activates a layout when none is active** (for example after a manual database edit): the most recently updated row, audited as actor `system`.
