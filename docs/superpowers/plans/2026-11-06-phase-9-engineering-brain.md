# Phase 9: Engineering Brain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A repository registry with branch policies and drift checks. Projects with read-only, evidence-backed Claude inspection that the user reviews. Milestones and go-lives. Jira association. A Projects dashboard section.

**Architecture:**
- **Git access:** a local-git `RepositoryProvider` (execFile, no shell).
- **Domain:** an `engineering-brain` module owns the tables, registration, review and milestones.
- **Inspection:** one path-scoped, read-only `engineering` run per repository. Validator rule L enforces that `Read`, `Grep` and `Glob` are scoped to the working directory. A real-CLI smoke proves the scoping.
- **UI:** one new web section plus Needs-you cards.

**Tech Stack:** Bun 1.4.4, TypeScript strict, Hono, bun:sqlite + Drizzle (generated migrations), Zod 4, Next.js 16, `bun test`.

**Spec:** `docs/superpowers/specs/2026-11-06-phase-9-engineering-brain.md` (C1–C14). Module design: `docs/modules/engineering-brain.md`. ADR-035.

## Global Constraints

- **Placeholder data only.** No real repository names, paths, branches, remotes or org names anywhere in the repo. Tests create temporary git repos with `git init` in a temp dir, with branches `main`, `stage`, `prod` and `feature-x`, a fake remote `https://example.com/demo/app.git`, and an upstream with push `no_push`.
- **CLAUDE.md hard rules.** Only the orchestrator runs Claude. Untrusted content never reaches a run that can act, and the inspection run has no write tools. Repo text, fact text and file paths stay out of logs, audit rows, events and errors (ids and repo names only).
- **No Bash in inspection.** Git commands run only in the provider (execFile, no shell, timeout).
- **No new dependency.** One new migration: `0016_engineering_brain.sql`. Check that the latest is 0015 first.
- **Checks stay green.** `bun run check` must pass, and web tasks must also pass `bun run --cwd apps/web build`.

## Review Focus

1. **Path traversal.** Evidence paths like `../../.ssh/id_rsa`, symlinks pointing outside the repo, or absolute paths outside it are dropped. Test in Task 4.
2. **Registering dangerous paths.** `$HOME`, `/`, `~/.claude`, a path with spaces, a non-git dir, a subdirectory of a repo, and a path nested in a registered repo are each refused. Test in Task 2.
3. **Validator rule L.** A bare `Read`, `Read(/other/**)`, or a specifier not equal to `<wd>/**` in an engineering run fails. Collector and intelligence runs are unaffected. Test in Task 1.
4. **Remote URLs with credentials** are stripped before storage. Test in Task 2.
5. **Re-inspection never touches approved facts** and doesn't re-propose rejected ones. Test in Task 4.

---

### Task 1: Schema, contracts, settings and validator rule L

**Files:**
- Create: `packages/contracts/src/brain.ts`. It holds the DTOs and zod schemas:
  - `RepositoryProposal`, `RepositoryView`, `EnvironmentInput`;
  - `ProjectView`, `ProjectDetail`, `ProjectFactView`;
  - `MilestoneView`, `MilestoneInput`;
  - `InspectionOutput` (the C6 output schema, with its limits);
  - the `FactKind`, `FactStatus` and `MilestoneStatus` enums.
- Modify: `packages/contracts/src/events.ts`. Add `repo.registered {repositoryId}`, `repo.drift_detected {repositoryId}`, `brain.facts_proposed {projectId, count}` and `brain.fact_decided {factId, status}`. Mirror them in `apps/web/lib/live-events.ts`.
- Modify: `packages/database/src/schema/platform.ts`. Add the C1 tables, plus a nullable json `repositories.drift`. Generate `0016_engineering_brain.sql`.
- Modify: `apps/api/src/core/config/settings.ts`. Add:
  - `brain.inspect.model` (enum `haiku|sonnet|opus`, default `sonnet`);
  - `brain.inspect.maxTurns` (30);
  - `brain.inspect.timeoutMinutes` (10);
  - `brain.upcoming.days` (30).
