# Phase 10: Engineering Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn an approved task description into a merged PR, one task at a time. The model only edits files and runs the user-confirmed test command. Synapse performs every Git step itself, and each write step needs an approval.

**Architecture:**
- A hardened git runner and a `GitWorkflow` port, with a local-git adapter for preflight, branch, diff, commit, pull, merge, push and cleanup.
- A `PullRequestProvider` port, implemented by a `gh` adapter.
- An `engineering-tasks` module owning the state machine, lock manager, investigation and plan approval with branch confirmation.
- Step executors that sit behind the approval engine.
- A develop run whose writes are path-scoped and whose only Bash grant is the test command, enforced by validator rule L extended to writes.
- One web section and its Needs-you cards.

**Tech Stack:** Bun 1.4.4, TypeScript strict, Hono, bun:sqlite + Drizzle (generated migrations), Zod 4, Next.js 16, `bun test`.

**Spec:** `docs/superpowers/specs/2026-11-06-phase-10-engineering-automation.md` (E1–E21, plus pre-checks). ADR-030, ADR-035, ADR-032, ADR-013.

## Global Constraints

- **Placeholder data only.** Tests use temp git repos, with `origin` and `upstream` as local bare repos (`git init --bare`, `file://` URLs). The upstream push URL is set to `DISABLED`. Branches are `main`, `stage` and `prod`. `gh` is always faked; no test ever calls the real `gh` or pushes to a real remote.
- **Hard rules.**
  - The model never runs git, and Synapse never pushes to `upstream`.
  - A protected branch is never a push, merge or PR target.
  - Every Git write step goes through an approval. The plan approval covers `branch` and `develop`. `commit`, `merge_local`, `push_pr` and `merge_pr` each have their own approval.
  - Diff text, test output, Jira and Slack text, paths and URLs never appear in logs, audit rows, events or errors.
- **Dependencies:** no new dependency. One migration: `0017_engineering_tasks.sql`. Check that the latest migration is 0016 first.
- **Checks:** `bun run check` stays green. Web tasks also pass `bun run --cwd apps/web build`.

## Review Focus

1. **Command smuggling.** A test command containing `;`, `&&`, `|`, `$()`, a backtick, a newline or `>`, or one whose first word isn't in the allowlist, is refused at plan approval and by the validator. (Task 1/4)
2. **Writes outside the repo.** Any change under `.git/` or outside the realpath after the develop run fails the step (`unsafe_change`). (Task 5)
3. **Pushing to upstream or a protected branch.** Push and merge are refused when the target is the upstream URL or a protected environment branch. This is checked at approval request time and again at revalidate. (Task 2/5)
4. **Approval–state mismatch.** The tree changed after the commit approval was requested (the diff hash differs), or the task moved on. Revalidate fails and nothing is committed. (Task 5)
5. **Restart mid-task.** With an expired lease and a dirty tree, the task goes to `needs_attention` and the lease is kept. With a clean tree, the task resumes at its current step. (Task 4)

---

### Task 1: Schema, contracts, settings, approvals and validator rule L for writes

**Files:**
- Create `packages/contracts/src/engineering.ts`. It holds:
  - the task, step and status enums;
  - `InvestigationOutput` (E3) and `DevelopOutput` (E9);
  - the DTOs `EngineeringTaskView`, `EngineeringTaskDetail`, `PlanApprovalInput` and `LockView`;
  - `isSafeTestCommand(cmd)` (E5);
  - `taskBranchName(id, title)`, which returns `synapse/<first 8 of id>-<slug ≤32>`.
