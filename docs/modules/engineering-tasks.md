# Module: Engineering Tasks (Phase 10, as built)

Code: `apps/api/src/modules/engineering-tasks/` (`store.ts`, `service.ts`, `lock.ts`, `steps.ts`), `apps/api/src/workers/engineering/` (`investigate.ts`, `pickup.ts`, `steps.ts`), `apps/api/src/intelligence/engineering/` (`investigate-prompt.ts`, `develop-prompt.ts`), `apps/api/src/integrations/repository/git-workflow.ts` (the `GitWorkflow` adapter), `apps/api/src/integrations/github/gh-cli.ts` (the `PullRequestProvider` adapter), `apps/api/src/routes/engineering.ts`. Contracts: `packages/contracts/src/engineering.ts`, `repository.ts` (`GitWorkflow`), `pull-requests.ts`. Migrations 0017 and 0018 (`last_pickup_error`) and 0019 (`pickup_failures`). Authority: ADR-030, ADR-035, ADR-032, ADR-013, ADR-026. Spec: `docs/superpowers/specs/2026-11-06-phase-10-engineering-automation.md`. Follow-ups: `docs/superpowers/plans/2026-11-06-phase-10-followups.md`.

## Principle

The model edits files and runs the confirmed test command. **Nothing else.** Every Git operation (branch creation, commit, parent update, local merge, push, PR creation, PR merge, cleanup) is Synapse code: argv, no shell, through the hardened `GitWorkflow` runner or the `gh` adapter. Each write step waits for the user's approval of exactly what will happen, and the approval is revalidated before it runs. The model never sees Slack or Jira text (E2), is never *given* `git` (no git tool or Bash grant), and never receives a credential. **It can still run repository code through the test command:** the test suite is code the develop run may have just edited. Since ADR-040 that command runs inside the Claude Code sandbox (no network, writes only in the repository and a private tmp directory), with residual risks listed in `docs/architecture/security-model.md` §3.1. Path-scoped edits and the Bash prefix limit what the model is granted; the sandbox limits what the tests do.

## Task lifecycle and states

`engineering_tasks.status` (state machine in `store.ts`, `ALLOWED_TRANSITIONS`):

| Status | Meaning |
|---|---|
| `proposed` | Created (manual, from a Jira issue or from a Slack message). Not started. A failed investigation also returns here, with the code in `failure`, so the user can edit and re-approve |
| `investigating` | The description was approved and the read-only run is queued or running |
| `planned` | The plan is stored. A non-empty `plan.unclear` keeps the task here with the questions; re-approving a description re-investigates |
| `approved` | In the enum and the state machine, but unused: plan approval goes straight to `queued` |
| `queued` | Plan and branch confirmed. Waits for the lock (priority, then oldest). `lastPickupError` holds the code of a pickup that could not reach a remote (`fetch_failed`, `git_timeout`); the next tick retries |
| `in_progress` | Holds the lock; a step (branch, develop, update_parent, an approval executor) is running |
| `awaiting_approval` | Holds the lock; one of the four step approvals is pending |
| `completed`, `failed`, `cancelled` | Terminal. Cleanup follows and then releases the lock |
| `needs_attention` | A fixed reason code is in `failure`. The lock is kept. The user resolves it and cancels (which re-runs cleanup) |

A terminal task moves on only to `needs_attention`, and only when its cleanup cannot finish (a dirty tree, or a cleanup that died: `cleanup_incomplete`). The prior terminal status is recorded on the cleanup step as `priorStatus` (and its failure reason as `priorFailure`). Such a task can never go back to `queued`, `in_progress` or `awaiting_approval`; a `completed` or `failed` one returns to that status (a `failed` one with its reason) when a retried cleanup succeeds (final review M8). The one other move out of a terminal status is `cancelled → completed`: the PR merged while the cancel was being recorded (`merged_after_cancel`, M5).

Steps (`engineering_task_steps`, one row per task and step): `investigate`, `branch`, `develop`, `commit`, `update_parent`, `merge_local`, `push_pr`, `merge_pr`, `cleanup`. Step status: `pending`, `awaiting_approval`, `running`, `done`, `failed`, `skipped`. Step `output` is JSON (see below) and only `GET /api/engineering/tasks/:id` serves it.

## E2: description provenance (ADR-032)

The draft is prefilled from a Jira summary (summary only, never the description), a Slack message text, or typed by the user. It lives in `draft_description`, is shown with an "untrusted source" note and is rendered as plain text. The user edits it and approves it as `approved_description`. **Only `approved_description` and the approved plan ever reach a run that can act**, as `user_approved` parts, plus system parts. The title (which can come from a Jira summary) and the draft never do; tests assert this for both runs. Proposals from Jira or Slack never start on their own. From Jira or Slack the repository is the given one, else the only one whose `jiraProjectKeys` include the project, else the only registered repository; otherwise `repository_required` (shown as `ambiguous_repository`).

