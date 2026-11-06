# ADR-030: One Engineering Task at a Time and a Fixed Git Workflow
- **Status:** Accepted
- **Date:** 2026-11-05
- **Source:** User decision; concept.md §10.5, §10.6

## Context
Every engineering task creates a local branch, updates the parent branch from `origin` and `upstream`, merges locally, raises a PR and merges it. Two tasks in flight at once would collide on the parent branch, the merge and the PR.

## Decision
**Serialization.** Only one engineering task is active at a time, across all repositories. A single global engineering lease (`leases.name = 'engineering'`) is held from task pickup until the PR is merged, or until the task is cancelled, rejected or failed and its local branch is cleaned up. Waiting for an approval does not release the lock. Other engineering tasks stay PENDING in priority order. Intelligence and collector jobs are unaffected. On restart, an expired lease is not released automatically if the repository has uncommitted changes or a merge in progress; the task becomes NEEDS_ATTENTION.

**Workflow** (each step recorded in `engineering_task_steps`):
0. Confirm the parent branch with the user (ADR-035): from the environment, else the repository's `tracked_branch`.
1. Create a local task branch from the confirmed parent branch.
2. Develop and test on the task branch.
3. Update the parent branch: `git pull origin <parent-branch> && git pull upstream <parent-branch>`.
4. Merge the task branch locally into the parent branch.
5. Push the updated local parent branch to `origin` (the user's fork), then open a PR from `origin/<parent-branch>` into `upstream/<parent-branch>`.
6. Merge the PR.

Before starting, verify a clean working tree and that the `origin` and `upstream` remotes exist. Any merge conflict in step 3 or 4 stops the task as NEEDS_ATTENTION; conflicts are never resolved automatically without approval. The approvals in ADR-013 still apply to code changes, commit, push, PR and merge.

**User decision:** Synapse does not need to isolate itself from the user's own working checkout. Concurrent work by the user and Synapse in the same repository is not a design concern.

## Consequences
- Positive: no collisions between Synapse tasks; simple, auditable sequence.
- Negative: throughput is one task at a time; a task stuck awaiting approval blocks the queue.
- PR source and target confirmed by the user (resolves OQ-3): the parent branch is pushed to `origin`, and the PR goes from `origin/<parent>` into `upstream/<parent>`. The push/PR approval shows the commits being pushed and the PR title and body.

## Implementation note (Phase 10)

Built as decided, with these as-built details. Module doc: [engineering-tasks.md](../../modules/engineering-tasks.md).

- **Git is Synapse's, not the model's.** The only Claude runs are the read-only investigation and one develop run (edit files and run the confirmed test command). Branch, commit, parent update, local merge, push, PR and PR merge are `GitWorkflow` and `gh` calls (argv, hardened runner), each approval-gated and revalidated.
- **Step 3 is fetch plus merge, not `git pull`** (explicit refspecs, `--ff-only`, then a merge commit), so `pull.rebase` configuration cannot turn it into a rebase. A conflict is aborted and sets `needs_attention` (`parent_conflict` or `merge_conflict`); it is never auto-resolved, and merges carry `-c branch.<parent>.mergeOptions= -c rerere.enabled=false`.
- **The lock.** Lease `engineering`, holder `task:<id>`, TTL 10 minutes (`engineering.lock.ttlMinutes`), renewed every 2 minutes while the task is `in_progress` or `awaiting_approval`. **An existing lease row always means held, even when expired**; only startup recovery decides. Recovery runs at boot after the port is bound, for any lease (a quick restart is a crash too): a dirty tree, a merge in progress or an unsafe diff sets `needs_attention` and keeps the lease; a clean task resumes, or has an idempotent step re-driven. It is released after `completed`, `cancelled` or `failed` plus cleanup; a dirty tree at cleanup keeps it (`needs_attention`).
- **Cleanup keeps branches with commits.** `git branch -D` only while the task branch tip still equals the recorded `base_sha`; otherwise the branch is deleted only if another local branch contains it, else kept (`branch_kept`). Uncommitted develop changes are discarded only when they still hash to what the user saw.
- **Approvals are pinned to SHAs.** `merge_local` merges the approved task-branch tip, `push_pr` pushes exactly the approved merge commit, `merge_pr` uses `--match-head-commit` (`branch_moved`, `pr_head_moved`).
- **A cancel after `merge_local` leaves the local merge commit on the parent branch, unpushed.** Synapse never rewinds a user's branch. A cancel during the push leaves the push in place and creates no PR (`pushed_not_pr`).

## Related
- [ADR-035](ADR-035-repository-branch-registry.md), [ADR-013](ADR-013-manual-approval-for-external-writes.md), [ADR-032](ADR-032-untrusted-content-isolation.md), [ADR-008](ADR-008-database-backed-job-processing.md)
- [claude-orchestrator.md](../../modules/claude-orchestrator.md), [workflows.md](../../product/workflows.md), [open-questions.md](../../product/open-questions.md)