- Modify `packages/contracts/src/events.ts` to add `engineering.task_created`, `engineering.task_status_changed {taskId, status}`, `engineering.step_changed {taskId, step, status}` and `engineering.lock_changed {held}`. Mirror them in `apps/web/lib/live-events.ts`.
- Modify `packages/contracts/src/permissions.ts` to add the E18 actions and policies.
- Modify `packages/database/src/schema/platform.ts` with the E1 tables and `repositories.test_command` (nullable). Generate 0017.
- Modify `apps/api/src/core/config/settings.ts` to add:
  - `engineering.model` (default `sonnet`);
  - `engineering.investigate.maxTurns` (30);
  - `engineering.develop.maxTurns` (60);
  - `engineering.develop.timeoutMinutes` (30);
  - `engineering.lock.ttlMinutes` (10).
- Modify `apps/api/src/core/orchestrator/validator.ts` to extend rule L. For engineering runs:
  - `Edit`, `Write` and `MultiEdit` must equal `Tool(/<wd>/**)`;
  - `Bash` is allowed only as exactly `Bash(<cmd>:*)` with `isSafeTestCommand(cmd)`;
  - a bare `Bash`, or any other specifier, fails with `write tools must be scoped to the working directory`.

  `buildDenylist` already denies unallowed writes, so confirm it stays consistent.
- Tests:
  - validator cases;
  - the `isSafeTestCommand` table;
  - `taskBranchName`;
  - settings;
  - the migration test.

- [ ] **Step 1: Write the failing tests.**
  - `isSafeTestCommand` accepts:
    - `bun test`
    - `npm test`
    - `uv run pytest -q`
    - `make test`
    - `python -m pytest tests/unit`
  - It refuses:
    - `bun test; rm -rf x`
    - `bun test && x`
    - `bun test | tee`
    - `bun test $(x)`
    - `` bun test `x` ``
    - `bun test > f`
    - `curl x`
    - `rm -rf /`
    - an empty string
    - anything over 120 chars
    - anything containing a newline
  - Validator:
    - `Edit(//tmp/demo-repo/**)` is ok;
    - `Edit(/tmp/demo-repo/**)` fails;
    - `Bash(bun test:*)` is ok;
    - `Bash` fails;
    - `Bash(curl x:*)` fails;
    - `Bash(bun test; rm:*)` fails.
  - `taskBranchName("0123456789abcdef", "Fix: CSV import!!")` equals `"synapse/01234567-fix-csv-import"`.
- [ ] **Step 2: Run the tests.** Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `bun run check`.** Expect PASS.
- [ ] **Step 5: Commit** with message `feat(engineering): schema, contracts, approvals and rule L for scoped writes and test command`.

### Task 2: Hardened git runner and GitWorkflow adapter

**Files:**
- Modify `apps/api/src/integrations/repository/git.ts`, or create `git-runner.ts`, so that every call applies E17:
  - `-c core.fsmonitor=false -c core.hooksPath=/dev/null -c credential.interactive=never`;
  - the env `GIT_TERMINAL_PROMPT=0` and `GIT_OPTIONAL_LOCKS=0`;
  - timeouts of 60 s, or 120 s for push and fetch;
  - argv only.
- Create `apps/api/src/integrations/repository/git-workflow.ts`, `LocalGitWorkflow implements GitWorkflow`. Define the port in `packages/contracts/src/repository.ts`. Methods:
  - `preflight(repo, parent)` → `{ok} | {ok: false, reason}`, with reasons `dirty_tree`, `merge_in_progress`, `missing_remote`, `parent_missing_origin`, `parent_missing_upstream`, `upstream_push_enabled` (E7);
  - `currentBranch`;
  - `createTaskBranch(repo, parent, taskBranch)` → `{baseSha}` (E8);
  - `diffSummary(repo)` → `{files: [{path, added, removed}], hash, unsafe: boolean, diffText (≤200 KB)}`. Set `unsafe` when any path is under `.git/`, or resolves outside the realpath, or is a symlink pointing outside.
  - `commitAll(repo, message, expectedHash)` → `{sha}`. Refuse if the current diff hash differs from `expectedHash`.
  - `updateParent(repo, parent)` → `{ok} | {conflict: true}`, with abort on conflict (E11);
  - `mergeLocal(repo, parent, taskBranch)` → `{sha} | {conflict: true}` (E12);
  - `pushParent(repo, parent, {protectedBranches, upstreamUrl})` → `{ok}`. Refuse if `parent` is protected, or if the origin push URL equals the upstream URL (E13).
  - `commitsAhead(repo, parent)` → `[{sha, subject}]` (`origin/<parent>..<parent>`);
  - `cleanup(repo, taskBranch, returnTo, {force})` → `{ok} | {dirty: true}` (E15).
