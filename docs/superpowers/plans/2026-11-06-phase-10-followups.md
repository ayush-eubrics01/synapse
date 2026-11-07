# Phase 10: Follow-ups

Phase 10 delivered engineering automation (`docs/modules/engineering-tasks.md`, spec `docs/superpowers/specs/2026-11-06-phase-10-engineering-automation.md`). This file records what was deliberately deferred, the known gaps, and the real-CLI smoke result.

## Real-CLI smoke: Run by the controller on 2026-11-06 with the real CLI (haiku), on a throwaway repo with local bare remotes. No gh, no push.

- Results: `investigate: ok`, `develop: files=1 testsPassed=true unsafe=false`, `commit: ok`, `merge_local: ok`, `cancelled_before_push: true`, `lock_released: true`.
- The investigate run produced a plan.
- The develop run fixed the planted bug in one file. The test result came from the real `bun test` tool_result.
- The git-dir fingerprint didn't false-flag the run, which confirms skipping the index.
- The commit and the local merge each went through their approval executors.
- Cancelling before the push released the lock.

`bun scripts/dev/develop-smoke.ts` (superseded by the sandboxed runs below, kept for what it was meant to record):

- the date and CLI version;
- the printed lines: `investigate: …`, `develop: files=… testsPassed=… unsafe=…`, `commit: …`, `merge_local: …`, `cancelled_before_push: …`, `lock_released: …`;
- whether the git-dir fingerprint stayed stable across the real develop run. Concern carried from Task 5: if Claude Code itself refreshes `.git/index` or writes into `.git` during the run, every run would be flagged `git_dir_changed`. The fingerprint hashes the index, so this is the thing to watch;
- any permission denials the develop run reported (tool names only).

Before the sandbox the develop path was proven only by the fake-claude end-to-end test (`apps/api/test/integration/engineering-e2e.test.ts`) and by the provider-level pre-checks of 2026-11-06 (scoped edits and the Bash prefix, chaining refused).

## Follow-ups batch 1 (2026-11-07): sandboxed develop runs, approval edits

Spec `docs/superpowers/specs/2026-11-07-followups-batch-1.md`, ADR-040. Done in this batch:

- [x] **A sandbox for the develop run** (ADR-040): no network, writes only in the repository and a private `TMPDIR`, credential and socket directories masked, `sandbox_unavailable`, `sandbox_disabled`, `sandbox_path_too_long` and `repo_in_masked_path` reasons, `sandbox` and `claude_settings` health checks, `engineering.sandbox.enabled`.
- [x] **A repository picker** for create-from-Jira and create-from-Slack on `ambiguous_repository`.
- [x] **Re-requesting `merge_pr`** after `checks_failing` (`POST …/retry-merge`, "Check again").
- [x] **Editing the commit message, PR title and PR body** before approval (`PUT …/approvals/:approvalId`).

### Real-CLI develop smoke with the sandbox (controller, 2026-11-07, Claude Code 2.1.319, bubblewrap 0.11.1, haiku, Ubuntu with `kernel.apparmor_restrict_unprivileged_userns=1`)

Three runs of `bun scripts/dev/develop-smoke.ts` (two haiku runs each; no gh, no push). The first two found real bugs; the fixes are in ADR-040, "Observed CLI behaviour".

1. **Fail: placeholders and a tmpDir inside a mask.** `develop: unsafe_change [git_dir_changed]`, `testsPassed=false`. Two causes, both verified by probes:
   - The run scratch lived under the Synapse data directory, itself a `denyRead` entry. bwrap could not create Claude Code's file under `TMPDIR` ("Can't create file … Read-only file system"), so every Bash call exited 1. Fix: the run root moved to the user cache directory and rule M refuses a `tmpDir` inside a mask.
   - The sandbox leaves empty mount placeholders: in `.git` `branches/`, `remotes/`, `config.worktree` (0 bytes), `objects/info/alternates` (0 bytes), `objects/info/commit-graphs/` and `.claude-sandbox-noreplace/` markers in `info/`, `objects/info/` and `objects/info/commit-graphs/`; at the top `.claude/.cc-writes/`. The git-dir fingerprint flagged them. Fix: the develop step removes exactly those when new and empty, before the fingerprint check.