**The web description form (final review I3).** The form mounts only once the task detail is loaded, keyed on the detail's id and `updatedAt`, so its text always starts from `approvedDescription ?? draftDescription` (a detail that arrives late, or a newer one, gives a fresh form; a failed detail refresh keeps the one shown). A Jira or Slack draft carries the note "From <Jira|Slack>: written by someone else. Review and edit before approving — only what you approve is given to Claude." **Cancel task** and a step's **Reject** both confirm inline: "This cancels the task and discards Synapse's uncommitted changes. Committed work is kept on the task branch." (M7). **The title is not neutralised:** it is derived from the source text (the Jira key and summary, or the Slack message's first line) and appears as written in the commit message, the PR title and the lock title (spec E21 note).

## Investigation (E3)

`engineering.investigate {taskId}` is enqueued with one attempt when the description is approved. It is a read-only engineering run: `Read`, `Grep` and `Glob`, each `Tool(//<repo>/**)` (rule L), `workingDirectory` set to the registered realpath, model `engineering.model`, `engineering.investigate.maxTurns` (default 30, capped at 50 by the request schema), fixed 20-minute timeout. Its prompt has system parts plus exactly one `user_approved` part, the approved description. The output is Zod-validated: `summary`, `plan` (1 to 12 steps), `filesLikelyTouched`, optional `testCommand`, `risk`, `size`, `unclear`.

- A run with no successful `Read`, `Grep` or `Glob` result fails as `incomplete_ai_output` (ADR-026).
- `filesLikelyTouched` entries are kept only if they stay strictly inside the repository (realpath of the deepest existing ancestor; no `..`, no `.git` segment; a symlink out is dropped). A suggested `testCommand` that fails E5 is dropped, not fatal.
- Failure (`incomplete_ai_output`, `parse_failed`, `max_turns`, `timeout`, other run errors) returns the task to `proposed` with the code in `failure`. A quota or auth deferral leaves it `investigating` and the step `pending`.
- Exception to ADR-034: the output has no `suspectedInjection` field, as with the Phase 9 inspection: read-only scoped tools, no untrusted part, and a plan the user reviews.

## Plan approval, branch confirmation (E4, ADR-035)

`POST /api/engineering/tasks/:id/approve-plan {parentBranch, testCommand, environmentId?, rememberAsTracked?}` is one user action. The service checks, in order:

1. The input schema: a bad `testCommand` is `unsafe_test_command`, a bad `parentBranch` is `unknown_branch`.
2. The task is `planned` with a plan (`invalid_state` otherwise).
3. A given `environmentId` belongs to the repository (`unknown_environment`) and is not protected (`protected_branch`).
4. The parent equals no **protected** environment's branch (`protected_branch`). There is no override in this phase.
5. `RepositoryProvider.inspect`: the path is still the registered top level (`path_unavailable`) and the parent exists locally or on a remote (`unknown_branch`).

Then, in one transaction, the task becomes `queued` with `parent_branch`, `task_branch` (`synapse/<first 8 of id>-<slug of title>`), `environment_id`, and the test command is stored per repository in `repositories.test_command`. Only after that does `rememberAsTracked` call the registry (`repo.updated`); a refusal becomes `registry_error:<code>` and the task stays `queued`.

**Auto-deploy notice.** The web plan screen (`PlanApproval`) shows the repository, environment, parent, task branch, `PR origin/<parent> -> upstream/<parent>`, the test command and the plan, and a red notice "merging the PR deploys <env>" when the chosen environment, or else the one whose branch equals the parent, has `auto_deploys_on_merge`. The server repeats the same notice in the `push_pr` and `merge_pr` approval payloads (`autoDeploys`, `environmentName`), taken from the environment whose branch **is the parent** (not blindly from `environment_id`), and `push_pr` is risk `high` when it applies.

## The test command (E5, as amended)

- Characters `[A-Za-z0-9 ._:/=@+-]`, 1 to 120 long: no `;`, `&`, `|`, `>`, `<`, backquote, `$`, quote or newline.
- The first word is one of `npm, pnpm, yarn, bun, npx, uv, pytest, python, python3, make, go, cargo, deno`.
- **Amendment (final T1 review):** a single word is allowed only for `pytest` and `make`. Every other runner needs at least two words (`bun test`, `npx vitest run`), so a bare interpreter or package runner (a REPL, `python`) is refused.
- **Amendment (final review, supersedes the one above):** each runner is allowed only in its test form. Allowed: `bun|npm|pnpm|yarn test …`; `bun|npm|pnpm|yarn run <script>` only when the script matches `^test([:\w-]*)$`; `npx vitest|jest|mocha|playwright|ava …`; `pytest …`; `python|python3 -m pytest|unittest …`; `uv run pytest …` or `uv run python -m pytest|unittest …`; `make` whose every word is a target starting with `test` or `check` or one of `-j[N]`, `-k`, `-s`, `--keep-going`, `--silent`, `--jobs=N` (bare `make`, `-f`, `-C`, `VAR=…` refused); `go test …`, `cargo test …`, `deno test …`. Any later word `-c`, `-e`, `--eval`, `exec`, `x`, `dlx`, `pip`, `install` or `add` is refused, and so are `go run`, `cargo run`, `deno run` and every other subcommand. The model may still append arguments at run time (that is the prefix grant), and the tests themselves are repository code.
- It is granted as exactly one `Bash(<testCommand>:*)`. Validator rule L allows at most one Bash grant, only in that form (rule 0 admits spaces only inside `Bash(<safe chars>:*)`). The model may append arguments to the command.
- Verified on the real CLI (2026-11-06, provider level): with `Bash(bun test:*)` allowed, `bun test` ran; `ls <outside>`, `bun test && touch …`, `bun test; touch …` and `bun test $(touch …)` were all denied and created nothing.
- The test result (ADR-026) is taken from the last Bash `tool_result` whose command is the test command (optionally followed by arguments): `isError`, or no such result, means `testsPassed=false`. The tail is at most 2000 code points of that result. The model's own claim is ignored.
- **Test-run honesty (final review M1).** Alongside `testsPassed`, the develop output and the commit payload record `testRun`: `exact` (the last test run's command equals the confirmed command), `partial` (the confirmed command plus arguments, so possibly a subset of the suite) or `none` (it never ran). The commit card and the PR body use one wording (`testResultLabel` in `packages/contracts/src/patterns.ts`): "Tests passed", "Tests failed", "Partial test run (passed|failed)" or "Tests not run".

## The global lock, recovery and resume (E6, ADR-030)

- Lease `engineering`, holder `task:<id>`, TTL `engineering.lock.ttlMinutes` (default 10). `engineering.lock_renew` runs every 2 minutes and extends the lease while the holder is `in_progress` or `awaiting_approval`; it works after a lapse such as sleep.
- **An existing lease row always means held, even once expired.** `acquire` refuses any other holder and pickup skips with `lock_held`; only recovery decides what an expired lease means, so a crashed task can never be overtaken. The renew tick looks at a terminal holder's expired lease only when no `engineering.step` job is live and no `approval.execute` job for that task is running (final review M3): its cleanup done, or skipped for `config_changed` (that skip releases the lock), → released; its cleanup never ran (no row, pending, an earlier failed attempt, or skipped while another task held the lock) → an `engineering.step {cleanup}` job is enqueued instead (cleanup releases the lock on success); its cleanup started but died (`running`, no live job) → the task goes to `needs_attention` with `cleanup_incomplete` and the lock is kept, so the tick never loops.
- **Pickup** (`engineering.pickup`, every minute): when no lease exists, the highest-priority, oldest `queued` task takes the lock, the parent is re-checked against protected branches, and preflight runs (E7: registered path equals git top level, clean tree, no merge or rebase in progress, `origin` and `upstream` exist, every upstream push URL disabled unless the registry recorded otherwise, parent exists on both remotes). **A passing failure (final review I1): `fetch_failed` or `git_timeout`** (the remotes could not be reached, `ls-remote` failed) releases the lock, leaves the task `queued`, sets `last_pickup_error` (shown as "Waiting to retry: …") and bumps `pickup_failures`, audits `engineering.pickup_deferred` only when the error code changes, and the task backs off: `nextQueued` skips it until `updated_at` plus 1 minute after the first failure, doubling per consecutive failure up to 30 minutes. The same tick then tries the next eligible queued task (up to 20), so a failing repository never blocks another. A pickup resets the counter. Every other failure is deterministic (`dirty_tree`, `merge_in_progress`, `not_a_repository`, `missing_remote`, `upstream_push_enabled`, `parent_missing_*`, `protected_branch`, `git_failed`) and sets `needs_attention` with the code and releases the lock. Success clears `last_pickup_error`, sets `in_progress` at `branch` and enqueues `engineering.step {taskId, step:"branch"}` (one attempt).
- **Recovery** runs once at boot, after the API port is bound and before the worker starts, for any lease row (at boot every lease belongs to a dead process, so a quick restart is checked like an expired one):

  | Holder | Action |
  |---|---|
  | No task, or an unparseable holder | Release |
  | Terminal task | Keep while a step job (its cleanup) is live; keep and enqueue its cleanup when the cleanup never finished, including one the restart interrupted (`running`), once (M3); otherwise release |
  | `needs_attention` | Keep |
  | `queued` or before plan approval | Release (Synapse never touched the tree) |
  | `awaiting_approval` at `commit` | Resume (approval stays pending) when the config fingerprint and the diff hash plus git-dir baseline still equal the approval's; else `needs_attention` (`config_changed`, `unsafe_change`, `diff_changed`) |
  | Anything else | Local tree checks only (`GitWorkflow.localState`: realpath equals git's top level, no merge/rebase/cherry-pick/revert in progress, clean status; **no remote is contacted**, so a boot without network never strands a task, final review I1). `dirty_tree`, `merge_in_progress`, `not_a_repository` or a git error: `needs_attention`, lease kept. Clean and `awaiting_approval`: resume. Clean and `in_progress`: re-drive `branch` while the task branch does not exist, `develop` while the git dir equals the stored baseline, or `update_parent` (idempotent); anything else (an executor that was running) is `needs_attention` with `resume_unsafe` |

  When recovery sets `needs_attention` it also expires the task's open approvals. A pending or retried step job for the same step suppresses a duplicate enqueue.
- The user's own concurrent work in the checkout is not a design concern (ADR-030), but the develop step requires a clean tree and the commit step requires the diff to be exactly what was shown.

## The develop run (E9)

Preconditions: the task branch is checked out, the tree is clean (`dirty_tree`), the test command is still safe. Synapse then takes **`gitDirFingerprint` and `configFingerprint` immediately before the run** and stores both on the step output.

Run: engineering profile, model `engineering.model`, `engineering.develop.maxTurns` (default and cap 50), `engineering.develop.timeoutMinutes` (default 30), one attempt, `workingDirectory` the repo realpath, `--permission-mode default`. Tools: `Read`, `Grep`, `Glob`, `Edit`, `Write`, `MultiEdit`, each `Tool(//<repo>/**)`, and `Bash(<testCommand>:*)`. Everything else is denied (see the orchestrator doc).

**Sandbox (ADR-040).** The request carries a `sandbox` spec (`tmpDir`, `denyRead`) built by `buildDevelopRequest` when `engineering.sandbox.enabled` is true, and the provider turns it into the CLI sandbox settings (no network, masks, private `TMPDIR`; see the orchestrator doc and security-model §3.1). Rule M refuses a Bash grant without it. Consequences for the step:

- **Setting off:** `engineering.sandbox.enabled = false` means no develop runs. The step fails closed with `sandbox_disabled`, never an unsandboxed run. `sandbox_unavailable`, `sandbox_disabled`, `sandbox_path_too_long` and `sandbox_root_masked` end `needs_attention` with the lock kept (the user fixes the environment); `repo_in_masked_path` ends `failed` (with cleanup).
- **`repo_in_masked_path`:** before the run, a repository whose realpath is at or under `/tmp`, `/run` or `/var/run`, or at or inside a mask entry (`~/.config`, `~/.claude`, other home entries, the Synapse data directory, the backup directory) is refused. The fixed masks would hide it from its own run, and unmasking a home entry, the database or the backups would expose them to test code.
- **`sandbox_unavailable`:** a run that fails because the sandbox could not start (the CLI's startup failure reason or stderr, an error result, or the Bash tool_result message "Sandbox is required but failed to initialize") fails the step with this reason, not as failed tests; the task goes to `needs_attention` with the hint "Install bubblewrap and socat (sudo apt install bubblewrap socat), then use Try again.". Try again requeues the develop step (see "Retry develop"). A sandbox network violation in a tool result does not change `testsPassed`, which still comes from the exit status (ADR-026).
- **`sandbox_root_masked`:** the run root (`<cache>/synapse/<8hex>`) is at or under a masked path (a home mask entry such as `~/.config`, the data or backup directory, `/tmp`, `/run`, `/var/run`), so every run's `TMPDIR` would be hidden. The run is refused before anything is created; set `XDG_CACHE_HOME` to a directory outside the protected folders, restart, and try again. The `sandbox` health check reports `run_root_masked` for the same condition.
- **`sandbox_path_too_long`:** the run's `tmpDir` (`<cache>/synapse/<8hex>/r/<8hex>/t`, `<cache>` being `$XDG_CACHE_HOME` when absolute, else `~/.cache`) is capped at 64 bytes, because the sandbox's unix bridge sockets live under it. A longer path refuses the run before anything is created; set `XDG_CACHE_HOME` to a shorter path and restart the API.
- **Placeholders:** the sandbox leaves empty mount targets in `.git` (`branches/`, `remotes/`, `config.worktree`, `objects/info/alternates`, `objects/info/commit-graphs/`, `.claude-sandbox-noreplace/` markers) and `.claude/.cc-writes/` at the repository top. After the run and before the fingerprint, diff and unsafe checks the step removes those that did not exist before and are empty (never anything non-empty, pre-existing or reached through a symlink); the count is `sandboxPlaceholdersRemoved`. An unknown or non-empty leftover is still flagged `git_dir_changed`.
- **Network:** a repository whose tests need the network cannot use develop runs (follow-ups).
- **Run scratch:** the private `TMPDIR` lives under the per-instance cache root and is removed after the run (also on a throw, timeout or abort); leftovers from a killed process are swept at API start, from this instance's own `r/` only. Old instance roots (8-hex real directories under the cache base, not this instance's, nothing modified in 7 days) are pruned at start. Parts: one system part (implement exactly the plan, minimal changes, run exactly the test command, never touch `.git`, `.gitattributes`, `.gitmodules` or `.lfsconfig`, never run git), the `user_approved` description and the `user_approved` plan. `expectedToolNames` requires a real `Edit`, `Write` or `MultiEdit` result (ADR-026).

After the run Synapse computes the diff against the baseline fingerprint (the fingerprint is compared **before** any git command runs, because git can run filters and hooks):

- **Unsafe** (`needs_attention`, `unsafe_change`; no approval is requested): a changed `.git` or git config (`git_dir_changed`), a path with a `.git` segment, `..`, an absolute path or one resolving outside the repository, a symlink pointing outside or into `.git`, a submodule or special file, an unreadable path, or a change to `.gitattributes`, `.gitmodules` or `.lfsconfig` (`git_metadata_changed`). The reasons go on the step output.
- **Empty diff:** `failed` with `no_changes`, then cleanup.
- **Run failure** (`max_turns`, `timeout`, or an error kind): `failed` and cleanup when the tree is still clean, else `needs_attention`. A quota or auth deferral puts the step back to `pending`.
- Otherwise the `engineering.commit` approval is requested (risk medium).

The develop step output holds the fingerprints, `sandboxPlaceholdersRemoved` (ADR-040: empty sandbox mount placeholders the run left in `.git` and `.claude`, removed before any fingerprint, diff or unsafe check), `diffHash`, the files with `+/-` counts, `unsafeReasons`, `diffText` (at most 200 KB, plain text), `testsPassed`, `testRun`, `testOutputTail`, the model's summary and notes (display only) and the names of any permission denials. The `GitWorkflow.configFingerprint` covers `.git/config`, `config.worktree`, `.git/info/attributes`, `.git/hooks/**`, `~/.gitconfig`, `$XDG_CONFIG_HOME/git/{config,attributes}` and `/etc/gitconfig`; `gitDirFingerprint` adds the rest of the git dir (HEAD, refs, packed-refs, the index by content; not object stores or reflogs). Both use filesystem reads only. `include.path` and `includeIf.*.path` targets of the config files are fingerprinted (depth 10, visited set, `includeIf` unconditional, a missing target hashes as `missing`; ADR-040 chain, `git-includes.ts`). **Not covered:** includes nested deeper than 10. **Upgrade note:** after follow-ups batch 3 a repository whose git config uses `include` or `includeIf` gets a different config fingerprint, so a task waiting on approval during the upgrade stops with `config_changed` (fail closed); cancel it and propose it again.

## Steps, approvals and revalidation (E8 to E14, E18)

Approval actions: `engineering.commit`, `engineering.merge_local`, `engineering.push_pr` (policy `approval_required`) and `engineering.merge_pr` (`explicit_approval_required`, risk always `high`). All use `targetIntegration=engineering`, `targetRef=<taskId>` and the idempotency key `engineering:<step>:<taskId>:<attempt>`. Payloads carry no secrets; the diff text and test tail live on the develop step output.

Every executor first **claims** the step (`awaiting_approval -> in_progress`, only while the task is at that step with that approval id), so a cancelled task never executes. Every approval is **revalidated** before execution: the task is `awaiting_approval` at the step with this approval id; the lock holder is `task:<id>` (`lock_lost`); the parent is not a protected environment branch (re-read every time); then the step-specific check below. A failed revalidation revokes the approval as system, sets `needs_attention` with the code and marks the step `failed`; the engine then skips the execution. If revalidation passed but the executor then finds the task unworkable (the repository path vanished in between: `path_unavailable`, final review M9), the task goes to `needs_attention` with that reason and the step is `failed` the same way; the approval was already claimed, so the engine records it `failed` rather than revoked. A task is never left `awaiting_approval` without a live approval.

| Step | How it runs | Revalidate (beyond the common checks) | Execution |
|---|---|---|---|
| `branch` (plan approval) | `engineering.step` job. Records `returnTo` (the branch checked out at pickup), `git fetch` of the parent from `origin` and `upstream`, fast-forwards the local parent to `origin/<parent>` only, `git switch -c <taskBranch> <parent>` (`--no-track`). Stores `baseSha` | none | none |
| `develop` (plan approval) | `engineering.step` job, above | none | none |
| `commit` | approval `engineering.commit`: files, `+/-`, diff, test result, message `<title>` + description summary + `Task: <id>` | `configFingerprint` equal (checked first), then `diffSummary({gitDirBaseline})` safe and `hash === diffHash` (`config_changed`, `unsafe_change`, `diff_changed`) | `commitAll`: check hash, `git add -A`, check again (`git reset` and `diff_changed` on mismatch), `git commit -m`; author and committer from the repo's git config. Then enqueues `update_parent` |
| `update_parent` | `engineering.step` job, no approval (changes no remote). Switch to the parent, fetch `origin` and `upstream` (explicit refspecs), `merge --ff-only`, falling back to a merge commit. Not `git pull`, so `pull.rebase` config cannot make it a rebase. A conflict is aborted (`merge --abort`) and becomes `needs_attention` (`parent_conflict`) | n/a | Requests `engineering.merge_local` |
| `merge_local` | approval `engineering.merge_local`: the commits and the target. Payload pins `commitSha` | config fingerprint; `branchTip(taskBranch) === commitSha` (`branch_moved`) | `mergeLocal` re-checks the tip and runs `git merge --no-ff <commitSha>`; a conflict is aborted and becomes `needs_attention` (`merge_conflict`). Protection is re-checked at execution. Records `mergeSha` |
| `push_pr` | approval `engineering.push_pr`: commits (up to 50, plus `commitsTotal`), "push to origin/<parent> (your fork)", PR title and body, `origin/<parent> -> upstream/<parent>`, auto-deploy notice. Payload pins `mergeSha` | config fingerprint; `branchTip(parent) === mergeSha` (`branch_moved`) | Resolves owner and repo of both stored URLs through `PullRequestProvider.repoRef` first (`unsupported_remote` before anything is pushed; github.com only). `pushParent` pushes exactly `<mergeSha>:refs/heads/<parent>` to `origin` (no force, no `+`; refused when the origin push URL is the upstream repository, same normalised URL or same `owner/repo`, or when there is nothing to compare against, and when the parent is protected; **refused with `origin_changed` when any effective origin push URL, `git remote get-url --push --all origin` with insteadOf rules expanded, is not the registered origin by normalised URL or `owner/repo`; for non-`file:` URLs the host must also match after normalisation (lower-cased, `ssh://git@github.com/…`, `git@github.com:…` and `https://github.com/…` are one host), so the same `owner/repo` on another host is refused; an ssh host alias from `~/.ssh/config` counts as a mismatch, so users with host aliases see `origin_changed`**, final review M10). Records `pushedSha`. Then `gh pr create --repo <upstream> --head <fork owner>:<parent> --base <parent> --title --body` (argv). **The PR URL and number are written to the task the moment the PR exists**, before anything else and even if the task was cancelled meanwhile (M5). The PR status read here carries `checkedAt`. A failure after the push is `needs_attention` with `pushed: true` kept on the output |
| `merge_pr` | approval `engineering.merge_pr` (risk high): the PR, its checks status ("checks <status> at <time>"), the auto-deploy warning. Payload pins `pushedSha` | A fresh `prStatus()` (kept on the step output as `freshStatus` with `checkedAt`, and shown on the card when newer, M6): `headSha === pushedSha`, else **`pr_head_moved`**; checks `failing` → **`checks_failing`** (other check states are shown, not refused); PR number and `pushedSha` equal the push step's | `gh pr merge <n> --repo <upstream> --merge --match-head-commit <pushedSha>`: GitHub itself refuses if the head moved. `headSha` must be a full hex sha or the adapter refuses without running gh. Protection is re-checked at execution. Then the task is `completed` and cleanup runs. **If the task was cancelled while gh merged it** (M5), the merge is the truth: the task becomes `completed` with `failure = merged_after_cancel`, the step output records `outcome: "merged_after_cancel"` and `mergeSha` (gh's merge commit when reported, else null with the merged PR head as `prHeadSha`), then cleanup runs |

**SHA pinning.** Each approval fixes the exact commit it shows: the task-branch tip (merge_local), the merge commit (push_pr, pushed as `<sha>:refs/heads/<parent>`) and the fork head (merge_pr, `--match-head-commit`). Anything the user committed in between makes the step fail closed with `branch_moved` or `pr_head_moved` and nothing is pushed or merged. The same fingerprint checks run in the adapter before any git command (`config_changed`).

Reject, revoke or expire of the current step approval cancels the task (step `skipped`, the other open approvals expired, cleanup enqueued).

Every `GitWorkflow` call runs through the hardened runner (E17): argv only, `-c core.fsmonitor=false -c core.hooksPath=/dev/null -c credential.interactive=never`, `-C <registered realpath>`, a clean environment (`PATH`, `HOME`, `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, `LC_ALL=C`, plus `SSH_AUTH_SOCK`, `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` when set), a 60 s timeout (120 s for push, fetch, pull and ls-remote). Every merge also carries `-c branch.<parent>.mergeOptions= -c rerere.enabled=false -c rerere.autoUpdate=false -c submodule.recurse=false`, so configured auto-resolution cannot hide a conflict. Refs are validated before git runs (`invalid_ref`). Tokens are never read: ssh-agent, the credential helper and `gh auth` are used as configured.

### Editing the commit and PR text, and re-requesting the merge (F2, F3.2)

- **Text edits.** `PUT /api/engineering/tasks/:id/approvals/:approvalId` with `{commitMessage?}` (for `engineering.commit`) or `{prTitle?, prBody?}` (for `engineering.push_pr`). Allowed only while the approval is `pending` and belongs to the task's current step. Limits: `commitMessage` 1 to 5000 characters with a non-blank first line of at most 200; `prTitle` 1 to 200 characters, no newline; `prBody` at most 20000. Control characters other than tab and newline (`\r` included) and unpaired surrogates are refused. It updates the payload in one transaction and audits `engineering.approval_edited` (ids and changed field names only, never the text). Errors: 409 `not_pending`, 400 `invalid_text`. The executors read the payload, so they use the edited text; the diff hash and SHA pins do not involve the text, so revalidation is unchanged. The web shows textareas on the commit and push cards; Save stores an edit, and Approve sends any unsaved edit first.
- **Retry develop (H3).** `POST /api/engineering/tasks/:id/retry-develop` is allowed only for the lock holder at `needs_attention` / step `develop` with a failure in `DEVELOP_RETRY_REASONS` (`sandbox_unavailable`, `sandbox_disabled`, `sandbox_path_too_long`, `sandbox_root_masked`); else 409 `not_retryable` (404 `not_found` for an unknown task). It then requires `engineering.sandbox.enabled` (`sandbox_disabled`) and an `ok` `sandbox` health check (`sandbox_root_masked` when the detail is `run_root_masked`, else `sandbox_unavailable`), all 409. In one immediate transaction it re-checks eligibility, moves the task to `in_progress` with the failure cleared, resets the develop step to `pending`, enqueues a fresh develop job and audits `engineering.develop_retried`. A second call is `not_retryable`. `sandbox_path_too_long` needs a shorter `XDG_CACHE_HOME` and an API restart first, since the cache path is read at startup. Before queuing, for `sandbox_unavailable` only (a run may have edited before it failed) it re-compares the failed run's stored git-dir and config fingerprints with the repository (before any git command); a mismatch, or a missing stored fingerprint, is 409 `unsafe_change` (fail closed). The pre-run reasons (`sandbox_disabled`, `sandbox_path_too_long`, `sandbox_root_masked`) skip that comparison because no model ran. A git error while checking is 409 `git_failed`. Then it requires an empty diff (else 409 `changes_left`); for `sandbox_path_too_long` it re-checks the 64-byte run path (409 `sandbox_path_too_long`). In each refusal nothing is queued and the task is unchanged. For `sandbox_disabled`, `sandbox_unavailable` and `sandbox_root_masked`, fix the environment (turn the sandbox on, install bubblewrap and socat, move `XDG_CACHE_HOME`) and use Try again; for `sandbox_path_too_long`, shorten `XDG_CACHE_HOME`, restart Synapse, then Try again. For `unsafe_change` and `changes_left`, cancel the task and propose it again; `git_failed` is transient, so retry shortly. The Needs-you card has "Try again".
- **Re-request `merge_pr`.** `POST /api/engineering/tasks/:id/retry-merge` is allowed only for the lock holder at `needs_attention` / `checks_failing` / step `merge_pr` (else 409 `invalid_state`). It re-reads the PR (`pr_status_failed` if that fails), requires it `OPEN` (`state_changed`) with the pushed head (`pr_head_moved`) and a non-protected parent (`protected_branch`). Failing checks, or pending ones while the PR is not mergeable, answer 409 `checks_failing`; otherwise it creates a fresh `engineering.merge_pr` approval and the task returns to `awaiting_approval`. The Needs-you card has "Check again".

## Cancel, discard and cleanup (E15, E16)

`POST /api/engineering/tasks/:id/cancel`: a task without the lock is cancelled directly (a `queued` task enqueues no cleanup); a lock holder is cancelled and gets an `engineering.step {cleanup}` job. A terminal task gives `invalid_state`; a `needs_attention` task whose prior status was `completed` or `failed` is not cancelled, its cleanup is retried and restores that status (M8).

Cleanup runs after `completed`, `cancelled` or `failed`:

1. Skipped with no git call while another task holds the lock (`lock_held_by_other`), when the task is not terminal (`not_terminal`), or deferred while this task still has an operation running in this process (`step_running`; re-run when it ends).
2. Expires the task's open approvals; runs no git if the branch step never completed.
3. If `configFingerprint` differs from the latest one Synapse checked, no git runs at all: the step is `skipped` (`config_changed`) and the lock is released (the user cannot restore a fingerprint, and keeping the lock would block engineering forever).
4. **Discard.** Before a commit, `discardChanges` throws away the run's uncommitted changes (`git reset --hard HEAD` plus `git clean` of exactly the untracked paths of that diff, as literal pathspecs; ignored files are left alone), **only** when the tree still hashes to the develop `diffHash`, the diff is safe and the config is unchanged. If the user touched anything, nothing is discarded and cleanup sees a dirty tree.
5. **Where to go (final review I2).** The return branch is `returnTo` if it still exists locally, else the parent if it still exists, else none: cleanup stays on the current branch. **The task branch is never deleted while it is checked out**; in that case it is kept (`outcome: "branch_kept"`) and the lock is still released.
6. **Branch keeping.** Switch to the return branch and delete the task branch. `git branch -D` is used **only when the branch tip still equals `baseSha`**, that is, it holds no commit. Any commit (Synapse's, a user's, or one whose bookkeeping a crash lost) is deleted only when another local branch contains it; otherwise the branch is kept and the step output records `outcome: "branch_kept"`.
7. A dirty tree is left exactly as it is: `needs_attention` (`dirty_tree`) and the lock is kept; the user tidies up and cancels again. Otherwise the lock is released.

Consequences to know:
- **`pushed_not_pr`.** If the task is cancelled while the push is running, the push stays (it cannot be undone), no PR is created, the `push_pr` step output is `{pushed, pushedSha, outcome: "pushed_not_pr"}` and an audit row `engineering.pushed_not_pr` is written. Once a PR exists, cancelling leaves the PR as it is; Synapse never closes or edits it.
- **An unpushed local merge commit after a cancel that follows `merge_local`.** `merge_local` merges into the local parent branch. Cancelling at the `push_pr` or `merge_pr` approval deletes the (now merged) task branch but **leaves the merge commit on the local parent branch**, unpushed. Synapse never rewinds a branch the user may have worked on. The user decides whether to reset it.

## Routes (E19)

| Route | Notes |
|---|---|
| `GET /api/engineering/tasks?status=` | Task views. Never carries description, plan or step output |
| `POST /api/engineering/tasks {repositoryId, title, draftDescription}` | 201 |
| `POST /api/engineering/tasks/from-jira {key, repositoryId?}`, `from-slack {messageId, repositoryId?}` | 201. `repositoryId` is optional (see E2 for resolution) |
| `GET /api/engineering/tasks/:id` | Task with plan and steps; the only place diff and test text are served |
| `POST …/:id/approve-description {description}` | Enqueues the investigation |
| `POST …/:id/approve-plan {parentBranch, testCommand, environmentId?, rememberAsTracked?}` | E4 |
| `POST …/:id/cancel` | E16 |
| `PUT …/:id/approvals/:approvalId {commitMessage?\|prTitle?, prBody?}` | Edit the pending commit or push text (F2.1); 409 `not_pending`, 400 `invalid_text` |
| `POST …/:id/retry-develop` | Queue the develop step again after a sandbox refusal (H3); 409 `not_retryable`, `sandbox_disabled`, `sandbox_unavailable`, `sandbox_root_masked`, `sandbox_path_too_long`, `unsafe_change`, `changes_left`, `git_failed` |
| `POST …/:id/retry-merge` | Re-request `merge_pr` after `checks_failing` (F3.2); 409 `checks_failing` while checks still fail |
| `GET /api/engineering/lock` | `{held, taskId?, since?}` |

Step approvals are decided through the existing `/api/approvals/:id/approve|reject|revoke`. Errors are fixed codes only (`{error}`): `not_found` 404, `path_unavailable` 409, `ambiguous_repository`, `invalid_input`, `invalid_state`, `no_content`, `unknown_branch`, `unknown_environment`, `protected_branch`, `unsafe_test_command` and `registry_error:<code>` 400; `not_pending` 409, `invalid_text` 400, `pr_status_failed`, `state_changed`, `pr_head_moved`, `checks_failing` 409 (from the approval edit and `retry-merge` routes); `not_retryable`, `sandbox_disabled`, `sandbox_unavailable`, `sandbox_root_masked`, `unsafe_change`, `changes_left`, `sandbox_path_too_long`, `git_failed` 409 (from `retry-develop`). `DELETE /api/repos/:id` (the registry) answers 409 `repo_has_active_task` while an engineering task of the repository is not finished (M4). Overview: `counts.engineeringAwaiting` and `engineeringLock {held, taskId?, taskTitle?, since?}`.

## Settings

| Key | Default | Notes |
|---|---|---|
| `engineering.model` | `sonnet` | `haiku`, `sonnet` or `opus`; both runs |
| `engineering.investigate.maxTurns` | 30 | 1 to 100; the request caps it at 50 |
| `engineering.develop.maxTurns` | 50 | 1 to 50 |
| `engineering.develop.timeoutMinutes` | 30 | 1 to 120 |
| `engineering.lock.ttlMinutes` | 10 | 1 to 120 |
| `engineering.sandbox.enabled` | `true` | Boolean, editable in Settings. Off means no develop runs (`sandbox_disabled`), never an unsandboxed one (ADR-040) |

The investigation timeout is fixed at 20 minutes. `repositories.test_command` stores the last confirmed test command per repository.

## Events and audit

- Events: `engineering.task_created {taskId}`, `engineering.task_status_changed {taskId, status}`, `engineering.step_changed {taskId, step, status}`, `engineering.lock_changed {held}`. Approval events are the core ones.
- Audit actions (ids, enums and counts only; never text, paths, branch names or diffs): `engineering.task_created`, `description_approved`, `investigated`, `investigate_failed`, `plan_approved`, `picked_up`, `pickup_deferred`, `preflight_failed`, `branch_created`, `developed`, `committed`, `parent_updated`, `merged_local`, `pushed`, `pushed_not_pr`, `completed`, `step_failed`, `revalidate_failed`, `step_rejected`, `cancelled`, `cleaned`, `cleanup_failed`, `cleanup_skipped`, `cleanup_requeued`, `lock_acquired`, `lock_released`, `lock_recovered`, `approval_edited`.

## Reason codes

Shown to the user as fixed sentences (`apps/web/lib/engineering.ts` `reasonLabel`); unknown codes are never echoed.

- Route and task: `not_found`, `invalid_input`, `invalid_state`, `ambiguous_repository`, `repository_required`, `no_content`, `unknown_branch`, `unknown_environment`, `protected_branch`, `unsafe_test_command`, `path_unavailable`, `registry_error:<code>`.
- Step outcomes: `unsafe_change`, `no_changes`, `config_changed`, `parent_conflict`, `merge_conflict`, `pr_head_moved`, `branch_kept`, `pushed_not_pr`, `resume_unsafe`, `branch_changed`, `revalidate_failed`, `invalid_payload`, `unsupported_remote`, `state_changed`, `lock_held`, `max_turns`, `timeout`, `lock_lost`, `lock_held_by_other`, `step_running`, `not_terminal`, `checks_failing`, `merged_after_cancel`, `cleanup_incomplete`, `not_pending`, `invalid_text`, `pr_status_failed`, `state_changed`, and `repo_has_active_task` (registry refusal).
- Sandbox (ADR-040): `sandbox_unavailable`, `sandbox_disabled`, `sandbox_path_too_long`, `sandbox_root_masked`, `repo_in_masked_path`.
- Preflight: `not_a_repository`, `merge_in_progress`, `dirty_tree`, `missing_remote`, `upstream_push_enabled`, `parent_missing_origin`, `parent_missing_upstream`.
- `GitWorkflowError`: `git_failed`, `git_timeout`, `fetch_failed`, `push_failed`, `invalid_ref`, `branch_exists`, `branch_missing`, `diff_changed`, `nothing_to_commit`, `push_target_is_upstream`, `no_upstream_reference`, `branch_moved`, `origin_changed` (plus `missing_remote`, `dirty_tree`, `unsafe_change`, `protected_branch`, `config_changed` above).
- `PullRequestError`: `gh_not_found`, `gh_auth`, `pr_create_failed`, `pr_status_failed`, `pr_merge_failed`, `unsupported_remote`.
- Unsafe diff reasons (step output): `git_dir_changed`, `git_path`, `outside_repo`, `symlink_outside`, `not_a_file`, `unreadable`, `git_metadata_changed`.
- Every code above is labelled in the web; `apps/web/test/engineering.test.ts` checks the label list against the contracts lists.
- Run error kinds from the orchestrator (`incomplete_ai_output`, `parse_failed`, `auth_failed` and so on) can appear in `failure` too.

## Differences from the spec

- **E11 and E8 use fetch plus merge, not `git pull`** (same steps; `pull.rebase` config cannot turn them into a rebase).
- **E5 amended** (two words for most runners, one Bash grant; then, at the final review, each runner only in its test form).
- **E6:** recovery looks at any lease at boot, not only an expired one, and resumes more cases (see the table).
- **E15:** `branch -D` only when the branch holds no commit; otherwise the containment rule and `branch_kept`. Uncommitted changes of a rejected or cancelled task are discarded (new `discardChanges`). The return branch falls back to the parent, then to staying put (I2).
- **E7 at pickup:** a network failure is retried (task stays `queued`), not `needs_attention` (I1).
- **E14:** failing PR checks refuse the merge (`checks_failing`); a PR merged during a cancel completes the task (M5). Since batch 1 the user can re-request the merge with `retry-merge` once checks pass.
- **E9 (ADR-040):** the test command runs sandboxed; the develop step removes the sandbox's empty placeholders before the fingerprint check.
- **E10 and E13 (editing the commit message, PR title and PR body) are built since follow-ups batch 1:** `PUT …/approvals/:approvalId` (see "Editing the commit and PR text").
- `approved` is unused; a failed investigation returns to `proposed`, not `failed`.
- `engineering.develop.maxTurns` default is 50, not 60 (the request schema caps a run at 50 turns).
- The auto-deploy notice at plan approval is rendered by the web from the registry; the server states it in the push and merge approval payloads.
- E19 `from-jira` and `from-slack` take an optional `repositoryId`. When the API answers `ambiguous_repository` the web shows a select of registered repositories (names only) and retries with the chosen id (F3.1).

## Cleanup outcomes in history (H2)

`EngineeringTaskView.cleanup` (so the list and the detail) is `null` or `{ branchKept, pushedNotPr, dirtyTree, priorStatus }`: fixed values only, never a path, branch name or text. It is `null` for a task that is not terminal, and for a terminal task when none of the sources below exists. Sources, all already recorded:

- `branchKept`: the `cleanup` step `output.outcome === "branch_kept"`.
- `pushedNotPr`: the `push_pr` step `output.outcome === "pushed_not_pr"`.
- `dirtyTree`: the `cleanup` step is `failed` with `output.failure === "dirty_tree"`. A later successful cleanup overwrites that row, so it then reads `false`.
- `priorStatus`: for `cancelled` tasks only, `details.from` of the latest `engineering.cancelled` audit row (the cleanup step's own `output.priorStatus` means something else, see M8). It fades to `null` once audit retention (`retention.auditDays`) prunes that row.

`cleanupViews` reads them with two queries for a whole list. The web History rows render them as badges ("Branch kept", "Pushed, no PR", "Uncommitted changes left", "Cancelled from <status>").

## Deferred

See `docs/superpowers/plans/2026-11-06-phase-10-followups.md`. Done in follow-ups batch 3: `include.path` fingerprinting. Done in follow-ups batch 1: the develop-run sandbox (ADR-040), the repository picker, re-requesting `merge_pr`, and editing the commit message and PR text. Still open: non-GitHub hosts, overriding protected branches, multi-repo tasks, network-enabled sandboxes, and the sandbox items recorded there.
