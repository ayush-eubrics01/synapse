# Module: Engineering Tasks (Phase 10, as built)

Code: `apps/api/src/modules/engineering-tasks/` (`store.ts`, `service.ts`, `lock.ts`, `steps.ts`), `apps/api/src/workers/engineering/` (`investigate.ts`, `pickup.ts`, `steps.ts`), `apps/api/src/intelligence/engineering/` (`investigate-prompt.ts`, `develop-prompt.ts`), `apps/api/src/integrations/repository/git-workflow.ts` (the `GitWorkflow` adapter), `apps/api/src/integrations/github/gh-cli.ts` (the `PullRequestProvider` adapter), `apps/api/src/routes/engineering.ts`. Contracts: `packages/contracts/src/engineering.ts`, `repository.ts` (`GitWorkflow`), `pull-requests.ts`. Migration 0017. Authority: ADR-030, ADR-035, ADR-032, ADR-013, ADR-026. Spec: `docs/superpowers/specs/2026-11-06-phase-10-engineering-automation.md`. Follow-ups: `docs/superpowers/plans/2026-11-06-phase-10-followups.md`.

## Principle

The model edits files and runs the confirmed test command. **Nothing else.** Every Git operation (branch creation, commit, parent update, local merge, push, PR creation, PR merge, cleanup) is Synapse code: argv, no shell, through the hardened `GitWorkflow` runner or the `gh` adapter. Each write step waits for the user's approval of exactly what will happen, and the approval is revalidated before it runs. The model never sees Slack or Jira text (E2), never runs `git`, and never receives a credential.

## Task lifecycle and states

`engineering_tasks.status` (state machine in `store.ts`, `ALLOWED_TRANSITIONS`):

| Status | Meaning |
|---|---|
| `proposed` | Created (manual, from a Jira issue or from a Slack message). Not started. A failed investigation also returns here, with the code in `failure`, so the user can edit and re-approve |
| `investigating` | The description was approved and the read-only run is queued or running |
| `planned` | The plan is stored. A non-empty `plan.unclear` keeps the task here with the questions; re-approving a description re-investigates |
| `approved` | In the enum and the state machine, but unused: plan approval goes straight to `queued` |
| `queued` | Plan and branch confirmed. Waits for the lock (priority, then oldest) |
| `in_progress` | Holds the lock; a step (branch, develop, update_parent, an approval executor) is running |
| `awaiting_approval` | Holds the lock; one of the four step approvals is pending |
| `completed`, `failed`, `cancelled` | Terminal. Cleanup follows and then releases the lock |
| `needs_attention` | A fixed reason code is in `failure`. The lock is kept. The user resolves it and cancels (which re-runs cleanup) |

A terminal task moves on only to `needs_attention`, and only when cleanup finds a dirty tree (the prior terminal status is recorded on the cleanup step as `priorStatus`). Such a task can never go back to `queued`, `in_progress` or `awaiting_approval`; a `completed` one returns to `completed` when a retried cleanup succeeds.

Steps (`engineering_task_steps`, one row per task and step): `investigate`, `branch`, `develop`, `commit`, `update_parent`, `merge_local`, `push_pr`, `merge_pr`, `cleanup`. Step status: `pending`, `awaiting_approval`, `running`, `done`, `failed`, `skipped`. Step `output` is JSON (see below) and only `GET /api/engineering/tasks/:id` serves it.

## E2: description provenance (ADR-032)

The draft is prefilled from a Jira summary (summary only, never the description), a Slack message text, or typed by the user. It lives in `draft_description`, is shown with an "untrusted source" note and is rendered as plain text. The user edits it and approves it as `approved_description`. **Only `approved_description` and the approved plan ever reach a run that can act**, as `user_approved` parts, plus system parts. The title (which can come from a Jira summary) and the draft never do; tests assert this for both runs. Proposals from Jira or Slack never start on their own. From Jira or Slack the repository is the given one, else the only one whose `jiraProjectKeys` include the project, else the only registered repository; otherwise `repository_required` (shown as `ambiguous_repository`).

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
- It is granted as exactly one `Bash(<testCommand>:*)`. Validator rule L allows at most one Bash grant, only in that form (rule 0 admits spaces only inside `Bash(<safe chars>:*)`). The model may append arguments to the command.
- Verified on the real CLI (2026-11-06, provider level): with `Bash(bun test:*)` allowed, `bun test` ran; `ls <outside>`, `bun test && touch …`, `bun test; touch …` and `bun test $(touch …)` were all denied and created nothing.
- The test result (ADR-026) is taken from the last Bash `tool_result` whose command is the test command (optionally followed by arguments): `isError`, or no such result, means `testsPassed=false`. The tail is at most 2000 code points of that result. The model's own claim is ignored.