2. **Fail: socket path too long.** The sandbox failed inside the run with "Failed to create bridge sockets after 5 attempts" (tmpDir about 89 bytes: `~/.cache/synapse/<16 hex>/runs/<uuid>/tmp`; a 72-byte run had passed). The message arrived in the Bash tool_result, not at startup, so it was counted as failing tests. Fix: short paths `<cache>/synapse/<8hex>/r/<8hex>/t`, a 64-byte cap (`sandbox_path_too_long`), and detection of "Sandbox is required but failed to initialize" in Bash tool_results (`sandbox_unavailable`).
3. **Pass** (tmpDir 48 bytes): `investigate: ok`, `develop: files=1 testsPassed=true unsafe=false`, `sandbox: outside_write=blocked secret=blocked network=blocked`, `commit: ok`, `merge_local: ok`, `cancelled_before_push: true`, `lock_released: true`. The git-dir fingerprint stayed stable once the empty placeholders were removed, which answers the "does Claude Code write into `.git`" concern above: it does, with empty placeholders only. The run root under `~/.cache/synapse/<8hex>` was deleted afterwards.

### New follow-ups from batch 1

- **Network-enabled sandboxes.** A repository whose tests need the network (package installs, services) cannot use develop runs; the sandbox allows no domain. A per-repository allowlist would need its own decision.
- ~~**A retry action for the develop step after `sandbox_unavailable`.**~~ **Done in follow-ups batch 2.** Retry develop covers `sandbox_unavailable` and the three other reasons. Original note: Today the user installs bubblewrap and socat, then cancels and proposes the task again.
- **Repositories registered under `/tmp` (or `/run`, `/var/run`) are unverified** with the `/tmp` mask and are refused (`repo_in_masked_path`); so are repositories inside `~/.config`, other home mask entries, the data directory and the backup directory.
- **The seccomp layer is skipped** on hosts with `apparmor_restrict_unprivileged_userns=1` (`allowAllUnixSockets: true`); the masks carry socket isolation. Revisit when the CLI's seccomp layer works there.
- **Files outside the mask list stay readable to tests** (other `~/.local/share` applications, browser profiles). They can leave only through the diff or test output the user reviews.
- ~~**A relative `SYNAPSE_DB_PATH`**~~ **Done in follow-ups batch 2.** Resolved at config load. Original note: makes the data directory mask a relative path, so rule M refuses the develop run with a confusing "sandbox paths must be absolute" error. Resolve it at config load, or give a specific error.
- ~~**`XDG_CACHE_HOME` inside a mask**~~ **Done in follow-ups batch 2.** The develop step refuses with `sandbox_root_masked` and a hint. Original note: (for example under `~/.config`) makes rule M refuse every develop run with a generic error. A specific reason and hint would help.
- ~~**Old instance directories under `~/.cache/synapse/<8hex>` are never pruned**~~ **Done in follow-ups batch 2.** Pruned at API start: 8-hex real directories, not this instance, nothing modified in 7 days. Original note: (a changed data directory, an old smoke); only an instance's own `r/` is swept at start.
- **TOCTOU in the placeholder cleanup.** The cleanup lstats every component and refuses symlinks, but a path can still change between the check and the removal; the window is small and the run has ended, and nothing non-empty is removed. Harden with fd-relative operations if it matters.
- ~~**An unused Hono import warning**~~ **Done in follow-ups batch 2.** Already removed in the batch-1 final fix. Original note: shows in the check output; remove the import.

### New follow-ups from batch 2

- **`priorStatus` on history rows fades** when retention prunes the `engineering.cancelled` audit row (`retention.auditDays`).

## Fixed in the final review (2026-11-06)

Network-independent recovery and retryable pickup (I1), cleanup return-branch fallbacks (I2), the description form mounting with its detail and the Jira/Slack note (I3), test-run honesty (M1), the stricter test command (M2), lost cleanups re-enqueued (M3), the unregister guard (M4), the PR recorded at once and `merged_after_cancel` (M5), fresh PR checks at merge (M6), the cancel confirmations (M7), `failed` restored after a retried cleanup (M8), executor refusals routed to `needs_attention` (M9), the origin URL check before push (M10) and web labels for every reason code (M11). Report: `.superpowers/sdd/2026-11-06-phase-10-engineering-automation/final-fix-report.md`.

## Deferred

