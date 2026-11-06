# Claude Activity

Implements the observation half of ADR-036 (Phase 10b, part A). Synapse watches the user's **interactive** Claude Code sessions in registered repositories, yields background Claude work while the user is active, shows recent sessions and session PRs, and sends work-in-progress reminders to the user only. It makes no AI calls and never writes under `~/.claude`. Spec: `docs/superpowers/specs/2026-11-06-phase-10b-activity-code-answer.md` (A1 to A12).

Code: `apps/api/src/modules/claude-activity` (`session-meta.ts`, `scanner.ts`, `service.ts`, `reminders.ts`), `workers/claude-activity/index.ts`, `routes/claude-activity.ts`, `core/orchestrator/yield-gate.ts`. Web: `apps/web/app/components/system/ClaudeCodeCard.tsx`, `ClaudeSettings.tsx`.

## Privacy (ADR-036)

Only these fields are ever copied out of a session line: `sessionId`, `cwd`, `gitBranch`, `timestamp`, `version`, `entrypoint`, `aiTitle` (`ai-title` lines) and `prUrl` / `prNumber` / `prRepository` (`pr-link` lines). The pure function `extractSessionMeta` builds a fresh object from those fields and drops the parsed line; a test puts a sentinel in every other field and line type (prompts, assistant text, tool data, thinking) and asserts it appears nowhere. No session title, branch, path or cwd is logged, audited, published in an event, thrown in a message or stored in a job error: ids, counts and fixed codes only. The title and branch are user data shown only in the Overview card, as plain text.

## Scanning

- **Candidates (A2).** Only directories under the projects dir (`claudeActivity.projectsDir`, default `~/.claude/projects`) whose name is the Claude Code encoding of a registered repository's path (every character outside `[A-Za-z0-9]` becomes `-`), or that encoding followed by `-`. Only top-level `*.jsonl` files; never `subagents/` or `tool-results/`. Symlinks are skipped (`lstat`, `O_NOFOLLOW`) and each file's realpath must stay inside the projects dir. Unrelated folders are never opened.
- **Incremental (A3).** A file whose size and mtime are unchanged is skipped. Otherwise it is read from `file_offset`, at most 4 MiB per file per scan, complete lines only (a partial tail waits). A line over 1 MiB is skipped unparsed and counted; a tail that is oversized is skipped. Parse errors are counted and skipped. A file that shrinks below its offset is re-read from 0 (and re-matched).
- **Repository match (A4).** The first `cwd` (realpath when it exists, trailing slash normalised) must equal a registered repository's `local_path` or lie under it. A sibling such as `demo-app-two` never matches `demo-app`. A session outside every registered repository is never stored; an in-memory ignored-file map (path, size, mtime, pruned) avoids re-reading it.
- **Activity (A5).** `last_at` is the later of the last parsed timestamp and the file mtime. A timestamp more than 5 minutes in the future is ignored for `last_at`, so a skewed clock cannot make the user look active forever. A session is active when `now - last_at <= claudeActivity.activeWindowMinutes` (default 10). The user is active when any session is. Transitions publish `claude_session.activity_changed {active, lastActiveAt}` and are audited `claude_activity.active` / `claude_activity.idle`; turning observation off sets idle. The last state is kept in `claudeActivity.lastActiveState` so a restart does not re-announce it.
- **Job (A7).** `claude_activity.scan` every `claudeActivity.scanIntervalSeconds` (default 120), a plain job, concurrency group `claude_activity` (1), 20 s soft budget, a no-op when `claudeActivity.enabled` is false.
- **Health (A8).** Component `claude_activity`: `ok`; `disabled`; `degraded` with "Claude Code session format not recognised; observation paused" when a scan read candidate lines and none parsed into a known field; `degraded` when the projects dir is unreadable for a reason other than not existing. A missing dir is `ok` with zero sessions. The rest of Synapse is unaffected.

### Known gap: sessions started from a symlinked cwd