- Tests in `apps/api/test/integrations/git-workflow.test.ts`. Use temp repos with local bare `origin` and `upstream` remotes (`file://`); set the upstream push URL to `DISABLED`.

- [ ] **Step 1: Write the failing tests.** Cover:
  - preflight, one test per reason;
  - branch creation from the parent after fetch;
  - `diffSummary`:
    - counts additions and removals;
    - `unsafe` for a change in `.git/config`;
    - `unsafe` for a symlink to an outside file;
  - `commitAll`:
    - refuses when the hash changed after a new edit;
    - commits with the message and records the sha;
  - `updateParent`:
    - fast-forwards from both remotes;
    - on a conflicting upstream commit, reports the conflict and leaves no merge in progress;
  - `mergeLocal`:
    - `--no-ff`;
    - on conflict, aborts and reports the conflict;
  - `pushParent`:
    - pushes to the bare origin;
    - refuses a protected parent;
    - refuses when the origin push URL equals the upstream URL;
  - `cleanup`:
    - deletes a merged task branch and returns to the original branch;
    - with a dirty tree, returns `dirty` and leaves everything as it is;
  - every git invocation is argv only and includes the hardening flags (inject a spy runner).
- [ ] **Step 2: Run the tests.** Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `bun run check`.** Expect PASS.
- [ ] **Step 5: Commit** with message `feat(engineering): hardened git runner and git workflow adapter`.

### Task 3: PullRequestProvider and the gh adapter

**Files:**
- Define the port in contracts:
  - `createPr({upstream: {owner, repo}, headOwner, branch, title, body})` → `{url, number}`;
  - `prStatus({upstream, number})` → `{state, mergeable, checks: 'passing'|'failing'|'pending'|'none'}`;
  - `mergePr({upstream, number})` → `{merged: boolean, sha?}`.
- Create `apps/api/src/integrations/github/gh-cli.ts`, `GitHubCliProvider`. It runs the `gh` binary (path injectable) with argv only, `GH_PROMPT_DISABLED=1`, and a timeout of 60 s. It parses JSON from `gh pr view --json number,url,state,mergeable,statusCheckRollup` and parses the URL printed by `gh pr create`. Errors map to fixed codes: `gh_not_found`, `gh_auth`, `pr_create_failed`, `pr_merge_failed`, `unsupported_remote`.
- Create `parseGithubRemote(url)` → `{owner, repo} | null`. It handles `https://github.com/o/r(.git)` and `git@github.com:o/r(.git)`; any other host returns null.
- Tests use a fake `gh` script, a temp executable that records argv to a file and prints canned output.

- [ ] **Step 1: Write the failing tests.**
  - `parseGithubRemote` cases, including the credential-stripped https form and a non-GitHub host returning null.
  - `createPr` passes exactly `["pr","create","--repo","o/r","--head","fork:stage","--base","stage","--title",t,"--body",b]` and returns the URL and number.
  - `mergePr` passes `["pr","merge","N","--repo","o/r","--merge"]`.
  - `prStatus` maps the checks rollup.
  - A non-zero exit maps to a fixed code, and neither the error nor anything logged contains the title or body.
- [ ] **Step 2: Run the tests.** Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `bun run check`.** Expect PASS.
- [ ] **Step 5: Commit** with message `feat(engineering): pull request provider via gh`.