- Modify: `apps/api/src/core/orchestrator/validator.ts` (rule L, per C7) and its header comment.
- Test: the validator rule-L cases, the settings defaults, and the migration applying on a fresh DB.

- [ ] **Step 1: Write the failing tests.**
  - Validator, for engineering runs with `workingDirectory` `/tmp/demo-repo`:
    - `["Read(/tmp/demo-repo/**)","Grep(/tmp/demo-repo/**)","Glob(/tmp/demo-repo/**)"]` → ok;
    - `["Read"]` → `fail("fs read tools must be scoped to the working directory")`;
    - `["Read(/tmp/other/**)"]` → fails;
    - `["Read(/tmp/demo-repo/*)"]` → fails;
    - a `workingDirectory` containing a space → fails;
    - an intelligence run with no fs tools → unaffected.
  - Settings defaults read back as specified.
  - The migration applies.
- [ ] **Step 2: Run them.** Expect FAIL.
- [ ] **Step 3: Implement.** Check how `workingDirectory` reaches the validator. Add it to the validator's input if it is missing, and keep the existing rule order.
- [ ] **Step 4: Run** `bun run check`. Expect PASS.
- [ ] **Step 5: Commit:** `feat(brain): schema, contracts, settings and validator rule L (scoped fs reads)`.

### Task 2: Local-git provider and the repository registry

**Files:**
- Create:
  - `apps/api/src/integrations/repository/local-git.ts`: `LocalGitProvider.inspect(path)`, `environmentCandidates` and `stripCredentials` (C3);
  - `apps/api/src/integrations/repository/path-rules.ts`: `checkRegistrablePath(path, home, registeredPaths)` → `{ ok: true, realpath } | { ok: false, reason }`, with reasons `not_absolute`, `not_found`, `not_directory`, `not_git_root`, `unsafe_chars`, `forbidden_location`, `already_registered` and `nested` (C2);
  - `apps/api/src/modules/engineering-brain/registry.ts`: `RepositoryRegistry` with `propose(path)`, `register(input)`, `update(id, patch)`, `unregister(id)`, `list()` and `get(id)` (C4). The provider is injected through a port, and modules never import integrations.
  - `apps/api/src/workers/brain/drift.ts`: `brain.drift_check`, daily (C5).
- Modify: `apps/api/src/container.ts` (wiring and scheduling) and `packages/contracts` (a `RepositoryProvider` port).
- Test:
  - `apps/api/test/integrations/local-git.test.ts`, using real temp git repos;
  - `apps/api/test/modules/brain-registry.test.ts`;
  - `apps/api/test/workers/brain-drift.test.ts`.

- [ ] **Step 1: Write the failing tests.**
  - `inspect` on a temp repo:
    - reports the current branch and HEAD sha;
    - returns local branches, plus remote branches after `git update-ref refs/remotes/origin/prod HEAD`;
    - returns origin and upstream, with `upstreamPushDisabled` true when the upstream push URL is `no_push`.
  - `stripCredentials("https://user:tok@example.com/a.git")` returns `"https://example.com/a.git"`.
  - `environmentCandidates` finds `stage` and `prod` but not `feature-x`.
  - Path rules refuse each case listed in Review Focus 2. A symlink to a repo is stored as its realpath.
  - `register`:
    - rejects a `trackedBranch` that doesn't exist;
    - rejects an environment branch that doesn't exist;
    - saves the repo, its environments and a project in one transaction;
    - writes an audit row containing ids only.
  - `propose` saves nothing.
  - Drift:
    - checking out another branch → drift stored, one notification, and the registry unchanged;
    - deleting an environment branch → drift;
    - running drift again → no duplicate notification;
    - fixing the problem → drift cleared.
