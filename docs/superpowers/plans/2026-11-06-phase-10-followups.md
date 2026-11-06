# Phase 10: Follow-ups

Phase 10 delivered engineering automation (`docs/modules/engineering-tasks.md`, spec `docs/superpowers/specs/2026-11-06-phase-10-engineering-automation.md`). This file records what was deliberately deferred, the known gaps, and the real-CLI smoke result.

## Real-CLI smoke: TBD

`bun scripts/dev/develop-smoke.ts` has not been run against the real CLI yet. The controller runs it deliberately (two haiku runs; no gh, no push) and records here:

- the date and CLI version;
- the printed lines: `investigate: …`, `develop: files=… testsPassed=… unsafe=…`, `commit: …`, `merge_local: …`, `cancelled_before_push: …`, `lock_released: …`;
- whether the git-dir fingerprint stayed stable across the real develop run. Concern carried from Task 5: if Claude Code itself refreshes `.git/index` or writes into `.git` during the run, every run would be flagged `git_dir_changed`. The fingerprint hashes the index, so this is the thing to watch;
- any permission denials the develop run reported (tool names only).

Until then the develop path is proven only by the fake-claude end-to-end test (`apps/api/test/integration/engineering-e2e.test.ts`) and by the provider-level pre-checks of 2026-11-06 (scoped edits and the Bash prefix, chaining refused).

## Deferred

- **`code_answer` for away mode, and ADR-036 interactive session observation (Phase 10b).** Answering a Slack question from the code mixes untrusted Slack text with code read access and needs its own security design (no write or send tool in the same run, provenance of every part, an output through `AutoReplyPolicy`). Session observation (metadata only from `~/.claude/projects` for registered repositories) is separate work.
- **Evaluate the Claude Code Bash sandbox for develop runs.** The test command runs repository code that the develop run may have edited, so it runs arbitrary code as the user, with network access and writes outside the repository (`docs/architecture/security-model.md` §3.1). Path-scoped writes and the Bash prefix do not contain that. A sandbox (bubblewrap-style, as the CLI offers) restricting the test command's filesystem writes and network is the real mitigation. Needs an ADR, because it adds a dependency on a CLI feature and may break test suites that need the network.
- **Non-GitHub hosts.** `GitHubCliProvider` supports github.com only; any other host is `unsupported_remote` before anything is pushed. GitLab and Bitbucket need their own `PullRequestProvider`.
- **Overriding protected branches.** A protected environment's branch is refused with no override. If an override is ever wanted it must be an explicit, per-task, audited user action shown on the plan approval.
- **Multi-repo tasks.** One task, one repository. A change that spans two repositories needs two tasks today.
- **A repository picker for create-from-Jira and create-from-Slack when the repository is ambiguous.** The API answers `ambiguous_repository`; the web shows a plain sentence and has no picker. The routes already accept an optional `repositoryId`.
- **`include.path` targets are not fingerprinted.** `configFingerprint` and `gitDirFingerprint` hash the config files but do not follow `include.path` or `includeIf` targets inside them. A develop run cannot write outside the repository, but a config in the repository's git dir could include a file elsewhere that changes later.
- **A history view showing cleanup outcomes.** The web fetches step details only for non-terminal tasks, so history rows show status, PR link and failure reason but not `branch_kept`, `pushed_not_pr`, `priorStatus` or a `dirty_tree` cleanup.
- **Web labels for the new reason codes.** `lock_lost`, `lock_held_by_other`, `step_running` and `not_terminal` are step-result reasons (and cleanup output reasons) with no entry in `apps/web/lib/engineering.ts` `reasonLabel`, so they fall back to "Something unexpected stopped the task." (`lock_lost` can be a revalidation failure that reaches the task `failure`.) Add them to `ENGINEERING_REASON_CODES` and the labels; the exhaustive label test then keeps them in step.
- **Editing the commit message, PR title and PR body before approval.** The spec (E10, E13) says the user may edit them. No route updates an approval payload, so the executors use what was proposed. An approval-edit endpoint only has to update the payload before the approval is decided.
- **Smaller items.**
  - Engineering approvals have no expiry; the lock is held while one waits (renew keeps an `awaiting_approval` holder alive).
  - The in-flight guard that stops cleanup during a running step is per process (fine with one API process).
  - ssh passphrase or host-key prompts and `commit.gpgsign` prompts are bounded only by the git timeout (`credential.interactive=never` and `GIT_TERMINAL_PROMPT=0` do not stop `/dev/tty` prompts).
  - The plan screen's parent branch is a text input with a datalist, not a select, because `RepositoryView` carries no branch list.
  - Investigation has no `suspectedInjection` field (same exception as the Phase 9 inspection, see the module doc).
  - The investigation timeout (20 minutes) is fixed; there is no setting.