### Task 4: Engineering-tasks module — creation, investigation, plan approval and lock

**Files:**
- Create `apps/api/src/modules/engineering-tasks/`:
  - `store.ts`: task and step rows, plus status transitions with an allowed-transitions table;
  - `service.ts`, `EngineeringTaskService`, with:
    - `create(manual)`, `createFromJira(key)` (summary only), `createFromSlack(messageId)`;
    - `approveDescription(id, text)`, which enqueues `engineering.investigate`;
    - `approvePlan(id, input)` (E4/E5): validates the branch exists, refuses a protected environment, stores the test command per repo, and queues the task;
    - `cancel(id)`, `list` and `get`;
  - `lock.ts`, `EngineeringLock`, over the existing lease service:
    - `acquire(taskId)`, `renew()`, `release(taskId)`, `holder()`;
    - startup recovery per E6;
    - a 2-minute renew tick registered with the scheduler.
- Create `apps/api/src/intelligence/engineering/investigate-prompt.ts`. It builds the investigation request (E3: read-only scoped tools, `user_approved` description plus system parts) and parses `InvestigationOutput`. `filesLikelyTouched` is verified inside the repo, dropping invalid entries.
- Create `apps/api/src/workers/engineering/investigate.ts`, which runs a single attempt.
- Create `apps/api/src/workers/engineering/pickup.ts`. It runs every minute: if the lock is free and a task is `queued`, it acquires the lock, runs preflight (Task 2), sets the task to `in_progress`, and enqueues the branch step. A preflight failure sets the task to `needs_attention`, releases the lock, and records the fixed reason.
- Modify `apps/api/src/container.ts` to wire all of this.
- Tests: `apps/api/test/modules/engineering-tasks.test.ts` and `apps/api/test/workers/engineering-investigate.test.ts`.

- [ ] **Step 1: Write the failing tests.**
  - `createFromJira` copies only the summary into `draft_description` and marks `source: 'jira'`.
  - The investigation request contains no untrusted part; only the approved description is used, as `user_approved`.
  - The investigation stores the plan. Non-empty `unclear` leaves the task `planned` with the questions.
  - `approvePlan` refuses:
    - a protected environment (`protected_branch`);
    - an unknown branch;
    - an unsafe test command.
  - On success, the task is `queued` and the repo's `test_command` is stored.
  - Lock:
    - a second queued task waits while the lock is held;
    - the lock is renewed while the holder is active;
    - restart with an expired lease and a dirty repo sets the task to `needs_attention` and keeps the lease;
    - restart with a clean repo resumes the task.
  - Pickup with a failing preflight releases the lock and sets `needs_attention` with the reason.
- [ ] **Step 2: Run the tests.** Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `bun run check`.** Expect PASS.
- [ ] **Step 5: Commit** with message `feat(engineering): tasks, investigation, plan approval with branch confirmation, global lock`.

### Task 5: Develop run and approval-gated Git steps

**Files:**
- Create `apps/api/src/intelligence/engineering/develop-prompt.ts` (E9). Tools: `Read/Grep/Glob/Edit/Write/MultiEdit(//<repo>/**)` and `Bash(<testCommand>:*)`. Parts: system, plus the `user_approved` description and plan.
- Create `apps/api/src/workers/engineering/steps.ts`, a step runner that handles each step as follows:
  - `branch`: `createTaskBranch`.
  - `develop`: run, then `diffSummary`.
    - An unsafe diff fails the step with `unsafe_change`.
    - An empty diff fails it with `no_changes`.
    - `testsPassed` and `testOutputTail` come from the last non-error Bash tool_result whose input command starts with the test command. With none, `testsPassed` is false and the tail is null.
    - Then request the `engineering.commit` approval (E10). Its payload is `{taskId, diffHash, files, testsPassed, message}`; diff text is stored on the step output, not in the approval.
  - Approval executor `engineering.commit`: revalidate (E18), then `commitAll(expectedHash)`, then `update_parent` (E11), then request `engineering.merge_local` (E12).
  - Executor `engineering.merge_local`: `mergeLocal`, then request `engineering.push_pr` with the commits and PR title and body (E13).
  - Executor `engineering.push_pr`: `pushParent`, then `createPr`, then request `engineering.merge_pr` with `prStatus` (E14).
  - Executor `engineering.merge_pr`: `mergePr`, then `completed`, then cleanup, then release the lock.
  - Any conflict sets `needs_attention`, aborts, and keeps the lock (the user resolves it manually, then cancels or resumes).
  - A rejected step approval cancels the task (E16), runs cleanup, and releases the lock.
  - The auto-deploy flag of the parent environment is included in the `push_pr` and `merge_pr` approval payloads and in their risk level.
