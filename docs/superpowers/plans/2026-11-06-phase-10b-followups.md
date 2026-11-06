# Phase 10b follow-ups

Items parked during Phase 10b (claude activity and code answers). None blocks the phase.

## Claude activity

- **Sessions started from a symlinked cwd are not seen.** Claude Code names the project folder after the path the session started from; a symlink to a registered repository gives a folder that is not the encoding of the repository realpath, so the scanner never lists it. Fix idea: also derive candidate folder names from the realpath-resolved symlinks of the registered paths, or accept a configured alias list.
- **`claude_session.pr_detected` is not emitted.** The catalog entry stays for a later consumer (Jira or Brain linking).
- **Reminders scheduler uses a 15-minute poll** (the cron runs in UTC) with local-date tracking in settings. A proper local-time cron would remove the poll.

## Code answers

- **Handler timeout is read at registration.** `codeAnswer.timeoutMinutes` changes the request timeout at once, but the job handler timeout (`timeoutMinutes + 5`) is fixed at startup: a restart is needed after raising it above the old value.
- **Partial unique index and NULL repository.** `code_answers_live_uq` is over (`message_id`, `repository_id`, `trigger`); SQLite treats NULL as distinct, so rows whose repository was unregistered (`repository_id` NULL) are not deduplicated. They only exist as `failed` / `repository_unavailable` rows in practice; revisit if another live status can carry a NULL repository.
- **Two benign minors from the Task 8 re-review** are recorded in the SDD ledger (`.superpowers/sdd/2026-11-06-phase-10b-activity-code-answer/progress.md`).
- **`autoSend` toggle is not re-checked when the send is claimed**, like the other kinds' settings. A re-check in `beforeSpawn` would make the toggle an immediate kill switch.
- **Repository-name matching treats `-` and `_` as name characters**, so a message that writes `demo-app` for a repository named `demo` does not match. A configurable alias list per repository would help.
- **Away trigger needs a literal repository or project name.** No fuzzy matching, no multi-repository questions (out of scope for 10b).
- **A `Read` allow entry in the user's settings refuses every reader run** (and engineering run). A UI hint that explains the refusal is not built.
