# Engineering Brain

Covers the `engineering-brain` domain module (`apps/api/src/modules/engineering-brain`) as built in Phase 9. The design is in `docs/superpowers/specs/2026-11-06-phase-9-engineering-brain.md` (decisions C1 to C14). Anything not built is listed under "Deferred".

## Purpose

One central record of what the user builds: projects, their repositories, what Claude learned from reading them (reviewed by the user), and **what is going live and when** (requirement 6). The application database owns approved records. Claude recommends facts, and the user approves them.

## Responsibilities / Non-responsibilities

Responsibilities:

- Keep the repository registry (ADR-035) and detect drift from it.
- Keep projects (one per repository by default), reviewed facts and milestones.
- Run read-only, path-scoped repository inspections and turn the output into verified fact proposals.
- Associate Jira issues with a project through the repositories' Jira project keys.

Non-responsibilities:

- Inventing missing information. Unknowns are returned by the model but not stored; a fact needs verifiable evidence.
- Modifying repositories. The module never writes to a repository, and the inspection run has read-only, path-scoped tools.
- Hard-coding project names. `demo-app` in the ADRs is illustrative only.

## Owned data (tables, migration 0016)

| Table | Notes |
|---|---|
| `repositories` | `name` unique, `local_path` unique (realpath), `origin_url`, `upstream_url` (credential-stripped), `upstream_push_disabled`, `tracked_branch`, `jira_project_keys` (json), `notes`, `head_sha`, `inspected_head_sha`, `inspection_warning` (nullable, `"permission_denied"`), `drift` (json, nullable), timestamps |
| `repository_environments` | `name`, `branch`, `protected`, `auto_deploys_on_merge`, `notes`; unique (`repository_id`, `name`) |
| `projects` | `name` unique, `summary`, timestamps |
| `project_repositories` | project to repository link, unique pair |
| `project_facts` | `kind` (purpose, stack, module, entrypoint, convention, risk, note), `content`, `evidence` (json `{path, line?}[]`), `status` (needs_review, approved, rejected, outdated), `source` (inspection, user), `claude_run_id`, `supersedes_id`, `head_sha`, `decided_at` |
| `project_milestones` | `name`, `target_date` (YYYY-MM-DD), `environment_id`, `status` (planned, done, slipped, cancelled), `notes` |

## Repository registry (ADR-035, C2 to C4)

`RepositoryRegistry` (`registry.ts`) owns the registry. It lives only in the database and changes only through user-driven calls. There are no config or seed files.

Registration is two calls:

1. `POST /api/repos/inspect {path}` (`propose`) saves nothing. It runs the path rules and returns a proposal: the realpath, a suggested name (the basename), the current branch (also the suggested tracked branch), head sha, credential-stripped remote URLs, whether upstream push is disabled, all branch names and environment candidates.
2. `POST /api/repos {path, name, trackedBranch, environments[], jiraProjectKeys[], notes?}` (`register`) re-checks the path, re-inspects, requires `trackedBranch` and every environment branch to exist as a local or remote branch, then saves the repository, its environments and a **project with the same name**, linked to it, in one transaction. The transaction re-checks the name, the path and nesting against the stored realpaths, because another registration may have landed while git ran (final review). It audits `repo.registered` and publishes the `repo.registered` event, whose consumer enqueues the first inspection.

Other calls: `PUT /api/repos/:id` (every field optional; `environments` replaces the set, matched by name so kept environments keep their id; changed branches are re-checked; audited as `repo.updated` with field names only), `DELETE /api/repos/:id` (`repo.unregistered`; the project and its facts stay; refused with 409 `repo_has_active_task` while an engineering task of the repository is not `completed`, `failed` or `cancelled`, because deleting the row would cascade the task away while it may hold the lock or a branch) and `POST /api/repos/:id/accept-remotes` (below). Audit rows and events carry ids only: never paths, remote URLs or branch names.

### Path rules (C2)

`checkRegistrablePath` (`integrations/repository/path-rules.ts`) runs these checks in order and the first failure wins:

| Reason | Check |
|---|---|
| `not_absolute` | the path starts with `/` |
| `not_found` / `not_directory` | it exists and is a directory |
| `forbidden_location` | the realpath is `/`, `$HOME` **or any ancestor of `$HOME`** (a scope there would cover the whole home), or inside `~/.claude`, `~/.ssh` or `~/.config`. Both `$HOME` as given and its realpath are used, and the realpath of the candidate is judged, so symlinks cannot sneak in |
| `unsafe_chars` | `isSafeAbsolutePath` holds for both the input and the realpath |
| `not_git_root` | `git rev-parse --show-toplevel` equals the realpath |
| `already_registered` | the realpath is not registered |
| `nested` | it is not inside, and does not contain, a registered path |