- Tests: `apps/api/test/workers/engineering-steps.test.ts`. Use temp repos with bare remotes, a fake `gh`, and a fake orchestrator whose develop run edits a file in the repo (simulated with a filesystem write) and returns tool results.

- [ ] **Step 1: Write the failing tests.**
  - **Happy path:** develop, commit approval, approve, commit, update, merge_local approval, approve, push_pr approval, approve, push (bare origin advanced) and PR created (fake gh argv), merge_pr approval, approve, merged, completed, cleanup, lock released.
  - **Rejection:** rejecting the commit approval leaves no commit, cancels the task, deletes the task branch, and releases the lock.
  - **Unsafe develop:** if the develop run writes `.git/hooks/x`, the result is `unsafe_change` and no commit approval is requested.
  - **Test result source:** `testsPassed` comes from the tool_result, not from the model's claim. In the test, the model output says passed but the Bash result shows a failing exit, so the result is `false`.
  - **Stale approval:** the diff changed after the commit approval was requested, so revalidate fails and nothing is committed.
  - **Protected parent:** a parent branch that became protected after plan approval makes `push_pr` revalidate fail.
  - **Conflicts:** an `update_parent` conflict sets `needs_attention` and keeps the lock.
  - **Auto-deploy:** an auto-deploy environment sets `merge_pr` risk to high, and the payload includes the deploy notice flag.
- [ ] **Step 2: Run the tests.** Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `bun run check`.** Expect PASS.
- [ ] **Step 5: Commit** with message `feat(engineering): scoped develop run and approval-gated commit, merge, push, PR and merge steps`.

### Task 6: API, overview and the end-to-end fake-binary flow

**Files:**
- Create `apps/api/src/routes/engineering.ts` (E19).
- Update the dashboard overview with `counts.engineeringAwaiting` and `engineeringLock` (`{held, taskTitle?}`).
- Tests:
  - `apps/api/test/routes/engineering.test.ts`.
  - `apps/api/test/integration/engineering-e2e.test.ts`. It runs through the real `ClaudeCliProvider` and orchestrator with a fake claude binary. For the investigate run, the fake emits a Read tool_use and the structured plan. For the develop run, the fake writes a file inside the repo (the fake binary has fs access to the cwd), emits Edit and Bash tool_uses with results, and asserts:
    - `--allowedTools` contains only the scoped specifiers and `Bash(<testCommand>:*)`;
    - `--permission-mode default` is present.

    Use bare remotes and a fake gh. Approvals are approved through the routes. Assert the final state is `completed` with the PR URL set.

- [ ] **Step 1: Write the failing tests.** Routes:
  - create, `from-jira` and `from-slack`, with 404 for an unknown key or message;
  - `approve-description`;
  - `approve-plan`, returning 400 with a code for protected, unknown-branch and unsafe-command cases;
  - `cancel`;
  - `lock`.

  Also cover the overview fields and the end-to-end flow.
- [ ] **Step 2: Run the tests.** Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `bun run check`.** Expect PASS.
- [ ] **Step 5: Commit** with message `feat(api): engineering routes, overview and end-to-end flow`.

