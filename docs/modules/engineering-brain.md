# Engineering Brain

Covers the `engineering-brain` domain module (`apps/api/src/modules/engineering-brain`).

## Purpose

One central record of what the user builds: projects, their repositories, architecture, decisions, blockers, and especially **what is going live and when** (requirement 6). The application database owns approved Engineering Brain records. Claude recommends updates, and the user approves important ones.

## Responsibilities / Non-responsibilities

Responsibilities:

- Discover projects from registered repositories, documentation, Git history, Slack and Jira.
- Maintain project profiles, facts, decisions, milestones (go-live dates), dependencies and blockers.
- Generate knowledge recommendations with evidence; detect conflicting or outdated knowledge.
- Associate conversations and Jira issues with projects.
- Preserve knowledge history.

Non-responsibilities:

- Inventing missing information. Unknowns are marked `unknown` or `needs_review`.
- Modifying repositories (read-only access).
- Hard-coding project names. The categories in the concept (Sales Product, OD Product, Internal Tools, Personal Projects) are illustrative.

## Owned data (tables)

`repositories`, `repository_environments`, `projects`, `project_repositories`, `project_facts`, `project_decisions`, `project_milestones`, `project_dependencies`, `project_knowledge_recommendations`, `project_knowledge_evidence`.

Facts and decisions carry `status` (approved/needs_review/unknown/outdated), `source_refs`, `approved_at` and supersede links. Milestones carry name, target date, actual date, status, source and confidence.

## Repository registry (ADR-035)

The Engineering Brain owns the list of registered repositories. Only registered paths can be read or worked on. The registry is stored only in the database (`repositories`, `repository_environments`), entered and edited through the UI. There are no config or seed files.

| Field | Meaning |
|---|---|
| `name`, `local_path` | Registered path |
| `origin_url`, `upstream_url`, `upstream_push_disabled` | Detected from `git remote -v` |
| `tracked_branch` | Default parent branch for work in this repo |
| `notes` | User note |

**Deployment environments** (`repository_environments`): name → branch, plus notes. Example, `flexi-demo` (confirmed by the user 2026-11-05; illustrative only. Real values are stored in the database at registration, never in files):

| Environment | Branch |
|---|---|
| `stage` | `stage` |
| `prod` | `prod` |

Registration flow:

```text
user adds a path ─▶ Synapse detects: current branch, remotes (incl. disabled upstream push),
                    branches that look like environments (stage, staging, prod, production, main, develop)
                ─▶ proposal shown ─▶ user confirms/edits tracked branch + environments ─▶ saved (audited)
```

Drift check (daily, no AI): the checkout moved off `tracked_branch`, an environment's branch disappeared, or the remotes changed → notification. The registry is never updated automatically.

Milestones and go-live dates can reference an environment (for example, "go-live on `prod` 2026-12-01").

## Project profile

Purpose, current status, repositories, technical architecture, important modules, active features, known bugs, technical debt, dependencies, blockers, technical decisions, release milestones, go-live dates, relevant Jira issues, relevant Slack discussions.

## Ports used / provided

- `RepositoryProvider` (`repository/local-git`): `listRegistered`, `inspect`, `getHistory`. Registered paths only.
- `ClaudeOrchestrator`: intelligence profile for analysis of messages/issues; engineering profile (read-only tools) for repository inspection.
- Reads `inbox` and `jira-tracking` public services.
- Provides read APIs: project list/detail, upcoming go-lives, decisions timeline.

## Jobs

| Job type | Trigger | Profile / model | Idempotency key | Retry |
|---|---|---|---|---|
| `brain.discover_projects` | setup step 6 | engineering (read-only) / sonnet | `brain.discover:<repo set hash>` | 3 |
| `brain.inspect_repository` | new repo registered, or periodic (weekly) | engineering (read-only) / sonnet | `brain.inspect:<repoId>:<head sha>` | 3 |
| `brain.recommend_updates` | batch of new messages/issues/commits (default daily) | intelligence / haiku | `brain.update:<batch hash>` | 3 |
| `brain.associate` | `message.received`, `jira.issue_updated` (batched) | rules (repo/issue key/project keywords), AI only for ambiguous | `brain.assoc:<source ref>` | 3 |

Repository inspection runs with read tools only (`Read`, `Grep`, `Glob`, read-only `git log`/`git show`), no Edit/Write, and in a registered path.

## Events

Emitted: `project.discovered`, `project.knowledge_recommendation_created`, `project.knowledge_approved`.

Consumed: `message.received`, `jira.issue_updated`, `engineering.task_completed`, `approval.*`.

## Workflows

Initial discovery:

```text
registered repos → inspect docs, code, Git history
 + Claude Code's existing project understanding (as a hint, never as fact)
 + Slack/Jira context
 → candidate projects + facts (each with evidence, unknowns marked)
 → project.discovered → user review → approved records
```

Maintenance: detect new decisions, feature progress, new blockers, milestone changes, conflicts and outdated knowledge → `project_knowledge_recommendations` with evidence → review queue. Approved changes supersede old facts; history is kept.

Go-live tracking (requirement 6): milestones come from Slack ("we go live on the 20th"), Jira (fix versions, due dates) or user entry. Conflicting dates for the same milestone become a conflict recommendation, never a silent overwrite. Dashboard widget: upcoming releases.

## Permissions and approvals

Read repositories, analyze, recommend: allowed. Persist important knowledge (facts, decisions, milestones): approval required. Minor associations (message ↔ project links) may be stored without approval but are visible and reversible.

## Failure handling

- Unregistered path requested → denied, logged, never executed.
- Invalid AI output → retry; `NEEDS_ATTENTION` after max attempts.
- Conflicting information → recommendation with both sources, status `needs_review`.
- Expired source message → evidence keeps `source_external_ref`.

## Configuration

| Key | Default |
|---|---|
| `brain.repositories` | `[]` (explicit registration required) |
| `brain.inspect.schedule` | weekly |
| `brain.update.schedule` | daily |
| `brain.models.inspect` | `sonnet` |

## Tests

- Unknown information marked `unknown`, not invented.
- Conflicting go-live dates → conflict recommendation.
- Approval supersedes an old fact; history retained.
- Unregistered repository path → denied.
- Registration proposes tracked branch and environments from Git; nothing is saved until the user confirms.
- Drift (checkout on another branch, environment branch deleted) → notification only, registry unchanged.
- Inspection run has no write tools (permission denials recorded if attempted).
- Expired source → evidence still traceable.

## Open questions

- How Claude Code's "existing project understanding" is gathered (e.g. reading the user's CLAUDE.md files and memory) isn't specified. Treat it as a hint and confirm the method before Phase 8.
- Repository discovery: explicit registration is the default. Whether an approved auto-discovery scan of e.g. `~/projects` is wanted is open.

See `docs/product/open-questions.md`.