## The global lock, recovery and resume (E6, ADR-030)

- Lease `engineering`, holder `task:<id>`, TTL `engineering.lock.ttlMinutes` (default 10). `engineering.lock_renew` runs every 2 minutes and extends the lease while the holder is `in_progress` or `awaiting_approval`; it works after a lapse such as sleep.
- **An existing lease row always means held, even once expired.** `acquire` refuses any other holder and pickup skips with `lock_held`; only recovery decides what an expired lease means, so a crashed task can never be overtaken. The renew tick releases a terminal holder's expired lease only when no `engineering.step` job is live and no `approval.execute` job for that task is running.
- **Pickup** (`engineering.pickup`, every minute): when no lease exists, the highest-priority, oldest `queued` task takes the lock, the parent is re-checked against protected branches, and preflight runs (E7: registered path equals git top level, clean tree, no merge or rebase in progress, `origin` and `upstream` exist, every upstream push URL disabled unless the registry recorded otherwise, parent exists on both remotes). A failure sets `needs_attention` with the code and releases the lock. Success sets `in_progress` at `branch` and enqueues `engineering.step {taskId, step:"branch"}` (one attempt).
- **Recovery** runs once at boot, after the API port is bound and before the worker starts, for any lease row (at boot every lease belongs to a dead process, so a quick restart is checked like an expired one):

  | Holder | Action |
  |---|---|
  | No task, or an unparseable holder | Release |
  | Terminal task | Release, unless a step job (its cleanup) is live |
  | `needs_attention` | Keep |
  | `queued` or before plan approval | Release (Synapse never touched the tree) |
  | `awaiting_approval` at `commit` | Resume (approval stays pending) when the config fingerprint and the diff hash plus git-dir baseline still equal the approval's; else `needs_attention` (`config_changed`, `unsafe_change`, `diff_changed`) |
  | Anything else | Preflight tree checks. `dirty_tree`, `merge_in_progress`, `not_a_repository` or a git error: `needs_attention`, lease kept. Clean and `awaiting_approval`: resume. Clean and `in_progress`: re-drive `branch` while the task branch does not exist, `develop` while the git dir equals the stored baseline, or `update_parent` (idempotent); anything else (an executor that was running) is `needs_attention` with `resume_unsafe` |

  When recovery sets `needs_attention` it also expires the task's open approvals. A pending or retried step job for the same step suppresses a duplicate enqueue.
- The user's own concurrent work in the checkout is not a design concern (ADR-030), but the develop step requires a clean tree and the commit step requires the diff to be exactly what was shown.

## The develop run (E9)

Preconditions: the task branch is checked out, the tree is clean (`dirty_tree`), the test command is still safe. Synapse then takes **`gitDirFingerprint` and `configFingerprint` immediately before the run** and stores both on the step output.

Run: engineering profile, model `engineering.model`, `engineering.develop.maxTurns` (default and cap 50), `engineering.develop.timeoutMinutes` (default 30), one attempt, `workingDirectory` the repo realpath, `--permission-mode default`. Tools: `Read`, `Grep`, `Glob`, `Edit`, `Write`, `MultiEdit`, each `Tool(//<repo>/**)`, and `Bash(<testCommand>:*)`. Everything else is denied (see the orchestrator doc). Parts: one system part (implement exactly the plan, minimal changes, run exactly the test command, never touch `.git`, `.gitattributes`, `.gitmodules` or `.lfsconfig`, never run git), the `user_approved` description and the `user_approved` plan. `expectedToolNames` requires a real `Edit`, `Write` or `MultiEdit` result (ADR-026).

After the run Synapse computes the diff against the baseline fingerprint (the fingerprint is compared **before** any git command runs, because git can run filters and hooks):

- **Unsafe** (`needs_attention`, `unsafe_change`; no approval is requested): a changed `.git` or git config (`git_dir_changed`), a path with a `.git` segment, `..`, an absolute path or one resolving outside the repository, a symlink pointing outside or into `.git`, a submodule or special file, an unreadable path, or a change to `.gitattributes`, `.gitmodules` or `.lfsconfig` (`git_metadata_changed`). The reasons go on the step output.
- **Empty diff:** `failed` with `no_changes`, then cleanup.
- **Run failure** (`max_turns`, `timeout`, or an error kind): `failed` and cleanup when the tree is still clean, else `needs_attention`. A quota or auth deferral puts the step back to `pending`.
- Otherwise the `engineering.commit` approval is requested (risk medium).

