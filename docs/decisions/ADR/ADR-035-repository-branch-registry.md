# ADR-035: Repository Branch Registry and Branch Confirmation

- **Status:** Accepted
- **Date:** 2026-11-05
- **Source:** User decision 2026-11-05 (resolving the PR-branch question together with ADR-030)

## Context

The Git workflow (ADR-030) depends on knowing the right parent branch for each task. Repositories differ: some have one main line, others have several deployment branches. For example, `flexi-demo` deploys `stage` and `prod` from separate branches. The user wants Synapse to keep a simple note of the tracked branch per repository and the branch behind each deployment, and to **ask** which branch to use before starting work.

Observed in `flexi-demo` (2026-11-05): checked out on `stage`; `origin` = the user's fork (`ayush-eubrics01/flexi-demo`); `upstream` = `Eubrics/flexi-demo` with pushes disabled; `origin/stage` and `origin/prod` exist.

## Decision

### Registry

The registry lives **only in the SQLite database** (`repositories`, `repository_environments`). It is entered through the registration flow in the UI and changed through the UI or the branch confirmation step. There is no config file or seed file for it. Examples in these docs (such as `flexi-demo`) are illustrative only and are never loaded by the application.

Each registered repository has:

| Field | Meaning |
|---|---|
| `name`, `local_path` | Registered path (the only paths Synapse may touch) |
| `origin_url`, `upstream_url` | Fetch URLs. `upstream_push_disabled` is recorded if the push URL is disabled |
| `tracked_branch` | The branch Synapse treats as the default parent branch for work in this repo |
| `notes` | Free-text note from the user (e.g. "stage deploys automatically on merge") |

Plus zero or more **deployment environments**:

| Field | Example (`flexi-demo`) |
|---|---|
| `name` | `stage`, `prod` |
| `branch` | `stage`, `prod` (confirmed by the user 2026-11-05) |
| `notes` | how/when it deploys, if known |

On registration, Synapse proposes values detected from Git (current branch, remotes, branches whose names look like environments) and **the user confirms or edits them**. Synapse never silently changes the registry. A periodic check reports drift (for example, the checkout is now on a different branch than `tracked_branch`, or an environment's branch no longer exists) as a notification, not as an automatic update.

### Branch confirmation step

Every engineering task gets a **branch confirmation** step before any branch is created, shown together with the plan approval:

```text
Repository:   flexi-demo
Environment:  stage            (suggested from the task source, or "none")
Parent branch: stage           (from the environment, else tracked_branch)
Task branch:  synapse/<task-id>-<slug>
PR:           origin/stage  ─▶  upstream/stage
[Confirm]  [Change branch / environment]  [ ] Remember as tracked branch
```

- Synapse suggests the environment and parent branch. A bug reported against production suggests `prod`. Otherwise it uses `tracked_branch`.
- The user confirms or changes it. Choosing "remember" updates `tracked_branch` (audited).
- The confirmed parent branch drives the whole workflow: `git pull origin <parent> && git pull upstream <parent>`, local merge, push to `origin/<parent>`, PR into `upstream/<parent>` (ADR-030).
- If the confirmed branch doesn't exist on `origin` or `upstream`, preflight fails → `NEEDS_ATTENTION`.
- Synapse never pushes to `upstream`.

## Consequences

- **Positive:** the user always sees and confirms where work lands. Multi-environment repos like `flexi-demo` are handled explicitly.
- **Positive:** the Engineering Brain can link milestones and go-live dates to environments.
- **Negative:** one extra confirmation per task. It's merged into the existing plan approval, so it isn't a separate wait.
- Environment detection from branch names is only a suggestion. The user's confirmation is the source of truth.

## Implementation note (Phase 9)

- The registry was built as decided: database only, entered through the UI as a proposal that the user confirms. Module doc: [engineering-brain.md](../../modules/engineering-brain.md).
- **`protected` and `auto_deploys_on_merge`** are per-environment booleans on `repository_environments`, set by the user at registration or edit. In Phase 9 they are **recorded and displayed only** (chips such as `stage` with "auto-deploys" and `prod` with "protected"); nothing enforces them yet. Phase 10 must enforce them: `protected` means Synapse never writes to that branch (no push, merge or PR target without an explicit user override), and `auto_deploys_on_merge` means a merge into that branch ships, so the branch confirmation and merge steps must say so. Environments are detected only as suggestions (branch names); the user's confirmation is the source of truth.
- A registered path must be the top level of a git work tree, match `^/[A-Za-z0-9._/-]+$`, and may not be `/`, `$HOME` or an ancestor of it, or inside `~/.claude`, `~/.ssh` or `~/.config`. Nested registrations are refused. The same safe-path predicate backs path-scoped reads (validator rule L).
- The drift check only reports. The one automatic-looking change, "accept remotes", is an explicit user action.

## Related

- [ADR-030](ADR-030-single-engineering-task-and-git-workflow.md), [ADR-013](ADR-013-manual-approval-for-external-writes.md), [ADR-016](ADR-016-central-engineering-brain.md)
- [engineering-brain.md](../../modules/engineering-brain.md), [claude-orchestrator.md](../../modules/claude-orchestrator.md), [database-design.md](../../architecture/database-design.md)