- [ ] **Step 2: Run them.** Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun run check`. Expect PASS.
- [ ] **Step 5: Commit:** `feat(brain): local-git provider, path rules, repository registry and drift check`.

### Task 3: Inspection run and evidence verification

**Files:**
- Create:
  - `apps/api/src/intelligence/brain/inspect-prompt.ts`: `buildInspectRequest(repo, jobId)` (C6). Its parts are `system` only. The instructions name the exact output JSON, require evidence paths relative to the repo root, say "don't read secrets, .env files or credentials; mark unknowns instead of guessing", and ask for at most 40 facts.
  - `apps/api/src/modules/engineering-brain/evidence.ts`: `verifyFacts(repoRoot, facts)`. It keeps facts whose every evidence path resolves (realpath) to an existing regular file inside `repoRoot`, drops the rest, and drops facts failing `contentCheck` `content_secret` or `content_internal_url`. It returns `{ kept, dropped: Record<reason, number> }`.
  - `apps/api/src/workers/brain/inspect.ts`: `brain.inspect_repository`. It runs through `orchestrator.runStructured` (or `run` plus parse, matching how other intelligence workers do it), verifies, inserts `needs_review` facts (C9 dedupe), sets `inspected_head_sha`, and publishes `brain.facts_proposed`. Weekly schedule (C6); enqueued on register.
- Test:
  - `apps/api/test/modules/brain-evidence.test.ts`, using a temp repo with files and a symlink pointing outside;
  - `apps/api/test/workers/brain-inspect.test.ts`, with a fake orchestrator.

- [ ] **Step 1: Write the failing tests.**
  - The built request has:
    - profile `engineering` and `workingDirectory` equal to the repo realpath;
    - allowed tools exactly the three scoped `Read`/`Grep`/`Glob` specifiers;
    - no untrusted parts;
    - a model taken from settings.
  - `verifyFacts` drops each of these: `../../etc/passwd`, an absolute `/etc/hosts`, a symlink whose target is outside, a missing file, and content containing an AKIA key or `http://localhost:3000`. It keeps valid facts.
  - The worker:
    - inserts facts as `needs_review`;
    - re-running at the same head is idempotent;
    - re-inspecting at a new head doesn't change approved facts and doesn't re-propose rejected or approved equivalents;
    - on invalid output, inserts nothing and fails as `parse_failed`.
- [ ] **Step 2: Run them.** Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun run check`. Expect PASS.
- [ ] **Step 5: Commit:** `feat(brain): path-scoped read-only inspection with verified evidence`.

### Task 4: Projects, review, milestones, Jira association and API

**Files:**
- Create:
  - `apps/api/src/modules/engineering-brain/service.ts`: `BrainService` with `listProjects()`, `getProject(id)` (C11 Jira summary included), `updateProject`, `addFact`, `acceptFact(id, editedContent?)`, `rejectFact(id)`, the milestone CRUD, `upcoming()`, and `requestInspection(repoId)`.
  - `apps/api/src/routes/brain.ts` (C12), registered in `app.ts`.
- Modify: `apps/api/src/modules/dashboard/service.ts` and the contracts, adding `counts.brainReview` and `upcoming`.
- Test:
  - `apps/api/test/modules/brain-service.test.ts`;
  - `apps/api/test/routes/brain.test.ts`;
  - `apps/api/test/integration/brain-inspect-e2e.test.ts`. It uses a fake binary through the real provider and orchestrator. The fake asserts `--allowedTools` contains only the scoped tools and that `cwd` is the repo. It emits the structured output, and facts are stored after verification.

- [ ] **Step 1: Write the failing tests.**
  - accept → `approved`, and the older approved equivalent becomes `outdated` with `supersedes_id` set.
  - accept with edited content stores the edit.
  - reject → `rejected`.
  - A user-added fact is `approved` immediately.
  - Milestones: create with an environment of the same project's repo (an environment from another project gives 400), update, and an overdue flag in `upcoming`.
  - Project Jira summary counts only in-scope issues whose project key matches.
  - `POST /api/repos/inspect` returns the proposal for a temp repo and 400 with `reason` for a bad path.
  - `POST /api/repos` → 201.
  - `POST /api/repos/:id/inspect` → 202, then 409 while queued.
  - Overview counts.
  - E2E.
- [ ] **Step 2: Run them.** Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun run check`. Expect PASS.
- [ ] **Step 5: Commit:** `feat(brain): projects, fact review, milestones, jira association and API`.