- **`code_answer` for away mode, and ADR-036 interactive session observation (Phase 10b).** Answering a Slack question from the code mixes untrusted Slack text with code read access and needs its own security design (no write or send tool in the same run, provenance of every part, an output through `AutoReplyPolicy`). Session observation (metadata only from `~/.claude/projects` for registered repositories) is separate work.
- ~~**Evaluate the Claude Code Bash sandbox for develop runs.**~~ **Done in follow-ups batch 1 (ADR-040).** Original note: The test command runs repository code that the develop run may have edited, so it runs arbitrary code as the user, with network access and writes outside the repository (`docs/architecture/security-model.md` §3.1). Path-scoped writes and the Bash prefix do not contain that. A sandbox (bubblewrap-style, as the CLI offers) restricting the test command's filesystem writes and network is the real mitigation. Needs an ADR, because it adds a dependency on a CLI feature and may break test suites that need the network.
- **Non-GitHub hosts.** `GitHubCliProvider` supports github.com only; any other host is `unsupported_remote` before anything is pushed. GitLab and Bitbucket need their own `PullRequestProvider`.
- **Overriding protected branches.** A protected environment's branch is refused with no override. If an override is ever wanted it must be an explicit, per-task, audited user action shown on the plan approval.
- **Multi-repo tasks.** One task, one repository. A change that spans two repositories needs two tasks today.
- ~~**A repository picker for create-from-Jira and create-from-Slack when the repository is ambiguous.**~~ **Done in follow-ups batch 1.** Original note: The API answers `ambiguous_repository`; the web shows a plain sentence and has no picker. The routes already accept an optional `repositoryId`.
- ~~**`include.path` targets are not fingerprinted.**~~ **Done in follow-ups batch 3.** `configFingerprint` follows `include.path` and `includeIf.*.path` (depth 10, visited set, missing hashes as `missing`). Original note: `configFingerprint` and `gitDirFingerprint` hash the config files but do not follow `include.path` or `includeIf` targets inside them. The model's file tools cannot write outside the repository, but the test command runs repository code that can (security-model §3.1), and a config in the repository's git dir could include a file elsewhere that changes later.
- ~~**A history view showing cleanup outcomes.**~~ **Done in follow-ups batch 2.** The history view shows them. Original note: The web fetches step details only for non-terminal tasks, so history rows show status, PR link and failure reason but not `branch_kept`, `pushed_not_pr`, `priorStatus` or a `dirty_tree` cleanup.
- ~~**Re-requesting `merge_pr` after failing checks.**~~ **Done in follow-ups batch 1** (`POST …/retry-merge`). Original note: Since the final review, failing checks refuse the merge (`checks_failing`): the approval is revoked and the task goes to `needs_attention`. There is no "try the merge again" action: the user fixes the checks and merges the PR on GitHub (or cancels the task, which leaves the PR as it is). A re-request route for a `needs_attention` task at `merge_pr` would close this.
- **Approval state after an executor refusal.** When revalidation passed but the executor then finds the repository gone (`path_unavailable`, final review M9), the task goes to `needs_attention`, but the approval was already claimed by the engine, so it ends `failed`, not `revoked`. Both are terminal; only the label differs.
- ~~**Editing the commit message, PR title and PR body before approval.**~~ **Done in follow-ups batch 1** (`PUT …/approvals/:approvalId`). Original note: The spec (E10, E13) says the user may edit them. No route updates an approval payload, so the executors use what was proposed. An approval-edit endpoint only has to update the payload before the approval is decided.
- **Smaller items.**
  - Engineering approvals have no expiry; the lock is held while one waits (renew keeps an `awaiting_approval` holder alive).
  - The in-flight guard that stops cleanup during a running step is per process (fine with one API process).
  - ssh passphrase or host-key prompts and `commit.gpgsign` prompts are bounded only by the git timeout (`credential.interactive=never` and `GIT_TERMINAL_PROMPT=0` do not stop `/dev/tty` prompts).
  - The plan screen's parent branch is a text input with a datalist, not a select, because `RepositoryView` carries no branch list.
  - Investigation has no `suspectedInjection` field (same exception as the Phase 9 inspection, see the module doc).
  - The investigation timeout (20 minutes) is fixed; there is no setting.

- ~~The spec says the commit message and PR title/body can be edited before approval. No route supports editing yet.~~ Done in follow-ups batch 1.

## Follow-ups batch 1: final review notes

- Placeholders left by a killed run count as pre-existing: if the API dies mid-run, the sandbox's empty placeholder files and directories stay in the repository's `.git`, are counted as "before" on the next run, and are never removed. They are harmless to git and keep the fingerprint consistent.
