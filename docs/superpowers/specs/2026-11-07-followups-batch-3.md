# Follow-ups Batch 3: Attention Gaps, Settings Reach, Robustness and Boundaries — Design

**Authority:** ADR-033 (away-mode auto-replies), ADR-018 (retention), ADR-026 (raw tool results), `docs/architecture/module-boundaries.md`, the module docs of each area touched, and the follow-ups files of phases 1, 4, 6b, 7, 8, 9, 10 and 11. The items come from a triage of every open follow-up against the current code (2026-11-07). Items that need a product or security decision (network-enabled sandbox, approval expiry, non-GitHub hosts, Jira writes, and similar) are out of scope.

No AI runs, no external writes, no new runtime dependency. One migration (K5 indexes).

## K1: Attention gaps (phase 7, 8, 9)

| # | Decision |
|---|---|
| K1.1 | **Briefing counts unverified sends.** The overview's "sends need attention" count includes outgoing messages in `sent_unverified` as well as `needs_attention`, matching the feed. The briefing sentence and any badge use the same number. |
| K1.2 | **`jira.cloudId` can be chosen when several sites exist.** When the cloud-id resolver parks with `multiple_sites`, the API exposes the candidate sites it found (id and display name only, from the resolver's own tool result) and `jira.cloudId` becomes a user-editable setting validated against that candidate list (or any non-empty id of safe characters when no list is stored). The Jira setup panel shows a select of the candidates. Choosing one clears the parked state so the next collection uses it. Site names are shown to the user only; they are not logged or audited (audit holds the setting key only). |
| K1.3 | **Inspection permission denials are visible.** When a repository inspection run records permission denials, the repository's view carries `inspectionWarning: "permission_denied" \| null` (fixed code) and the Brain/repository card shows "The last inspection was refused some file reads; results may be incomplete." Cleared by the next inspection without denials. |

## K2: Away-mode controls (phase 6b M3)

| # | Decision |
|---|---|
| K2.1 | **`autoReply.*` settings are editable** through the existing settings API allowlist and a small "Away replies" settings group in the web: `autoReply.allowedKinds` (subset of the existing kinds), `autoReply.maxPerPersonPerDay`, `autoReply.minMinutesBetweenInThread`, `autoReply.minConfidence`, `autoReply.maxSendDelayMinutes`. Ranges never loosen ADR-033: each bound is the stricter of ADR-033's stated limit and the current schema; `maxPerPersonPerDay` accepts 0, which means "no automatic replies" (a kill switch that keeps away mode's other behaviour). Defaults stay as today. Each change is audited with the key only. The plan lists exact ranges after reading ADR-033 and `docs/modules/auto-reply.md`. Priority people and the `Sent using @claude` tag are not settable here. |

## K3: Robustness (phase 1, 11)

| # | Decision |
|---|---|
| K3.1 | **Linger check timeout.** The `loginctl` command behind the linger health check has a 3-second timeout; on timeout the process is killed and the check reads `degraded` with detail `timeout`. `/health/ready` can no longer hang on it. The shared command runner gains an optional timeout rather than a one-off. |
| K3.2 | **Scheduler isolation.** Each schedule in a scheduler tick runs in its own try/catch; one throwing task is logged with a fixed line (task name, error code) and the rest of the tick continues. Interval values are capped at 7 days at registration. |
| K3.3 | **Retention checkpoint.** `ops.retention` uses `wal_checkpoint(PASSIVE)` instead of `TRUNCATE`, so it never waits on a reader (a backup worker) while blocking the event loop. Shutdown keeps `TRUNCATE`. |
| K3.4 | **"Back up now" 409 only when a backup can overlap.** `backupJobLive` counts manual `ops.backup` jobs that are live, plus a scheduled `ops.backup` job only while it is running; a queued, not-due tick no longer blocks the button. The in-service guard (`already_running`) still prevents any real overlap. The web comment on `triggerBackup` is corrected. |

## K4: Small web fixes (phase 7, 9)

| # | Decision |
|---|---|
| K4.1 | **Remove a repository.** The repository card gets "Remove" behind a confirm step ("Remove <name> from Synapse? Files on disk are not touched."), calling the existing `DELETE /api/repos/:id`. API refusals (for example an active engineering task) show their fixed message. |
| K4.2 | **Sidebar footer ports** come from the API (`GET /api/system/runtime` or the existing config endpoint the plan finds) instead of hard-coded 7400/7401; when unavailable the footer omits them. |
| K4.3 | **Malformed overview JSON** with a 200 status is classified as "Unexpected response", not "Unreachable". |

## K5: Data and performance (phase 1, 4, 8, 9)

| # | Decision |
|---|---|
| K5.1 | **Indexes** (one migration): `job_attempts.job_id` and the other foreign-key columns the plan finds without an index (listed in the plan, checked with a test that every FK column is the leading column of some index), and `jira_issues.jira_id`. |
| K5.2 | **`skipStale` is bounded.** The urgency worker's stale-row skip only scans rows inside a recent window (rows older than the window were already handled by earlier runs), using an index. |
| K5.3 | **Project Jira summary is gated** on `jira.enabled`; when Jira is off the project view shows no Jira section rather than stale data. |

## K6: Boundaries and content hygiene (phase 6, 6b, 10)

| # | Decision |
|---|---|
| K6.1 | **Inbox stops reading `auto_replies` with raw SQL.** The auto-reply module exposes a read port (for example `autoReplyStatusFor(conversationIds)`) that the inbox calls. Behaviour is unchanged. |
| K6.2 | **The approval engine never stores raw error text.** When an executor throws, the stored error is a fixed code: a `JobError`/known error's code, else `executor_failed`. Messages are not persisted or audited. |
| K6.3 | **`include.path` / `includeIf` targets are fingerprinted.** `configFingerprint` follows `include.path` and `includeIf.*.path` entries in the repository config (and the global config it already hashes), resolving relative paths like git does, one level deep plus recursion with a depth cap of 5 and a visited set; a missing target hashes as "missing". A changed include target therefore counts as a config change everywhere the fingerprint is used. |

## Out of scope

Everything ranked C in the triage: network-enabled sandbox, approval expiry, non-GitHub hosts, protected-branch override, multi-repo tasks, Jira writes and analysis, brain feature work, activity aliases, per-person toggles, phone approvals, group profiles, form drafts beyond replies.