### Task 5: Web Projects section

**Files:**
- Modify: `apps/web/lib/api.ts` (all the brain calls, with tests).
- Create:
  - `apps/web/app/components/brain/ProjectsSection.tsx`;
  - `apps/web/app/components/brain/RegisterRepository.tsx` (the proposal-then-confirm form);
  - `apps/web/app/components/brain/ProjectCard.tsx`;
  - `apps/web/app/components/triage/BrainReviewCard.tsx`;
  - `apps/web/app/components/triage/BrainSetupCard.tsx`;
  - `apps/web/lib/brain.ts` (pure helpers: fact grouping, env chip labels, the milestone status label "Overdue" or "In N days", and `driftLabel`);
  - `apps/web/app/styles/brain.css`.
- Modify:
  - `lib/nav.ts`: add "Projects" after Jira, with a badge of `brainReview`.
  - `lib/needs-you.ts`: add the `brain-review` card kind, ranked after `jira-attention`, and `setup-brain` with the setup cards.
  - `page.tsx`: the wiring and `refresh()`.
  - Palette entries: "Register a repository", plus one per project.
  - An "Upcoming" list (next 3 milestones) in the Running panel.
- Test: `apps/web/test/brain.test.ts` and `apps/web/test/brain-ui.test.tsx`.

- [ ] **Step 1: Write the failing tests.**
  - Helpers.
  - The register flow renders the proposal fields: the tracked branch select is prefilled, and environment rows are prefilled from candidates with protected and auto-deploy toggles.
  - A bad-path error is shown inline, using the reason label.
  - The project card shows approved facts grouped, pending facts with Accept/Edit/Reject, and milestones.
  - The review card lists up to 5 facts.
  - The setup card appears when no repos exist.
  - The nav badge.
  - Environment chips read "stage → stage · auto-deploys on merge" and "prod → prod · protected".
- [ ] **Step 2: Run them.** Expect FAIL.
- [ ] **Step 3: Implement.** Follow the Phase 7 conventions.
- [ ] **Step 4: Run** `bun run check` and `bun run --cwd apps/web build`. Expect PASS.
- [ ] **Step 5: Commit:** `feat(web): projects section, repository registration and fact review`.

### Task 6: Scope smoke, docs and follow-ups

**Files:**
- Create: `scripts/dev/scope-smoke.ts` (C8), with a pure-classifier unit test, and add a CLAUDE.md Commands line.
- Create: `scripts/dev/inspect-smoke.ts`. It runs one real inspection on a temp copy of a small throwaway git repo created by the script itself, with 3 tiny files and model `haiku`. It prints counts only: facts proposed and facts dropped by reason.
- Modify:
  - `docs/modules/engineering-brain.md`: as built.
  - ADR-035: an implementation note covering the environment `protected` and `auto_deploys_on_merge` flags.
  - `docs/modules/claude-orchestrator.md`: rule L.
  - `docs/architecture/security-model.md`: path-scoped reads.
  - `docs/product/roadmap.md`: Phase 8 "Done (merged, PR #12)", Phase 9 "PR open".
- Create: `docs/superpowers/plans/2026-11-06-phase-9-followups.md` (deferred items, plus "Real-CLI smoke: TBD").

- [ ] **Step 1:** Write the helper tests, then the scripts.
- [ ] **Step 2:** Update the docs.
- [ ] **Step 3:** Run `bun run check`.
- [ ] **Step 4: Commit:** `feat(scripts): scope-smoke and inspect-smoke; docs: phase 9 as built`.
- [ ] **Step 5 (controller):** Run both smokes and record the results.