### Task 7: Web Engineering section and approval cards

**Files:**
- Modify `apps/web/lib/api.ts` (engineering calls, with tests).
- Create:
  - `apps/web/app/components/engineering/EngineeringSection.tsx`;
  - `TaskTimeline.tsx`;
  - `NewTaskForm.tsx`;
  - `PlanApproval.tsx`, the branch confirmation form (environment select, parent branch select, test command input, remember-as-tracked checkbox, protected environments disabled, auto-deploy notice);
  - `DiffViewer.tsx` (per-file collapsible, plain text, with +/- counts);
  - triage cards for each E20 approval kind and for needs attention;
  - `apps/web/lib/engineering.ts`, with the step labels, the reason labels for every fixed code, and `isSafeTestCommand`, reused from contracts through the zod-free patterns subpath if needed;
  - `apps/web/app/styles/engineering.css`.
- Modify:
  - `lib/nav.ts`: add "Engineering" after Projects, with a badge of `engineeringAwaiting`;
  - `lib/needs-you.ts`: engineering approval cards rank high, after urgent items and sends;
  - the Jira row: add a "Create task" action;
  - inbox messages: add a "Create task" action;
  - the sidebar footer `eng lock` and the Running panel's "Engineering task" row, both fed from the overview;
  - `page.tsx`: wiring.
- Tests: `apps/web/test/engineering.test.ts` and `engineering-ui.test.tsx`.

- [ ] **Step 1: Write the failing tests.**
  - The plan approval form disables protected environments and shows the auto-deploy notice for `stage`.
  - The test command input shows an inline error for an unsafe command.
  - The diff viewer renders file sections as plain text.
  - The commit card shows the tests passed or failed status from the backend.
  - The merge PR card shows the red deploy banner when the payload flag is set.
  - The lock footer shows "free" or "busy · <title>".
  - The reason labels cover every code in the contracts list.
  - "Create task" from a Jira row calls `from-jira`.
- [ ] **Step 2: Run the tests.** Expect FAIL.
- [ ] **Step 3: Implement**, following the Phase 7 conventions.
- [ ] **Step 4: Run `bun run check` and `bun run --cwd apps/web build`.** Expect PASS.
- [ ] **Step 5: Commit** with message `feat(web): engineering section, plan approval with branch confirmation, diff and step approvals`.

### Task 8: Develop smoke, docs and follow-ups

**Files:**
- Create `scripts/dev/develop-smoke.ts`, with a unit-tested helper. It builds a throwaway repo with local bare `origin` and `upstream` remotes, a `bun test` test and a small bug. It runs the real investigate and develop runs (haiku) through the step runner, approves the commit and `merge_local` approvals programmatically, and stops before push (no gh). It prints counts and statuses only: `investigate: ok`, `develop: files=N testsPassed=…`, `commit: ok`, `merge_local: ok`, `unsafe: false`.
- Update docs:
  - a new `docs/modules/engineering-tasks.md`;
  - `claude-orchestrator.md`: rule L for writes and Bash, the git-by-Synapse principle, and the lock;
  - `security-model.md`;
  - `integration-contracts.md`: `GitWorkflow` and `PullRequestProvider`;
  - `database-design.md`: 0017;
  - ADR-030 and ADR-035: implementation notes;
  - `roadmap.md`: Phase 9 "Done (merged, PR #13)" and Phase 10 "PR open";
  - `CLAUDE.md`: the develop-smoke command line.
- Create `docs/superpowers/plans/2026-11-06-phase-10-followups.md`.

- [ ] **Step 1:** Write the helper test, then the script.
- [ ] **Step 2:** Update the docs.
- [ ] **Step 3:** Run `bun run check`.
- [ ] **Step 4: Commit** with message `feat(scripts): develop-smoke; docs: phase 10 as built`.
- [ ] **Step 5 (controller):** Run `develop-smoke` and record the result.
