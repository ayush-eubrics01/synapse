# Phase 9: Engineering Brain — Design

**Authority:** `docs/modules/engineering-brain.md`, ADR-016 (central Engineering Brain), ADR-035 (repository registry; the registry lives only in the DB and is entered through the UI), ADR-030, ADR-032 and ADR-026. The user's repository details (paths, branches, deploy rules) are entered into their local DB after merge and never committed.

## Scope

This phase delivers:

- the repository registry, with registration (proposal, then confirm), environments with branch policies, and a drift check;
- projects, with one per repository by default and renaming;
- **read-only repository inspection** by Claude. It produces fact recommendations backed by evidence, and the user reviews them;
- milestones and go-live dates, entered by the user;
- Jira association through each repository's Jira project keys;
- an API and a "Projects" dashboard section with Needs-you cards.

**Deferred** (recorded in follow-ups):

- `code_answer` for away mode (Phase 10). It mixes untrusted Slack text with code read access and needs its own security design.
- Extracting milestones from Slack or Jira with AI.
- Slack-to-project association.
- Reading the user's CLAUDE.md and memory as hints.
- Auto-discovery of repositories.

## Decisions

| # | Decision | Why |
|---|---|---|
| C1 | **Tables (migration 0016).** `repositories`: `id`, `name` (unique), `local_path` (unique, realpath), `origin_url?`, `upstream_url?`, `upstream_push_disabled`, `tracked_branch`, `jira_project_keys` (json string[]), `notes?`, `head_sha?`, `inspected_head_sha?`, `created_at`, `updated_at`. `repository_environments`: `id`, `repository_id`, `name`, `branch`, `protected` (bool: Synapse must never write to it, enforced in Phase 10), `auto_deploys_on_merge` (bool), `notes?`, unique (`repository_id`, `name`). `projects`: `id`, `name` (unique), `summary?`, `created_at`, `updated_at`. `project_repositories` (`project_id`, `repository_id`, unique pair). `project_facts`: `id`, `project_id`, `kind` ('purpose'\|'stack'\|'module'\|'entrypoint'\|'convention'\|'risk'\|'note'), `content`, `evidence` (json `{path, line?}[]`), `status` ('needs_review'\|'approved'\|'rejected'\|'outdated'), `source` ('inspection'\|'user'), `claude_run_id?`, `supersedes_id?`, `head_sha?`, `created_at`, `decided_at?`. `project_milestones`: `id`, `project_id`, `name`, `target_date` (YYYY-MM-DD), `environment_id?`, `status` ('planned'\|'done'\|'slipped'\|'cancelled'), `notes?`, timestamps | The module doc's tables, trimmed to what this phase uses |
| C2 | **Path rules.** A registered path must be absolute, exist, be a directory, and be the top level of a git work tree (`git rev-parse --show-toplevel` equals its realpath). It is stored as the realpath. It must match `^/[A-Za-z0-9._/-]+$` (no spaces, commas, parentheses or quotes, because it is embedded in tool permission specifiers). It must not be inside `~/.claude`, `~/.ssh` or `~/.config`, and must not be `/` or `$HOME` itself. Registering a path that is already registered, or nested inside or around a registered path, is refused | ADR-035: only registered paths may be touched |
| C3 | **`RepositoryProvider` (`integrations/repository/local-git.ts`)** runs git with `execFile` and no shell, with a 10 s timeout. `inspect(path)` returns `{ topLevel, currentBranch, headSha, remotes: { origin?: {fetch, push}, upstream?: {fetch, push} }, upstreamPushDisabled, localBranches[], remoteBranches[] }`. `upstreamPushDisabled` is true when the upstream push URL is `no_push`, `DISABLED` or empty. `environmentCandidates(branches)` is a pure function that picks names matching `stage|staging|prod|production|main|master|develop|dev|release`. Remote URLs have userinfo stripped (`https://user:token@host` becomes `https://host`) before they are stored or returned | Read-only, deterministic. No tokens in the DB |
| C4 | **Registration** is two calls. `POST /api/repos/inspect {path}` returns a proposal and saves nothing: path checks, detected remotes, current branch, suggested tracked branch (the current branch), environment candidates and a suggested name (the basename). `POST /api/repos {path, name, trackedBranch, environments[{name, branch, protected, autoDeploysOnMerge, notes?}], jiraProjectKeys[], notes?}` re-inspects and saves in one transaction. It requires `trackedBranch` and every environment branch to exist as local or remote branches. It creates a project with the same name, linked to the repo, and audits `repo.registered` (ids only). Edits via `PUT /api/repos/:id` are audited. `DELETE /api/repos/:id` unregisters (the project stays) | ADR-035 flow |
| C5 | **Drift check** (`brain.drift_check`, daily, no AI). It flags: the checkout is no longer on `tracked_branch`; an environment branch has gone from both local and remote; the origin or upstream URLs changed; the path is gone. Each new drift raises one desktop notification and an in-app notification (title only: "Repository drift: <repo name>"), and is stored as `repositories.drift` (json, nullable). It never updates the registry | ADR-035 |
| C6 | **Inspection run (`brain.inspect_repository`).** Profile `engineering`, model setting `brain.inspect.model` (default `sonnet`), `workingDirectory` = the repo realpath, `maxTurns` 30, timeout 10 min. Tools are **path-scoped**: `Read(<repo>/**)`, `Grep(<repo>/**)`, `Glob(<repo>/**)`, and nothing else. Prompt parts are `system` only: instructions and the repo name. No untrusted content: the run reads the repo itself. The structured output is `{ facts: [{ kind, content (≤400 chars), evidence: [{path, line?}] (1..5) }] (≤40), unknowns: string[] (≤10) }`, Zod-validated. Code then: drops facts whose evidence paths don't resolve (realpath) to an existing file inside the repo; drops facts whose content fails `contentCheck` secret or internal-URL checks; truncates. It is triggered on registration, by a manual "Inspect now", and weekly when `head_sha` has changed since `inspected_head_sha`. Idempotency key: `brain.inspect:<repoId>:<headSha>` | Read-only inspection with verifiable evidence. Path scoping keeps reads inside the repo |
| C7 | **Validator rule L (path scoping).** For `engineering` runs, every allowed `Read`/`Grep`/`Glob` must carry a specifier, and the specifier must equal `<workingDirectory>/**` exactly. `workingDirectory` must be an absolute path matching C2's regex. A bare `Read` in an engineering run fails `fs read tools must be scoped to the working directory`. (Phase 10 extends this rule for write tools.) | Retires I4 for engineering. Closes reading outside the repo |
| C8 | **Proving path scoping on the real CLI.** A controller-run `scripts/dev/scope-smoke.ts` runs one engineering run with `Read(<tmpdir>/**)` scoped to a temp dir. Its instructions are to read a file in the temp dir, then a file outside it (a second temp file). It passes when the inside read returns content and the outside read is denied (a permission denial or error tool_result). It prints counts only | As with the send guard, we prove the CLI honours the scoping |
| C9 | **Review.** Inspection facts arrive as `needs_review`. `POST /api/brain/facts/:id/accept` (with optional edited content) sets `approved`, marks any approved fact with the same kind and normalised content `outdated` via `supersedes_id`, and audits. `POST …/reject` sets `rejected`. Users can add facts (`source: 'user'`, approved at once). A re-inspection never changes approved facts. It only proposes new ones, skipping proposals whose normalised content equals an existing approved or rejected fact of the same kind | ADR-016: approved knowledge belongs to the user |
| C10 | **Milestones.** CRUD through `/api/projects/:id/milestones`. `GET /api/brain/upcoming` lists planned milestones within `brain.upcoming.days` (default 30), sorted by date, with the environment name. A milestone whose target date is past and still `planned` shows as "overdue" | Requirement 6: what goes live and when |
| C11 | **Jira association.** A project's issues are in-scope `jira_issues` whose `project_key` is in the union of its repositories' `jira_project_keys`. The project detail includes counts by attention and the top 5 attention issues | No new table |
| C12 | **API.** `GET /api/repos`, `POST /api/repos/inspect`, `POST /api/repos`, `PUT /api/repos/:id`, `DELETE /api/repos/:id`, `POST /api/repos/:id/inspect` (enqueue, 409 while one is queued), `GET /api/projects`, `GET /api/projects/:id`, `PUT /api/projects/:id {name?, summary?}`, `POST /api/projects/:id/facts`, `POST /api/brain/facts/:id/accept\|reject`, the milestone routes, `GET /api/brain/upcoming`. The overview gains `counts.brainReview` (facts needing review) and `upcoming` (the next 3 milestones) | — |
| C13 | **Web.** A "Projects" nav section after Jira, containing: a repository list with branch, environment chips (`stage` → `stage` · auto-deploys, `prod` → `prod` · protected), a drift warning and "Inspect now"; a register-repository flow (path input → proposal → confirm form with tracked branch select, environment rows with protected and auto-deploy toggles, Jira keys, notes); project cards (name, summary, approved facts grouped by kind, pending facts with Accept/Edit/Reject, milestones with add and edit, Jira attention summary). Needs-you cards: "PROJECTS · REVIEW" (facts needing review, up to 5) and "PROJECTS · SETUP" ("Register a repository") when none exist. Upcoming go-lives appear in the Running panel or a small card | Phase 7 design language |
| C14 | **Untrusted content.** Repo file content reaches only the read-only inspection run. Fact text is model output about repo content. It is shown as plain text, stored locally, never sent anywhere and never logged | ADR-032 |

## Out of scope

- Writes to repositories.
- Engineering tasks (Phase 10).
- `code_answer`.
- AI extraction of milestones.
- Slack-to-project links.

## Pre-check (controller, 2026-11-06)

A real-CLI run with `allowedTools: ["Read(<tmp>/inside/**)"]` was given two reads. The read inside the scoped directory returned content. The read outside it was an error tool_result with `permissionDenials: ["Read"]`, and no outside content was returned. Path scoping holds, so C7 and C8 rest on observed behaviour.