Claude Code names a project folder after the path the session was started from. A session started from a symlink to a registered repository lives in a folder named after the symlink path, which is not the encoding of the repository's realpath, so the scanner never lists it (the `cwd` realpath match in A4 only helps when the folder is already a candidate). Such sessions are not seen, so they neither mark the user active nor appear in the card. Recorded in `docs/superpowers/plans/2026-11-06-phase-10b-followups.md`.

## Yield

The module implements `UserActivitySignal`; the orchestrator defers background work while it reports active. Scope and the failure `user_active` are in `docs/modules/claude-orchestrator.md` and the ADR-036 amendment: `batch` and `backfill` yield when `claudeActivity.yieldWhenActive` is on, `engineering` only when `claudeActivity.yieldEngineering` is on (default off), `urgent`, `send` and `collection` never.

## Tables (migration 0020)

`claude_sessions` and `claude_session_prs` (columns in `docs/architecture/database-design.md`). Sessions cascade away when their repository is unregistered. A PR is linked to an engineering task when the task's `pr_url` equals the PR url, and to every Engineering Brain project that links the repository; links are computed on read, not stored.

## Reminders (A10)

Daily job `claude_activity.reminders`, polled every 15 minutes by the scheduler (whose cron runs in UTC), due from 09:30 local time and once at startup if missed; the local date of the last run is kept in `claudeActivity.reminders.lastRunDate`. Local notifications to the user only (`NotificationService`, kind `claude_activity.reminder`); nothing goes to Slack, Jira or anyone else.

- **Stale branch.** A (repository, branch) whose first session is at least `claudeActivity.staleBranchDays` (3) old, with activity in the last 14 days and no session PR on that branch. The tracked branch, registry environment branches, `main`, `master` and `HEAD` are excluded. Dedupe key `wip:<repoId>:<branch>`.
- **Open PR.** A session PR first seen at least `claudeActivity.openPrReminderDays` (3) days ago, not yet reminded, whose state read through `PullRequestProvider.view` (read-only `gh pr view --json state`) is `OPEN`. A merged, closed or deduped PR is settled; a provider failure or unsupported host skips it silently. At most 10 PR checks per run. Dedupe key `pr:<url>`, `reminded_at` set when settled.
- At most one reminder per key per 7 days.

## API and settings

`GET /api/claude/activity` returns `{ enabled, active, lastActiveAt, yielding, health, repositories: [{ repositoryId, name, sessions (latest 10, last 14 days), prs (latest 10, with engineeringTaskId when linked) }] }`. The Overview DTO carries `claudeActivity: { active, sessionsToday, yielding }`. `GET` and `PUT /api/settings` expose only the Phase 10b keys (`claudeActivity.enabled`, `activeWindowMinutes`, `yieldWhenActive`, `yieldEngineering`, `staleBranchDays`, `openPrReminderDays`, and the `codeAnswer.*` keys); an invalid value is `400 invalid_setting`.

## Events

Emitted: `claude_session.activity_changed {active, lastActiveAt}`. `claude_session.pr_detected` is listed in the event catalog but **not emitted** (no consumer needs it yet; PRs are read from the table).

## Settings

| Key | Default |
|---|---|
| `claudeActivity.enabled` | `true` |
| `claudeActivity.projectsDir` | `~/.claude/projects` (resolved at startup; tests set it) |
| `claudeActivity.scanIntervalSeconds` | `120` |
| `claudeActivity.activeWindowMinutes` | `10` |
| `claudeActivity.yieldWhenActive` | `true` |
| `claudeActivity.yieldEngineering` | `false` |
| `claudeActivity.staleBranchDays` | `3` |
| `claudeActivity.openPrReminderDays` | `3` |

## Tests

`apps/api/test/modules/claude-activity-*.test.ts` and the orchestrator yield tests, with synthetic session files in a temporary projects dir (never the real `~/.claude/projects`): unregistered folder never opened, unknown line types, sentinel content in prompt and assistant lines, a partial last line, a shrunk file, a symlink, a future timestamp, the yield deferral and resume, degraded health on an unknown format.
