# Phase 10: Follow-ups

Phase 10 delivered engineering automation (`docs/modules/engineering-tasks.md`, spec `docs/superpowers/specs/2026-11-06-phase-10-engineering-automation.md`). This file records what was deliberately deferred, the known gaps, and the real-CLI smoke result.

## Real-CLI smoke: Run by the controller on 2026-11-06 with the real CLI (haiku), on a throwaway repo with local bare remotes. No gh, no push.

- Results: `investigate: ok`, `develop: files=1 testsPassed=true unsafe=false`, `commit: ok`, `merge_local: ok`, `cancelled_before_push: true`, `lock_released: true`.
- The investigate run produced a plan.
- The develop run fixed the planted bug in one file. The test result came from the real `bun test` tool_result.
- The git-dir fingerprint didn't false-flag the run, which confirms skipping the index.
- The commit and the local merge each went through their approval executors.
- Cancelling before the push released the lock.

`bun scripts/dev/develop-smoke.ts` has not been run against the real CLI yet. The controller runs it deliberately (two haiku runs; no gh, no push) and records here:

- the date and CLI version;
- the printed lines: `investigate: …`, `develop: files=… testsPassed=… unsafe=…`, `commit: …`, `merge_local: …`, `cancelled_before_push: …`, `lock_released: …`;
- whether the git-dir fingerprint stayed stable across the real develop run. Concern carried from Task 5: if Claude Code itself refreshes `.git/index` or writes into `.git` during the run, every run would be flagged `git_dir_changed`. The fingerprint hashes the index, so this is the thing to watch;
- any permission denials the develop run reported (tool names only).

Until then the develop path is proven only by the fake-claude end-to-end test (`apps/api/test/integration/engineering-e2e.test.ts`) and by the provider-level pre-checks of 2026-11-06 (scoped edits and the Bash prefix, chaining refused).

## Fixed in the final review (2026-11-06)

Network-independent recovery and retryable pickup (I1), cleanup return-branch fallbacks (I2), the description form mounting with its detail and the Jira/Slack note (I3), test-run honesty (M1), the stricter test command (M2), lost cleanups re-enqueued (M3), the unregister guard (M4), the PR recorded at once and `merged_after_cancel` (M5), fresh PR checks at merge (M6), the cancel confirmations (M7), `failed` restored after a retried cleanup (M8), executor refusals routed to `needs_attention` (M9), the origin URL check before push (M10) and web labels for every reason code (M11). Report: `.superpowers/sdd/2026-11-06-phase-10-engineering-automation/final-fix-report.md`.

## Deferred

- **`code_answer` for away mode, and ADR-036 interactive session observation (Phase 10b).** Answering a Slack question from the code mixes untrusted Slack text with code read access and needs its own security design (no write or send tool in the same run, provenance of every part, an output through `AutoReplyPolicy`). Session observation (metadata only from `~/.claude/projects` for registered repositories) is separate work.
- **Evaluate the Claude Code Bash sandbox for develop runs.** The test command runs repository code that the develop run may have edited, so it runs arbitrary code as the user, with network access and writes outside the repository (`docs/architecture/security-model.md` §3.1). Path-scoped writes and the Bash prefix do not contain that. A sandbox (bubblewrap-style, as the CLI offers) restricting the test command's filesystem writes and network is the real mitigation. Needs an ADR, because it adds a dependency on a CLI feature and may break test suites that need the network.
- **Non-GitHub hosts.** `GitHubCliProvider` supports github.com only; any other host is `unsupported_remote` before anything is pushed. GitLab and Bitbucket need their own `PullRequestProvider`.
- **Overriding protected branches.** A protected environment's branch is refused with no override. If an override is ever wanted it must be an explicit, per-task, audited user action shown on the plan approval.
- **Multi-repo tasks.** One task, one repository. A change that spans two repositories needs two tasks today.
- **A repository picker for create-from-Jira and create-from-Slack when the repository is ambiguous.** The API answers `ambiguous_repository`; the web shows a plain sentence and has no picker. The routes already accept an optional `repositoryId`.
- **`include.path` targets are not fingerprinted.** `configFingerprint` and `gitDirFingerprint` hash the config files but do not follow `include.path` or `includeIf` targets inside them. The model's file tools cannot write outside the repository, but the test command runs repository code that can (security-model §3.1), and a config in the repository's git dir could include a file elsewhere that changes later.
- **A history view showing cleanup outcomes.** The web fetches step details only for non-terminal tasks, so history rows show status, PR link and failure reason but not `branch_kept`, `pushed_not_pr`, `priorStatus` or a `dirty_tree` cleanup.
- **Re-requesting `merge_pr` after failing checks.** Since the final review, failing checks refuse the merge (`checks_failing`): the approval is revoked and the task goes to `needs_attention`. There is no "try the merge again" action: the user fixes the checks and merges the PR on GitHub (or cancels the task, which leaves the PR as it is). A re-request route for a `needs_attention` task at `merge_pr` would close this.
- **Approval state after an executor refusal.** When revalidation passed but the executor then finds the repository gone (`path_unavailable`, final review M9), the task goes to `needs_attention`, but the approval was already claimed by the engine, so it ends `failed`, not `revoked`. Both are terminal; only the label differs.
- **Editing the commit message, PR title and PR body before approval.** The spec (E10, E13) says the user may edit them. No route updates an approval payload, so the executors use what was proposed. An approval-edit endpoint only has to update the payload before the approval is decided.
- **Smaller items.**
  - Engineering approvals have no expiry; the lock is held while one waits (renew keeps an `awaiting_approval` holder alive).
  - The in-flight guard that stops cleanup during a running step is per process (fine with one API process).
  - ssh passphrase or host-key prompts and `commit.gpgsign` prompts are bounded only by the git timeout (`credential.interactive=never` and `GIT_TERMINAL_PROMPT=0` do not stop `/dev/tty` prompts).
  - The plan screen's parent branch is a text input with a datalist, not a select, because `RepositoryView` carries no branch list.
  - Investigation has no `suspectedInjection` field (same exception as the Phase 9 inspection, see the module doc).
  - The investigation timeout (20 minutes) is fixed; there is no setting.

- The spec says the commit message and PR title/body can be edited before approval. No route supports editing yet: the user sees exactly what will be used and can reject it.