`isSafeAbsolutePath` (`packages/contracts/src/brain.ts`) is the shared predicate for any path embedded in a `Tool(/<path>/**)` specifier (the CLI's `//abs/path/**` form). It requires the pattern `^/[A-Za-z0-9._/-]+$` (no spaces, commas, parentheses or quotes), no empty, `.` or `..` segment (so no `//` or `a/../..`), and at least two segments, so neither `/` nor a top-level directory like `/tmp` can be a scope. One trailing slash is tolerated. The registry, the inspection `prepare` step and validator rule L all use it. The realpath is what gets stored.

### Provider (C3)

`LocalGitProvider` (`integrations/repository/local-git.ts`) implements the `RepositoryProvider` port (`checkPath`, `inspect`). It runs git through the hardened runner `integrations/repository/git.ts` (Phase 10 E17): argv spawns (no shell, `-C <dir>`, `cwd /`), `-c core.fsmonitor=false -c core.hooksPath=/dev/null -c credential.interactive=never`, no prompts, no optional locks, a minimal env (PATH, HOME, plus SSH_AUTH_SOCK, XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS when set), a 60 s timeout (120 s for push, fetch, pull and ls-remote), stderr discarded. `inspect` returns the top level, current branch, head sha, remotes, `upstreamPushDisabled` (push URL `no_push`, `DISABLED` or empty), and local and remote branches. Remote URLs have userinfo stripped before they are stored or returned. `environmentCandidates` is pure and picks branch names matching stage, staging, prod, production, main, master, develop, dev or release.

### Environment flags

Each environment records `protected` and `auto_deploys_on_merge`. **Phase 9 only records and shows them** (chips in the UI: `stage` shows "auto-deploys", `prod` shows "protected"). Nothing enforces them yet. They exist for Phase 10: `protected` means Synapse must never write to that branch, and `auto_deploys_on_merge` means a merge there ships, which the branch confirmation and merge steps must warn about. See the ADR-035 implementation note.

### Drift check (C5)

`brain.drift_check` runs daily (scheduler, coalesced), without AI, and reads git only. For each repository `computeDrift` compares git with the registered values. The stored `repositories.drift` has these shapes (all optional, plus `detectedAt`):

| Field | Meaning |
|---|---|
| `offTrackedBranch` | the checkout is on another branch (`HEAD` when detached) |
| `missingEnvironmentBranches` | environment branches gone from both local and remote, sorted |
| `remotesChanged` | the origin or upstream fetch URL, or the upstream push-disabled state, changed |
| `pathMissing` | the path is gone or no longer a git work tree |

A git failure that is not a missing path leaves the stored drift alone. **Notify once:** a drift's identity is everything except `detectedAt`, with `offTrackedBranch` counted as a boolean (final review). The branch name is for display only: moving from one feature branch to another is the same drift, stays quiet, and only updates the stored name. Only a new identity writes `drift`, raises one in-app and desktop notification (kind `repo.drift`, title only: "Repository drift: <name>") and publishes `repo.drift_detected`. The same drift on later runs is quiet; a resolved drift is cleared without a notification. One repository failing never stops the others.

The check never updates the registry. The one way the stored remotes change is the user's explicit **accept remotes** (`POST /api/repos/:id/accept-remotes`, audited `repo.remotes_accepted`). It stores the current credential-stripped URLs and push state, then re-evaluates the drift without notifying: `remotesChanged` clears, parts git no longer shows clear too, and parts that remain keep their `detectedAt`. Findings that are new since the stored drift are not added there; the next drift check records them and notifies, so accepting remotes can never swallow a notification.

## Inspection (C6, C7, C9)

`brain.inspect_repository` runs one **read-only, path-scoped** Claude run per repository (`workers/brain/inspect.ts`, `InspectionService` in `inspection.ts`, prompt in `intelligence/brain/inspect-prompt.ts`).

Triggers: registration (the `repo.registered` consumer), the "Inspect now" button (`POST /api/repos/:id/inspect`: 202 with a job id, 409 `already_queued` while one is queued or running; when the stored head was already inspected a fresh idempotency key forces a run), and `brain.inspect_weekly` (weekly, coalesced), which reads each repository's HEAD, stores it as `head_sha`, and enqueues an inspection when it differs from `inspected_head_sha` and none is live. A repository whose drift says `pathMissing` is skipped. Idempotency key: `brain.inspect:<repoId>:<headSha or none>`.

### Request shape

| Part | Value |
|---|---|
| Profile | `engineering` |
| Model | setting `brain.inspect.model` (`haiku`, `sonnet` or `opus`; default `sonnet`) |
| Working directory | the repository realpath, re-verified before the run (`prepare`: the path must still be safe, resolve to itself and be a git top level, else the job returns `skipped: path_unavailable`) |
| Allowed tools | `Read(/<root>/**)`, `Grep(/<root>/**)`, `Glob(/<root>/**)` and nothing else. `<root>` starts with `/`, so each is the CLI's double-slash absolute form, for example `Read(//home/u/app/**)` |
| Expected tools | `Read`, `Grep`, `Glob` (`expectedToolNames`): a run with no successful result from one of them fails as `incomplete_ai_output` (ADR-026) |
| Prompt parts | `system` only: the instructions and the repository name and root. No untrusted content; the run reads the repository itself |
| Output | a fenced json block `{facts: [{kind, content, evidence: [{path, line?}]}], unknowns: []}` |
| Priority class | `batch` |

**Rule L (validator).** For `engineering` runs, `workingDirectory` must satisfy `isSafeAbsolutePath`, and every allowed `Read`, `Grep` or `Glob` must be exactly `Tool(/<workingDirectory>/**)` (double slash). A bare `Read`, or the single-slash form, fails with `fs read tools must be scoped to the working directory`. Details in `docs/modules/claude-orchestrator.md`.

*Amendment (final review).* Rule L and the inspection first used the single-slash form `Read(<root>/**)`. On the real CLI that form is not absolute (it resolved against the cwd) and granted nothing; the inspection could read only because the cwd was the repository. The controller verified the double-slash form with the cwd elsewhere: inside reads allowed, outside reads denied, nothing leaked.

**Repository configuration and hermetic runs.** `--setting-sources user` keeps the inspected repository's `CLAUDE.md`, `.claude/settings.json` and `.mcp.json` out of the run, and every run sets `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. Every run also passes `--permission-mode default`.

**User-permission guard.** The CLI merges the user's `~/.claude/settings.json` permissions into every run, and the override cannot remove them, so a user-level `permissions.allow` for `Read`, `Bash`, `Edit` and similar would defeat the path scope. The orchestrator therefore refuses every engineering run, before spawning, when the startup read of the user's settings found such an entry, additional directories, or a default mode of `bypassPermissions`, `acceptEdits` or `auto`. The inspection job then fails with a fixed `needs_attention` message. Details in the orchestrator doc and the security model.

**Single attempt.** The job is enqueued with `maxAttempts: 1`: an inspection is an expensive run and a retry rarely fixes it. A run that stops on max turns or timeout is audited (`brain.inspect_failed`, repository id and kind only) and ends `needs_attention`. `inspection_warning` (the view's `inspectionWarning`) is set to `permission_denied` when a recorded inspection had permission denials and cleared by the next recorded inspection without any; a failed run leaves it as it was. The repository card shows "The last inspection was refused some file reads; results may be incomplete." while it is set. A run with no successful `Read`, `Grep` or `Glob` result (the provider's `expectedToolNames` check, and the worker checks again) is audited the same way with kind `incomplete_ai_output` and fails as `incomplete_ai_output`, storing nothing (ADR-026). A reply that does not parse ends `parse_failed`. The user can press "Inspect now".

**Turn budget.** `brain.inspect.maxTurns` (default 30, up to 100) is clamped to 50 in the request, which is the CLI cap, and the system part tells the model its turn budget so it batches reads and answers before running out. `brain.inspect.timeoutMinutes` (default 10, up to 60) is the run timeout; the job handler allows 65 minutes so the worker never times out first.

### Evidence verification (`evidence.ts`)

`verifyFacts` runs on the model's facts exactly as written, before anything is cut. A fact survives only if all of these hold. The first failing check names the drop reason (a fact counts once):

| Drop reason | Meaning |
|---|---|
| `too_much_evidence` | more than 5 evidence entries |
| `unsafe_path` | a path is absolute, empty, longer than 500 characters, starts with `~`, holds a NUL byte or has a `..` segment |
| `sensitive_path` | a path names `.git` internals, `.env*`, `*.pem`/`*.key`/`*.p12`/`*.pfx`/`*.kdbx`, `id_rsa`, `id_dsa`, `id_ed25519`, `id_ecdsa` (and `.pub`), `credentials` or `credentials.json`, `secrets.*`, `.npmrc`, `.netrc`, `.pgpass` or `.git-credentials`; also when the resolved target of a harmless name is one of these |
| `missing` | the path does not resolve (realpath) |
| `outside_repo` | the realpath is not strictly inside the repository root (this covers symlinks that point out) |
| `not_file` | the target is not a regular file |
| `not_read` | the run never observed the path (ADR-026). Observed means the `file_path` of a successful `Read` (absolute under the root, or relative to it, after normalisation), or a whole path, absolute or relative, named in the content of a successful `Grep` or `Glob` result. Built from raw tool results only, never the reply |
| `content_secret` / `content_internal_url` | the content fails the secret or internal-URL checks. Tokens naming an existing repository path (optionally with `:line`) are masked first, so a long module path is not mistaken for a secret |
| `too_long` | the content is over 400 characters. It is dropped, never truncated |

Kept evidence paths are normalised (`./a//b` becomes `a/b`). At most 40 facts are kept. Dropped counts are stored in the audit row (`brain.inspected`: proposed, inserted, duplicates, unknowns, dropped by reason, tool names of any permission denials). Fact text is never logged. The model's `unknowns` are counted, not stored.

### Dedupe, review and supersede (C9)

Surviving facts are inserted as `needs_review` (source `inspection`, with the claude run id and head sha), skipping any whose kind and **normalised content** (lowercase, punctuation stripped, whitespace collapsed) equal an approved, rejected or pending fact of the same project. `inspected_head_sha` is set, and `brain.facts_proposed` is published when anything was inserted. Everything runs in one transaction that first re-checks that the repository is still registered and linked to the project (otherwise nothing is written). A re-inspection never changes approved facts.

`BrainService` (`service.ts`) owns review:

- **Accept** (`POST /api/brain/facts/:id/accept`, optional edited content of 1 to 400 characters) sets `approved`. An approved fact of the same project, kind and normalised content becomes `outdated`, and the new fact's `supersedes_id` points at it.
- **Reject** sets `rejected`. A decided fact cannot be decided again (409 `invalid_state`).
- **Add** (`POST /api/projects/:id/facts`) creates a `user` fact, approved at once, with the same supersede rule.
- `brain.fact_decided` and the audit row carry ids and the status only, never fact text.

## Projects, milestones and Jira (C10, C11)

- **Projects.** One per repository by default (created at registration). `PUT /api/projects/:id {name?, summary?}` renames or edits (audited with field names only). `GET /api/projects/:id` returns the repositories, facts, milestones and the Jira summary.
- **Milestones.** CRUD under `/api/projects/:id/milestones` (name up to 120 characters, `targetDate` as YYYY-MM-DD, status default `planned`, optional environment and notes). An environment must belong to a repository of the same project (400 `invalid_environment`). All changes are audited by id.
- **Upcoming.** `GET /api/brain/upcoming` lists `planned` milestones due within `brain.upcoming.days` (default 30) or already past, by date then name, with the project and environment name. A past `planned` milestone has `overdue: true`. "Today" and the horizon are local calendar dates (`localDate` in `@synapse/shared`, shared with the Jira attention rules; final review), not UTC ones. The overview gains `counts.brainReview` (facts needing review) and `upcoming` (the next three).
- **Jira association (C11).** A project's issues are in-scope `jira_issues` with an attention whose `project_key` is in the union of its repositories' `jira_project_keys`. The detail has counts by attention (overdue, blocked, due_soon, stale) and the five most urgent issues. No new table. It is gated on `jira.enabled`: while Jira is off the detail's `jira` is `null` and the card shows no Jira section.

## Web (C13)

A "Projects" section after Jira (`apps/web/app/components/brain`): the repository list with branch, environment chips, a drift warning with "Accept remotes", "Inspect now", an inspection warning (denied file reads), and "Remove" (an inline confirm, then `DELETE /api/repos/:id`; a refusal such as `repo_has_active_task` shows its fixed message in a toast; files on disk are not touched), the register flow (path, proposal, confirm form), and project cards with approved facts grouped by kind, pending facts with Accept, Edit and Reject, milestones (the edit form sets planned, done, slipped or cancelled; Delete asks for an inline confirmation), and the Jira summary. Jira keys in the register form use `JIRA_PROJECT_KEY_RE` from `@synapse/contracts/patterns`, the same rule as the API schema. Needs-you cards: "PROJECTS · REVIEW" (facts needing review) and "PROJECTS · SETUP" (no repository registered). Upcoming go-lives appear in the Running panel. The frontend holds no business logic. Fact text is shown as plain text.

## Routes

| Method and path | Purpose |
|---|---|
| `GET /api/repos`, `GET /api/repos/:id` | list, detail |
| `POST /api/repos/inspect` | proposal (saves nothing) |
| `POST /api/repos` | register (201) |
| `PUT /api/repos/:id`, `DELETE /api/repos/:id` | edit, unregister (204) |
| `POST /api/repos/:id/accept-remotes` | accept the current remotes |
| `POST /api/repos/:id/inspect` | "Inspect now" (202, or 409 `already_queued`) |
| `GET /api/projects`, `GET /api/projects/:id`, `PUT /api/projects/:id` | projects |
| `POST /api/projects/:id/facts` | add a user fact |
| `POST /api/brain/facts/:id/accept`, `POST /api/brain/facts/:id/reject` | review |
| `GET/POST /api/projects/:id/milestones`, `PUT/DELETE /api/projects/:id/milestones/:mid` | milestones |
| `GET /api/brain/upcoming` | upcoming go-lives |

**Errors are fixed codes only**, never paths, URLs, branch names or fact text. 400: `invalid_input`, `invalid_environment`, `unknown_tracked_branch`, `unknown_environment_branch`, `duplicate_environment`, and the path reasons (`not_absolute`, `not_found` for a missing path on register or inspect, `not_directory`, `not_git_root`, `unsafe_chars`, `forbidden_location`, `nested`). 409: `already_registered`, `duplicate_name`, `path_unavailable`, `invalid_state`, `already_queued`. 404: an unknown id.

## Settings

| Key | Default |
|---|---|
| `brain.inspect.model` | `sonnet` (`haiku`, `sonnet`, `opus`) |
| `brain.inspect.maxTurns` | 30 (1 to 100; clamped to 50 in the request) |
| `brain.inspect.timeoutMinutes` | 10 (1 to 60) |
| `brain.upcoming.days` | 30 |

The weekly and daily schedules are fixed at registration of the jobs (7 days, 1 day), not settings.

## Jobs

| Job type | Trigger | Notes |
|---|---|---|
| `brain.drift_check` | daily | no AI, read-only git, 10 min handler timeout |
| `brain.inspect_weekly` | weekly | refreshes `head_sha`, enqueues inspections for moved heads |
| `brain.inspect_repository` | registration, "Inspect now", weekly check | engineering profile, `maxAttempts` 1, 65 min handler timeout |

## Events

Emitted: `repo.registered`, `repo.drift_detected`, `brain.facts_proposed` (project id and count), `brain.fact_decided` (fact id and status). Consumed: `repo.registered` (the first inspection). Payloads carry ids and counts only. The earlier plan's `project.*` events were not built.

## Permissions and approvals

Reading registered repositories and proposing facts is allowed. Facts are kept only after the user accepts them, and the user's own facts and milestones are stored at once as the user's decisions. A registered path is the only thing Claude can read, and only through rule L's scope. Nothing here writes to a repository, Slack or Jira.

## Failure handling

- Unregistered or vanished repository: the inspection job returns `skipped`, and nothing is written.
- Invalid AI output: `parse_failed`, one attempt, content-free reason. A single bad fact is dropped alone by verification.
- Max turns or timeout: audited, `needs_attention`, no retry.
- Unsafe user settings: engineering runs refused before spawning.
- Drift: notification only, registry unchanged.

## Tests

Unit and integration tests cover the path rules, the provider (against real throwaway git repos), registration and its failure paths, the drift shapes and notify-once, evidence verification and every drop reason, dedupe and supersede, milestones and upcoming, the Jira summary, the routes, and rule L with the user-permission guard. Nothing in the suite runs a real `claude`. Two controller-run smoke scripts exercise the real CLI: `scripts/dev/scope-smoke.ts` (path scoping) and `scripts/dev/inspect-smoke.ts` (one inspection of a throwaway repo). `scope-smoke` runs at provider level with the cwd in a third temp dir and a single-slash negative control. Results are recorded in `docs/superpowers/plans/2026-11-06-phase-9-followups.md`.

## Deferred

Recorded in `docs/superpowers/plans/2026-11-06-phase-9-followups.md`:

- `code_answer` for away mode (Phase 10, needs its own security design).
- AI extraction of milestones from Slack or Jira, and conflict recommendations for go-live dates.
- Slack-to-project association.
- Reading the user's CLAUDE.md and memory as hints.
- Repository auto-discovery (explicit registration is the only path).
- Project decisions, dependencies, blockers and knowledge recommendations tables from the original design.
- A repository remove button in the UI.
- Surfacing permission denials of an inspection run.

## Open questions

See `docs/product/open-questions.md`.