The develop step output holds the fingerprints, `diffHash`, the files with `+/-` counts, `unsafeReasons`, `diffText` (at most 200 KB, plain text), `testsPassed`, `testOutputTail`, the model's summary and notes (display only) and the names of any permission denials. The `GitWorkflow.configFingerprint` covers `.git/config`, `config.worktree`, `.git/info/attributes`, `.git/hooks/**`, `~/.gitconfig`, `$XDG_CONFIG_HOME/git/{config,attributes}` and `/etc/gitconfig`; `gitDirFingerprint` adds the rest of the git dir (HEAD, refs, packed-refs, the index by content; not object stores or reflogs). Both use filesystem reads only. **Not covered:** `include.path` targets inside config files.

## Steps, approvals and revalidation (E8 to E14, E18)

Approval actions: `engineering.commit`, `engineering.merge_local`, `engineering.push_pr` (policy `approval_required`) and `engineering.merge_pr` (`explicit_approval_required`, risk always `high`). All use `targetIntegration=engineering`, `targetRef=<taskId>` and the idempotency key `engineering:<step>:<taskId>:<attempt>`. Payloads carry no secrets; the diff text and test tail live on the develop step output.

Every executor first **claims** the step (`awaiting_approval -> in_progress`, only while the task is at that step with that approval id), so a cancelled task never executes. Every approval is **revalidated** before execution: the task is `awaiting_approval` at the step with this approval id; the lock holder is `task:<id>` (`lock_lost`); the parent is not a protected environment branch (re-read every time); then the step-specific check below. A failed revalidation revokes the approval as system, sets `needs_attention` with the code and marks the step `failed`; the engine then skips the execution.

| Step | How it runs | Revalidate (beyond the common checks) | Execution |
|---|---|---|---|
| `branch` (plan approval) | `engineering.step` job. Records `returnTo` (the branch checked out at pickup), `git fetch` of the parent from `origin` and `upstream`, fast-forwards the local parent to `origin/<parent>` only, `git switch -c <taskBranch> <parent>` (`--no-track`). Stores `baseSha` | none | none |
| `develop` (plan approval) | `engineering.step` job, above | none | none |
| `commit` | approval `engineering.commit`: files, `+/-`, diff, test result, message `<title>` + description summary + `Task: <id>` | `configFingerprint` equal (checked first), then `diffSummary({gitDirBaseline})` safe and `hash === diffHash` (`config_changed`, `unsafe_change`, `diff_changed`) | `commitAll`: check hash, `git add -A`, check again (`git reset` and `diff_changed` on mismatch), `git commit -m`; author and committer from the repo's git config. Then enqueues `update_parent` |
| `update_parent` | `engineering.step` job, no approval (changes no remote). Switch to the parent, fetch `origin` and `upstream` (explicit refspecs), `merge --ff-only`, falling back to a merge commit. Not `git pull`, so `pull.rebase` config cannot make it a rebase. A conflict is aborted (`merge --abort`) and becomes `needs_attention` (`parent_conflict`) | n/a | Requests `engineering.merge_local` |
| `merge_local` | approval `engineering.merge_local`: the commits and the target. Payload pins `commitSha` | config fingerprint; `branchTip(taskBranch) === commitSha` (`branch_moved`) | `mergeLocal` re-checks the tip and runs `git merge --no-ff <commitSha>`; a conflict is aborted and becomes `needs_attention` (`merge_conflict`). Protection is re-checked at execution. Records `mergeSha` |
| `push_pr` | approval `engineering.push_pr`: commits (up to 50, plus `commitsTotal`), "push to origin/<parent> (your fork)", PR title and body, `origin/<parent> -> upstream/<parent>`, auto-deploy notice. Payload pins `mergeSha` | config fingerprint; `branchTip(parent) === mergeSha` (`branch_moved`) | Resolves owner and repo of both stored URLs through `PullRequestProvider.repoRef` first (`unsupported_remote` before anything is pushed; github.com only). `pushParent` pushes exactly `<mergeSha>:refs/heads/<parent>` to `origin` (no force, no `+`; refused when the origin push URL is the upstream repository, same normalised URL or same `owner/repo`, or when there is nothing to compare against, and when the parent is protected). Records `pushedSha`. Then `gh pr create --repo <upstream> --head <fork owner>:<parent> --base <parent> --title --body` (argv). A failure after the push is `needs_attention` with `pushed: true` kept on the output |
| `merge_pr` | approval `engineering.merge_pr` (risk high): the PR, its checks status, the auto-deploy warning. Payload pins `pushedSha` | `prStatus().headSha === pushedSha`, else **`pr_head_moved`**; PR number and `pushedSha` equal the push step's | `gh pr merge <n> --repo <upstream> --merge --match-head-commit <pushedSha>`: GitHub itself refuses if the head moved. `headSha` must be a full hex sha or the adapter refuses without running gh. Protection is re-checked at execution. Then the task is `completed` and cleanup runs |

**SHA pinning.** Each approval fixes the exact commit it shows: the task-branch tip (merge_local), the merge commit (push_pr, pushed as `<sha>:refs/heads/<parent>`) and the fork head (merge_pr, `--match-head-commit`). Anything the user committed in between makes the step fail closed with `branch_moved` or `pr_head_moved` and nothing is pushed or merged. The same fingerprint checks run in the adapter before any git command (`config_changed`).

Reject, revoke or expire of the current step approval cancels the task (step `skipped`, the other open approvals expired, cleanup enqueued).

Every `GitWorkflow` call runs through the hardened runner (E17): argv only, `-c core.fsmonitor=false -c core.hooksPath=/dev/null -c credential.interactive=never`, `-C <registered realpath>`, a clean environment (`PATH`, `HOME`, `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, `LC_ALL=C`, plus `SSH_AUTH_SOCK`, `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` when set), a 60 s timeout (120 s for push, fetch, pull and ls-remote). Every merge also carries `-c branch.<parent>.mergeOptions= -c rerere.enabled=false -c rerere.autoUpdate=false -c submodule.recurse=false`, so configured auto-resolution cannot hide a conflict. Refs are validated before git runs (`invalid_ref`). Tokens are never read: ssh-agent, the credential helper and `gh auth` are used as configured.

## Cancel, discard and cleanup (E15, E16)

`POST /api/engineering/tasks/:id/cancel`: a task without the lock is cancelled directly (a `queued` task enqueues no cleanup); a lock holder is cancelled and gets an `engineering.step {cleanup}` job. A terminal task gives `invalid_state`; a `needs_attention` task whose prior status was `completed` is not cancelled, its cleanup is retried.

Cleanup runs after `completed`, `cancelled` or `failed`:

1. Skipped with no git call while another task holds the lock (`lock_held_by_other`), when the task is not terminal (`not_terminal`), or deferred while this task still has an operation running in this process (`step_running`; re-run when it ends).
2. Expires the task's open approvals; runs no git if the branch step never completed.
3. If `configFingerprint` differs from the latest one Synapse checked, no git runs at all: the step is `skipped` (`config_changed`) and the lock is released (the user cannot restore a fingerprint, and keeping the lock would block engineering forever).
4. **Discard.** Before a commit, `discardChanges` throws away the run's uncommitted changes (`git reset --hard HEAD` plus `git clean` of exactly the untracked paths of that diff, as literal pathspecs; ignored files are left alone), **only** when the tree still hashes to the develop `diffHash`, the diff is safe and the config is unchanged. If the user touched anything, nothing is discarded and cleanup sees a dirty tree.
5. **Branch keeping.** Switch back to `returnTo` and delete the task branch. `git branch -D` is used **only when the branch tip still equals `baseSha`**, that is, it holds no commit. Any commit (Synapse's, a user's, or one whose bookkeeping a crash lost) is deleted only when another local branch contains it; otherwise the branch is kept and the step output records `outcome: "branch_kept"`.
6. A dirty tree is left exactly as it is: `needs_attention` (`dirty_tree`) and the lock is kept; the user tidies up and cancels again. Otherwise the lock is released.

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
| `GET /api/engineering/lock` | `{held, taskId?, since?}` |

Step approvals are decided through the existing `/api/approvals/:id/approve|reject|revoke`. Errors are fixed codes only (`{error}`): `not_found` 404, `path_unavailable` 409, `ambiguous_repository`, `invalid_input`, `invalid_state`, `no_content`, `unknown_branch`, `unknown_environment`, `protected_branch`, `unsafe_test_command` and `registry_error:<code>` 400. Overview: `counts.engineeringAwaiting` and `engineeringLock {held, taskId?, taskTitle?, since?}`.

## Settings

| Key | Default | Notes |
|---|---|---|
| `engineering.model` | `sonnet` | `haiku`, `sonnet` or `opus`; both runs |
| `engineering.investigate.maxTurns` | 30 | 1 to 100; the request caps it at 50 |
| `engineering.develop.maxTurns` | 50 | 1 to 50 |
| `engineering.develop.timeoutMinutes` | 30 | 1 to 120 |
| `engineering.lock.ttlMinutes` | 10 | 1 to 120 |

The investigation timeout is fixed at 20 minutes. `repositories.test_command` stores the last confirmed test command per repository.

## Events and audit

- Events: `engineering.task_created {taskId}`, `engineering.task_status_changed {taskId, status}`, `engineering.step_changed {taskId, step, status}`, `engineering.lock_changed {held}`. Approval events are the core ones.
- Audit actions (ids, enums and counts only; never text, paths, branch names or diffs): `engineering.task_created`, `description_approved`, `investigated`, `investigate_failed`, `plan_approved`, `picked_up`, `preflight_failed`, `branch_created`, `developed`, `committed`, `parent_updated`, `merged_local`, `pushed`, `pushed_not_pr`, `completed`, `step_failed`, `revalidate_failed`, `step_rejected`, `cancelled`, `cleaned`, `cleanup_failed`, `cleanup_skipped`, `lock_acquired`, `lock_released`, `lock_recovered`.

## Reason codes

Shown to the user as fixed sentences (`apps/web/lib/engineering.ts` `reasonLabel`); unknown codes are never echoed.

- Route and task: `not_found`, `invalid_input`, `invalid_state`, `ambiguous_repository`, `repository_required`, `no_content`, `unknown_branch`, `unknown_environment`, `protected_branch`, `unsafe_test_command`, `path_unavailable`, `registry_error:<code>`.
- Step outcomes: `unsafe_change`, `no_changes`, `config_changed`, `parent_conflict`, `merge_conflict`, `pr_head_moved`, `branch_kept`, `pushed_not_pr`, `resume_unsafe`, `branch_changed`, `revalidate_failed`, `invalid_payload`, `unsupported_remote`, `state_changed`, `lock_held`, `max_turns`, `timeout`.
- Preflight: `not_a_repository`, `merge_in_progress`, `dirty_tree`, `missing_remote`, `upstream_push_enabled`, `parent_missing_origin`, `parent_missing_upstream`.
- `GitWorkflowError`: `git_failed`, `git_timeout`, `fetch_failed`, `push_failed`, `invalid_ref`, `branch_exists`, `branch_missing`, `diff_changed`, `nothing_to_commit`, `push_target_is_upstream`, `no_upstream_reference`, `branch_moved` (plus `missing_remote`, `dirty_tree`, `unsafe_change`, `protected_branch`, `config_changed` above).
- `PullRequestError`: `gh_not_found`, `gh_auth`, `pr_create_failed`, `pr_status_failed`, `pr_merge_failed`, `unsupported_remote`.
- Unsafe diff reasons (step output): `git_dir_changed`, `git_path`, `outside_repo`, `symlink_outside`, `not_a_file`, `unreadable`, `git_metadata_changed`.
- Step-result reasons that are **not yet labelled in the web**: `lock_lost`, `lock_held_by_other`, `step_running`, `not_terminal` (follow-up).
- Run error kinds from the orchestrator (`incomplete_ai_output`, `parse_failed`, `auth_failed` and so on) can appear in `failure` too.

## Differences from the spec

- **E11 and E8 use fetch plus merge, not `git pull`** (same steps; `pull.rebase` config cannot turn them into a rebase).
- **E5 amended** (two words for most runners, one Bash grant).
- **E6:** recovery looks at any lease at boot, not only an expired one, and resumes more cases (see the table).
- **E15:** `branch -D` only when the branch holds no commit; otherwise the containment rule and `branch_kept`. Uncommitted changes of a rejected or cancelled task are discarded (new `discardChanges`).
- **E10 and E13 say the user may edit the commit message, PR title and PR body. That is not built:** there is no route that updates an approval payload. The executors use the payload as requested.
- `approved` is unused; a failed investigation returns to `proposed`, not `failed`.
- `engineering.develop.maxTurns` default is 50, not 60 (the request schema caps a run at 50 turns).
- The auto-deploy notice at plan approval is rendered by the web from the registry; the server states it in the push and merge approval payloads.
- E19 `from-jira` and `from-slack` take an optional `repositoryId`.

## Deferred

See `docs/superpowers/plans/2026-11-06-phase-10-followups.md`: `code_answer` and ADR-036 session observation (Phase 10b), a sandbox for the develop run, non-GitHub hosts, overriding protected branches, multi-repo tasks, a repository picker for create-from-Jira/Slack, `include.path` fingerprinting, a history view with cleanup outcomes, editing the commit message and PR text, and the four unlabelled web reason codes.
