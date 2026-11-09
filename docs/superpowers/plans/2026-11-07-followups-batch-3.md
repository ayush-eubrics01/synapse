# Follow-ups Batch 3: Attention Gaps, Settings Reach, Robustness and Boundaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the open follow-ups that need no product decision:
- three attention gaps (unverified sends in the briefing, choosing a Jira site, visible inspection denials);
- away-reply limits the user can only tighten;
- four robustness fixes (linger timeout, scheduler isolation, a PASSIVE checkpoint, a sharper "Back up now" 409);
- three small web fixes;
- one index migration, plus bounded and gated reads;
- three boundary and hygiene fixes.

**Architecture:**
- **K5 + K1.3 storage:** one generated migration, `0023_followups_batch_3`. It adds 33 indexes (every unindexed foreign-key column, plus `jira_issues.jira_id`) and one nullable column, `repositories.inspection_warning`.
- **K1:**
  - The dashboard count reuses the feed's rule (`resolveActions`).
  - The Jira resolver stores the candidate sites, parsed from its own raw tool result, in an internal setting. `PUT /api/jira/settings` accepts `cloudId`, checked against that list.
  - Inspection writes `inspection_warning` in the transaction that records the result.
- **K2:** the five `autoReply.*` schemas get stricter-only ranges and join `USER_EDITABLE_SETTINGS`. A new "Away replies" card edits them through the existing `PUT /api/settings`.
- **K3:**
  - `runCommand` moves to `infrastructure/run-command.ts` and gains `timeoutMs`.
  - `SchedulerService.tick` wraps each task.
  - Retention checkpoints `PASSIVE`.
  - `backupJobLive` gets the manual-or-running rule.
- **K4:**
  - The repository card gets Remove.
  - `RuntimeView.endpoints` feeds the sidebar footer.
  - `classifyOverviewFailure` narrows "unreachable" to `TypeError`.
- **K6:**
  - `autoSentOutgoingIds` is the auto-reply read port, injected into the inbox.
  - The approval engine stores only `executorErrorCode(e)`.
  - `configFingerprint` follows `include.path` / `includeIf.*.path`.
- No AI runs, no external writes, no new npm dependency.

**Tech Stack:** Bun 1.4.4 (`bun:sqlite`, `Bun.spawn`), TypeScript strict, Hono, Drizzle + drizzle-kit, Zod 4, Next.js (`renderToString` tests), `bun test`.

**Spec:** `docs/superpowers/specs/2026-11-07-followups-batch-3.md` (K1.1–K1.3, K2.1, K3.1–K3.4, K4.1–K4.3, K5.1–K5.3, K6.1–K6.3). It is binding, together with ADR-033, ADR-018, ADR-026, `docs/architecture/module-boundaries.md`, the module docs of each area touched, and the follow-ups files of phases 1, 4, 5, 6b, 7, 8, 9, 10 and 11.

## Plan decisions (spec gaps)

1. **K1.1 "matching the feed".** The feed shows an outgoing card only when `resolveActions(status, failure)` (`modules/outgoing/urgent-reply.ts`) is non-empty, or the status is `needs_attention`. So `outgoingAttention` counts `status = 'needs_attention'` plus `status = 'sent_unverified' and failure = 'unverified'` (verification exhausted). A `sent_unverified` row still being verified (`failure` null) has no card, so it is not counted. The briefing already renders `counts.outgoingAttention`, and no other badge reads it.
2. **K1.2 storage and route.**
   - Today the resolver (`workers/jira/resolve-cloud-id.ts`) stores nothing when it parks; it only records `lastError`. `source.resolveCloudId` already returns `{ id, url, name }[]` parsed by `parseResources` from the single raw `getAccessibleAtlassianResources` tool result, so it satisfies ADR-026.
   - Smallest safe change: an internal setting `jira.cloudIdCandidates` holding `{ id, name }[]`. It is not in `USER_EDITABLE_SETTINGS` and is written with `emit: false`.
     - On `multiple_sites` it holds the sites whose id passes `^[0-9a-fA-F-]{8,64}$`, at most 20, with names clipped to 200 characters.
     - On `no_sites` and on a stored single site it becomes `[]`.
   - The choice goes through `PUT /api/jira/settings` (new key `cloudId`), not the generic `/api/settings`, because it must check the list, clear the parked state and queue a sync in one transaction.
   - With a non-empty list, an id not in it gets 400 `{ error: "unknown_site" }`. With an empty list, the setting's own regex is the only check.
   - The change is audited as module `jira`, action `settings.updated`, `details: { keys: ["jira.cloudId"] }`. Site names are never audited or logged.
   - Changing an already-set cloudId to a different one counts as a scope change: the checkpoint is reset, both generations are renewed and a fresh reconcile is queued.
   - **UI placement.** The Jira setup card only shows while Jira is off, but candidates exist only after enabling. So the site select lives in the Jira section, under the `multiple_sites` error line.
3. **K1.3 storage.** The warning is a column (`repositories.inspection_warning`, text, nullable) in the batch's single migration, not derived from the audit log, so it survives audit retention. `InspectionService.record` sets it to `"permission_denied"` when `permissionDenials` is non-empty, else `null`, in the same update as `inspectedHeadSha`. A failed or stopped inspection leaves it unchanged.
4. **K2.1 ranges.** ADR-033 states only defaults (`maxPerPersonPerDay` 3, `minMinutesBetweenInThread` 30, `minConfidence` 0.75, all four kinds), and `docs/modules/auto-reply.md` adds `maxSendDelayMinutes` 15. "Never looser" makes each default the loosest allowed value:

   | Key | Schema |
   |---|---|
   | `autoReply.allowedKinds` | any subset of the four kinds, no duplicates (empty allowed), default all four |
   | `autoReply.maxPerPersonPerDay` | integer 0–3, default 3 |
   | `autoReply.minMinutesBetweenInThread` | integer 30–1440, default 30 |
   | `autoReply.minConfidence` | number 0.75–1, default 0.75 |
   | `autoReply.maxSendDelayMinutes` | integer 1–15, default 15 |

   - The tighter ranges replace the schemas in `settingSchemas`, so `settings.set` and `PUT /api/settings` share one rule. Nothing has ever written these four numeric keys (no route or UI existed; only tests write `allowedKinds`), so no stored value can fall outside the new ranges.
   - **0 through `AutoReplyPolicy`:** `sentToRecipientLast24h >= maxPerDay` is `0 >= 0`, so every send holds as `daily_cap`. That is the kill switch.
   - **Exception kept from ADR-033's deviations:** a `code_answer` review (`reviewOnly`, auto-send off) is not an auto-send, and `daily_cap` must not block it. `AutoReplyService` therefore passes `maxPerDay: Number.POSITIVE_INFINITY` when `reviewOnly`, where today 0 < 3 already never blocks it.
5. **K3.1.**
   - `runCommand(cmd, { timeoutMs })` kills the process with SIGKILL at the deadline and rejects with `CommandTimeoutError`.
   - `lingerCheck` passes `{ timeoutMs: 3_000 }` and maps that error to `{ status: "degraded", detail: "timeout" }`.
   - `readVersion` is unchanged (no timeout).
6. **K3.2.**
   - "Capped" means clamped. `upsert` stores `min(intervalSeconds, 604_800)`, so a huge value never crashes startup. Non-positive and non-integer values still throw.
   - A throwing task logs `scheduler: task failed name=<name> error=<Error.name>` once. Its `nextRunAt` is then pushed to now + 60 s in a separate best-effort update, so a permanently failing task logs at most once a minute instead of every 5-second tick.
7. **K3.4 manual vs scheduled.**
   - Manual jobs are enqueued by `POST /api/system/backups` with `input: { manual: true }` (key `ops.backup.manual:<id>`).
   - Scheduled jobs come from the `ops.backup` schedule with `input` null (key `sched:ops.backup:<nextRunAt>`).
   - The rule: `type = 'ops.backup' and ((status in PENDING/RETRY/RUNNING and json_extract(input, '$.manual') = 1) or status = 'RUNNING')`.
   - The web function is `startBackup` (the follow-up called it `triggerBackup`). Only its comment changes.
8. **K4.2 source.**
   - No endpoint exposes the ports today. `RuntimeView` gains `endpoints: { api: { host: string; port: number }; web: { host: string; port: number } }`, taken from `AppConfig.api` / `AppConfig.web`.
   - `web.port` is `SYNAPSE_WEB_PORT` (default 7401), the API's own view of the dashboard port. It matches `apps/web/package.json`'s `-p 7401` unless the user overrides both.
   - The footer shows `host:port` for the API (`[::1]:7400` for an IPv6 host) and `:port` for the web. It omits both while the runtime view is unavailable.
9. **K4.3.** Following the phase-7 note: `ApiError` maps to `http`, `TypeError` (what `fetch` throws when unreachable) maps to `network`, and anything else maps to the new `{ kind: "unexpected" }`. A malformed 200 body throws `SyntaxError` from `res.json()`, so it lands in `unexpected`. `request()` is unchanged.
10. **K5.1 index list.** It was enumerated from a fresh database migrated to 0022. `job_attempts.job_id` is already indexed by 0022, so the triage was stale there. The FK columns that are not the leading column of any index or primary key:
    - `audit_events.approval_id`;
    - `auth_snapshots.claude_run_id`, `quota_snapshots.claude_run_id`;
    - `job_attempts.claude_run_id`;
    - `module_dependencies.depends_on`;
    - `slack_attachments.message_id`, `slack_message_references.message_id`, `slack_messages.sender_user_id`;
    - `message_drafts.claude_run_id`;
    - `security_flags.claude_run_id`, `security_flags.person_id`;
    - `people_profile_evidence.message_id`;
    - `people_profile_recommendations.claude_run_id`, `people_profile_recommendations.approval_id`;
    - `people_profile_versions.approval_id`, `people_profile_versions.recommendation_id`;
    - `commitment_sources.claude_run_id`, `commitment_sources.message_id`;
    - `commitment_updates.commitment_id`;
    - `followup_history.followup_id`;
    - `followups.claude_run_id`, `followups.approval_id`, `followups.origin_message_id`, `followups.commitment_id`;
    - `outgoing_messages.claude_run_id`;
    - `auto_replies.session_id`;
    - `project_milestones.environment_id`, `project_repositories.repository_id`;
    - `engineering_tasks.environment_id`;
    - `claude_session_prs.session_id`;
    - `code_answers.auto_reply_id`, `code_answers.repository_id`.

    That is 32 columns, plus `jira_issues.jira_id`. Each index is named `<table>_<column>_idx` and declared in `packages/database/src/schema/platform.ts`.
    - **Generating the migration:** run `bunx --bun drizzle-kit generate --name followups_batch_3` from `packages/database`, after confirming the latest file is `0022_retention_fk_indexes.sql`. Commit the SQL, snapshot and journal as generated, and never edit an applied migration.
    - The new test is the authority: if it finds a column this list missed (or one that is covered), follow the test.
11. **K5.2 window.**
    - `skipStale` scans `sentAt >= cutoff − 7 days and sentAt < cutoff` (`STALE_SCAN_WINDOW_MS = 7 * 86_400_000`), and the existing `slack_messages_sent_at_idx` serves both bounds.
    - Screening only routes a message to `assess` while it is within `urgency.maxAgeHours`. So a pending row older than the window could exist only if no assess run happened for over a week.
    - Such a row stays `route: "assess"` without `too_old`, but it is never eligible (`eligibleWhere` needs `sentAt >= cutoff`): no Claude run, no notification. Behaviour is unchanged.
12. **K5.3.** `ProjectDetail.jira` becomes nullable. `BrainService` returns `null` while `jira.enabled` is false, and the project card renders no Jira section for `null`.
13. **K6.1 port.**
    - `modules/auto-reply/read.ts` exports `autoSentOutgoingIds(db, outgoingIds)`, which returns the outgoing ids that have an `auto_replies` row with `decision = 'sent'`.
    - `InboxConversationsDeps` gains `autoSent: (outgoingIds: readonly string[]) => ReadonlySet<string>`, wired in `container.ts` as `(ids) => autoSentOutgoingIds(db, ids)`. A free function avoids depending on construction order, since the inbox is built before `AutoReplyService`.
    - The inbox stops naming `auto_replies`. Its direct read of `outgoing_messages` is out of scope.
14. **K6.2 codes.**
    - `executorErrorCode(e: unknown): string` in `core/approvals/approvals.ts` resolves in this order:
      1. a `JobError` gives `e.classified.kind`;
      2. any `Error` whose `code` property is a string matching `/^[a-z][a-z0-9_]{0,63}$/` gives that code;
      3. anything else gives `"executor_failed"`.
    - The stored result and the audit details are `{ error: <code> }`, and the message is never read.
    - `packages/contracts` gains `ExecutorError(code)` for executors that only have a code to report.
    - Existing executors change so no information is lost:
      - the router's "no executor" becomes `ExecutorError("no_executor")`;
      - `OutgoingSendError` gains `get code(): SendFailure` (stored, for example, as `tool_error`);
      - `ProfileApplyError` takes codes `invalid_payload` | `recommendation_not_found` | `profile_write_failed`;
      - engineering's `throw new Error(code)` sites become `throw new ExecutorError(code)`.
15. **K6.3 parsing.** `includeTargets(text, file, home)` reads git config text without running git:
    - A header `[include]` or `[includeIf "…"]` (section name case-insensitive) opens an include section. Any other header closes it. Text after a header on the same line is parsed as a key line.
    - A `path` key (case-insensitive) inside an include section gives a target:
      - a double-quoted value is unescaped (`\"`, `\\`);
      - an unquoted value is cut at the first `#` or `;` and trimmed;
      - an empty value is skipped.
    - Resolution: `~` or `~/x` resolves under `home`. An absolute path stays as it is. A relative path resolves against the including file's directory, as git does.
    - `includeIf` conditions are ignored: every target is fingerprinted, which is the conservative choice.
    - `configFingerprint` follows the targets of each config file it hashes: `config`, `config.worktree`, the worktree's `config.worktree`, the global `~/.gitconfig`, `$XDG/git/config` and the system config. Attributes files and hooks are not config files.
    - It recurses to depth 5 (the top file's targets are depth 1) with a visited set seeded with the top-level files. Each target hashes as `<label>>include<i>\0<resolvedPath>\0<fileMarker>\0`, so a missing target hashes as `missing`.
16. **Already-fixed triage items, verified in code.**
    - The phase-1 minor "heartbeat adds ~1,440 job rows a day with no retention" is fixed: `RetentionService.run` prunes terminal jobs by `retention.jobsDays` (default 30). Tick it.
    - Phase-1 G3 is only partly fixed. The provider scanner (`tests/provider-boundary.ts`) catches `export … from` and dynamic `import()` of `cli-provider`. But the "modules never import integrations or infrastructure" test (`tests/boundaries.test.ts`, regex `/from\s+["'][^"']*\/(integrations|infrastructure)\//`) still misses side-effect `import "…"`, dynamic `import()` and bare `…/integrations` paths. Do not tick G3; annotate it.

## Global Constraints

- **Tests never run real `claude`, `gh`, `bwrap`, `socat` or `loginctl`.**
  - Health tests inject `run`.
  - The `runCommand` timeout test uses `sleep` from coreutils.
  - Git tests use the existing temp-repo fixtures in `git-workflow.test.ts`.
  - Every path comes from `mkdtempSync(join(tmpdir(), "syn-"))`.
- **Placeholder data only:**
  - repository `demo` with branches `main`/`stage`;
  - Slack ids `U0PLACE`;
  - Jira site names `Demo site` and `Demo site 2`, with cloud ids `0f0f0f0f-0000-0000-0000-000000000001` and `…0002`;
  - home `/home/u`.

  Never a real name, username, Jira site name or `/home/<realuser>` path.
- **Error bodies are `{ error: "<fixed_code>" }`.** Audit `details` hold ids, keys and codes only, never names, text, paths or branch names.
- **Exact copy:**
  - K1.3: "The last inspection was refused some file reads; results may be incomplete."
  - K4.1 confirm: "Remove <name> from Synapse? Files on disk are not touched." Buttons "Remove" and "Cancel". Toasts "Repository removed" and "Couldn't remove the repository".
  - K1.2:
    - hints "Several Jira sites are available — choose one below" (candidates listed) and "Several Jira sites are available — use Sync now to list them" (none listed);
    - select label "Jira site", button "Use this site";
    - toasts "Jira site saved", "That site is no longer offered — use Sync now" (`unknown_site`) and "Couldn't save the Jira site".
  - K2.1:
    - card title "Away replies";
    - kind labels "Code answers", "Stalled reminders", "Follow-up questions", "Acknowledgements";
    - number labels "Replies per person per day (0 turns them off)", "Minutes between replies in a thread", "Minimum confidence", "Cancel a reply not sent within (minutes)";
    - hint "These limits can only be made stricter than the defaults."
  - K4.3: pill "Unexpected response"; popover text "The API answered with something Synapse couldn't read. Check the API logs."
- **Exact codes and values:**
  - `unknown_site` (400);
  - `inspectionWarning: "permission_denied" | null`;
  - health detail `timeout`, with `LINGER_TIMEOUT_MS = 3_000`;
  - `MAX_INTERVAL_SECONDS = 604_800`, `FAILED_TASK_RETRY_MS = 60_000`;
  - `STALE_SCAN_WINDOW_MS = 7 * 86_400_000`;
  - executor fallback `executor_failed`;
  - include depth cap 5;
  - migration `0023_followups_batch_3`.
- **CLAUDE.md rules.**
  - Rule 2: nothing here sends. `maxPerPersonPerDay` 0 only adds holds.
  - Rule 3: candidate sites come only from the resolver's parsed tool result.
  - Rule 6: the web renders API values. Client checks only enable or disable buttons.
  - Rule 8: exactly one migration.
  - Rule 10: no new dependency.
- **Checks stay green.** Each task ends with `bun run check` passing with 0 failures and 0 biome warnings. Web tasks also pass `bun run --cwd apps/web build`.

## Review Focus

1. **The Jira candidate list goes stale, or predates this batch.** A user picks a site that a re-run of the resolver no longer lists: expect 400 `unknown_site`, the cloudId unset and the toast. A database parked with `multiple_sites` before this batch has no list: expect the "use Sync now" hint. Sync now (cloudId still null) queues the resolver, which stores the list. Tests in Task 3.
2. **`maxPerPersonPerDay` 0 with a code answer.** With `codeAnswer.away.autoSend` off, the review approval is still created (no `daily_cap` hold). With it on, the answer holds as `daily_cap`. An acknowledgement also holds as `daily_cap`. Tests in Task 4.
3. **A schedule that throws on every tick.** The other schedules in the same tick still enqueue, one log line is written, and the next attempt waits 60 s rather than 5 s. Test in Task 5.
4. **An include cycle, a deep chain or an unreadable target in a git config.** Fingerprinting terminates, is deterministic, and still changes when a target at depth ≤ 5 changes. Test in Task 8.
5. **Removing a repository with an unfinished engineering task, or clicking Remove twice.** The 409 `repo_has_active_task` shows its fixed label and the row stays. A second delete (404 `not_found`) shows "Couldn't remove the repository". Cancel on the confirm calls nothing. Tests in Task 2.

---

### Task 1: One migration: FK indexes, `jira_id`, `inspection_warning`, and a bounded `skipStale` (K5.1, K5.2, K1.3 storage)

**Files:**
- Modify:
  - `packages/database/src/schema/platform.ts`;
  - `apps/api/src/workers/urgency/context.ts`;
  - `docs/architecture/database-design.md` (a migration 0023 paragraph after the 0022 one);
  - `docs/modules/urgency-engine.md` (the stale-skip window).
- Create (generated):
  - `packages/database/migrations/0023_followups_batch_3.sql`;
  - `packages/database/migrations/meta/0023_snapshot.json`;
  - the journal entry;
  - `packages/database/test/fk-indexes.test.ts`.
- Test: `apps/api/test/workers/urgency-assess.test.ts`.

**Interfaces:**
- Produces:
  - `repositories.inspectionWarning: text("inspection_warning").$type<"permission_denied">()` (nullable), used by Task 2;
  - the 33 indexes from decision 10.
- `context.ts`: `export const STALE_SCAN_WINDOW_MS = 7 * 86_400_000`. `skipStale` adds the lower bound `sentAt >= <cutoff − window>` to its existing `where`.

- [ ] **Step 1: Write the failing tests.**
  - `fk-indexes.test.ts` (fresh temp DB plus `runMigrations`):
    - for every table from `sqlite_master` (excluding `sqlite_%` and `__drizzle%`), every `pragma foreign_key_list` column is the `seqno 0` column of some `pragma index_list` index, or the first primary-key column. The assertion is `expect(missing).toEqual([])`, where `missing` lists `table.column`;
    - `jira_issues` has an index whose leading column is `jira_id`;
    - `pragma table_info(repositories)` includes `inspection_warning`, and its `notnull` is 0.
  - `urgency-assess.test.ts`, with `urgency.maxAgeHours` 24 and two pending-assess rows (`route: "assess"`, not assessed, text set):
    - a row with `sentAt` now − 2 d gets screening `route: "skip"`, `skipReason: "too_old"` after one assess run;
    - a row with `sentAt` now − 10 d keeps `route: "assess"` with no `skipReason`;
    - neither row produced a Claude run.
- [ ] **Step 2: Run** `bun test packages/database/test/fk-indexes.test.ts apps/api/test/workers/urgency-assess.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.**
  - Add the indexes and the column to `platform.ts`, using a table's third-argument array (create it where a table has none).
  - Generate the migration as in decision 10, then check that the SQL holds only `CREATE INDEX` statements and one `ALTER TABLE repositories ADD inspection_warning text`.
  - Add the `skipStale` lower bound.
  - Docs:
    - `database-design.md`: migration 0023 lists the indexed columns (by table), `jira_issues_jira_id_idx`, and the new column.
    - `urgency-engine.md`: the 7-day window, and that older pending rows are never eligible anyway.
- [ ] **Step 4: Run** `bun run check`. Expect PASS.
- [ ] **Step 5: Commit:** `perf(db): index every foreign key, jira_id and bound skipStale (K5.1, K5.2)`.

### Task 2: Repository card: inspection warning, Remove, and the Jira-gated project summary (K1.3, K4.1, K5.3)

**Files:**
- Modify:
  - `packages/contracts/src/brain.ts`;
  - `apps/api/src/modules/engineering-brain/inspection.ts`;
  - `apps/api/src/modules/engineering-brain/registry.ts`;
  - `apps/api/src/modules/engineering-brain/service.ts`;
  - `apps/web/lib/api.ts`;
  - `apps/web/lib/brain.ts`;
  - `apps/web/app/components/brain/ProjectsSection.tsx`;
  - `apps/web/app/components/brain/ProjectCard.tsx`;
  - `apps/web/app/page.tsx`;
  - `apps/web/test/brain-fixtures.ts`;
  - `docs/modules/engineering-brain.md`;
  - `docs/modules/web-dashboard.md`.
- Test:
  - `apps/api/test/modules/brain-service.test.ts`;
  - `apps/api/test/workers/brain-inspect.test.ts`;
  - `apps/api/test/modules/brain-registry.test.ts`;
  - `apps/web/test/brain-ui.test.tsx`;
  - `apps/web/test/brain.test.ts`;
  - `apps/web/test/api.test.ts`.

**Interfaces:**
- Consumes: `repositories.inspectionWarning` (Task 1).
- Contracts:
  - `repositoryViewSchema` gains `inspectionWarning: z.enum(["permission_denied"]).nullable()`;
  - `projectDetailSchema.jira` becomes `.nullable()`.
- `InspectionService.record`: the update at the `inspectedHeadSha` line also sets `inspectionWarning: input.permissionDenials.length > 0 ? "permission_denied" : null`. `recordFailure` does not touch it.
- `RepositoryRegistry.toView`: `inspectionWarning: r.inspectionWarning ?? null`. Registration inserts `null`.
- `BrainService.jiraSummary(tx, keys): ProjectDetail["jira"]` returns `null` when `!this.deps.settings.get("jira.enabled")`. Extend the deps `Pick` if `settings` lacks it.
- Web:
  - `api.ts`: `unregisterRepository(id: string, fetchImpl?): Promise<void>` sends `DELETE /api/repos/:id` (204).
  - `brain.ts`:
    - `export const INSPECTION_DENIED_TEXT` (the K1.3 copy);
    - `export function removeErrorLabel(code: string | undefined): string`, which returns `REGISTRY_LABELS[code]` when known, else "Couldn't remove the repository".
  - `ProjectsSectionProps` gains `onRemove: (repoId: string) => void`.
  - `RepoRow` keeps local `confirming` state:
    - "Remove" sets it;
    - while confirming it renders `<p role="alert">` with the confirm copy, a primary "Remove" that calls `onRemove(repo.id)` and resets, and "Cancel", which resets;
    - when `inspectionWarning === "permission_denied"` it renders `<p className="syn-brain-drift" role="status"><Chip tone="amber">Inspection</Chip> {INSPECTION_DENIED_TEXT}</p>`.
  - `ProjectCard`: `attention` is `[]` and the Jira section is not rendered when `project.jira === null`.
  - `page.tsx`: `removeRepository(id)` awaits `unregisterRepository`, then toasts "Repository removed". On an `ApiError` it toasts `removeErrorLabel(e.code)`; on any other error it toasts "Couldn't remove the repository". It always runs `refresh()` afterwards.

- [ ] **Step 1: Write the failing tests.**
  - `brain-inspect.test.ts`:
    - a recorded inspection with `permissionDenials: ["Read"]` gives `repositories.get(id).inspectionWarning === "permission_denied"`;
    - a following inspection with `[]` gives `null`;
    - a `recordFailure` in between leaves the value as it was.
  - `brain-registry.test.ts`: a new registration has `inspectionWarning: null`.
  - `brain-service.test.ts`: with `jira.enabled` false, `projectDetail(id).jira` is `null` even though an in-scope attention issue for the repo's key exists. With it true, `byAttention.overdue === 1`.
  - `brain-ui.test.tsx` (`renderToString`):
    - a repo with `inspectionWarning: "permission_denied"` contains the K1.3 sentence; `null` does not;
    - the row contains a "Remove" button;
    - a project with `jira: null` has no "Jira attention".
  - `brain.test.ts`: `removeErrorLabel("repo_has_active_task")` is the existing label; `removeErrorLabel("not_found")` and `removeErrorLabel(undefined)` are "Couldn't remove the repository".
  - `api.test.ts`: `unregisterRepository("r1", fake)` sends `DELETE /api/repos/r1` and resolves `undefined` on 204. A 409 `{ error: "repo_has_active_task" }` rejects with an `ApiError` whose `code === "repo_has_active_task"` (Review Focus 5).
  - Confirm-state logic: if the row's state cannot be driven through `renderToString`, extract `removeConfirmText(name: string): string` into `brain.ts` and assert it returns the exact copy for `demo`.
- [ ] **Step 2: Run** `bun test apps/api/test/workers/brain-inspect.test.ts apps/api/test/modules/brain-registry.test.ts apps/api/test/modules/brain-service.test.ts apps/web/test/brain-ui.test.tsx apps/web/test/brain.test.ts apps/web/test/api.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** the interfaces above. Add `inspectionWarning: null` to the web fixtures.
  - Docs:
    - `engineering-brain.md`: the repository view field, the column and when it is set or cleared; `jira` is `null` while Jira is off; the Remove button.
    - `web-dashboard.md`: the Projects section gets the Remove confirm and the inspection warning.
- [ ] **Step 4: Run** `bun run check && bun run --cwd apps/web build`. Expect PASS.
- [ ] **Step 5: Commit:** `feat(brain): inspection warning, repository remove, Jira-gated project summary (K1.3, K4.1, K5.3)`.

### Task 3: Choose the Jira site when several exist (K1.2)

**Files:**
- Modify:
  - `apps/api/src/core/config/settings.ts`;
  - `apps/api/src/workers/jira/resolve-cloud-id.ts`;
  - `apps/api/src/modules/jira-tracking/service.ts`;
  - `apps/api/src/routes/jira.ts`;
  - `apps/api/src/container.ts` (`audit` into `JiraService`);
  - `packages/contracts/src/jira.ts`;
  - `apps/web/lib/api.ts`;
  - `apps/web/lib/jira.ts`;
  - `apps/web/app/components/jira/JiraSection.tsx`;
  - `apps/web/app/page.tsx`;
  - `docs/modules/jira.md`.
- Test:
  - `apps/api/test/workers/jira-sync.test.ts`;
  - `apps/api/test/modules/jira-tracking.test.ts`;
  - `apps/api/test/routes/jira.test.ts`;
  - `apps/web/test/jira.test.ts`;
  - `apps/web/test/jira-ui.test.tsx`.

**Interfaces:**
- Setting (internal, not editable): `"jira.cloudIdCandidates": z.array(z.object({ id: z.string().regex(/^[0-9a-fA-F-]{8,64}$/), name: z.string().max(200) })).max(20).default([])`.
- Resolver:
  - `sites` is typed `{ id: string; name: string }[]`.
  - The park branch runs one immediate transaction with `sync.update(tx, "jira.issues", { lastError: { kind: "needs_attention", message: reason } })` and `settings.setIn(tx, "jira.cloudIdCandidates", candidates, { emit: false })`. `candidates` follows decision 2 for `multiple_sites` and is `[]` for `no_sites`. Then it throws as today.
  - The success transaction also sets `[]`.
- Contracts: `jiraStatusDtoSchema` gains `sites: z.array(z.object({ id: z.string(), name: z.string() }))`.
- `JiraService`:
  - `status()` returns `sites: settings.get("jira.cloudId") === null ? settings.get("jira.cloudIdCandidates") : []`.
  - `JiraSettingsPatch.cloudId?: string`.
  - `export class JiraUnknownSite extends Error`.
  - `JiraServiceDeps` gains `audit: AuditLogger`.
- `updateSettings`, inside the existing transaction:
  1. Read `oldCloudId`.
  2. If `patch.cloudId` is set and the candidate list is non-empty without that id, throw `JiraUnknownSite`, and nothing is written.
  3. `siteChanged = patch.cloudId !== undefined && patch.cloudId !== oldCloudId`. When true:
     - set `jira.cloudId`;
     - set the candidates to `[]` (`emit: false`);
     - `sync.update(tx, "jira.issues", { lastError: null })`;
     - audit as in decision 2.
  4. If `siteChanged && oldCloudId !== null`, join the scope-change branch (checkpoint reset, generations, fresh reconcile).
  5. If `siteChanged`, Jira is enabled and was already enabled, enqueue a sync, plus a reconcile while the checkpoint is null.
  6. The existing `enabled && !wasEnabled` branch reads `hasCloudId` after the write.
- Route: `settingsBody` gains `cloudId: z.string().regex(/^[0-9a-fA-F-]{8,64}$/)`. `JiraUnknownSite` maps to 400 `{ error: "unknown_site" }`.
- Web:
  - `JiraSettingsDto.cloudId?: string`.
  - `jiraErrorLabel(lastError: string | null, sitesListed = false): string | null`. `multiple_sites` returns the "choose one below" hint when `sitesListed`, else the "use Sync now" hint.
  - `JiraSection` gains `onChooseSite?: (id: string) => void`. When enabled, `lastError === "multiple_sites"`, `status.sites.length > 0` and `onChooseSite` is given, it renders:
    - a `<select aria-label="Jira site">` whose options are `{s.name || s.id}` with value `s.id`, the first selected by default;
    - a "Use this site" button.
  - `page.tsx`: `chooseJiraSite(id)` calls `updateJiraSettings({ cloudId: id })` and toasts "Jira site saved". An `ApiError` with code `unknown_site` toasts the "no longer offered" copy; any other failure toasts "Couldn't save the Jira site". It always refreshes.

- [ ] **Step 1: Write the failing tests.**
  - `jira-sync.test.ts` (fake source):
    - two sites, `Demo site` and `Demo site 2`, give `jira.cloudIdCandidates` equal to both `{ id, name }`, and `status().sites` the same;
    - one site with an invalid id plus one valid gives only the valid one;
    - a 250-character name is stored clipped to 200;
    - zero sites gives `[]`;
    - one site stores the cloudId and `[]`;
    - the audit table holds neither site name.
  - `jira-tracking.test.ts`:
    - with candidates stored and Jira enabled, `updateSettings({ cloudId: <id 1> })`:
      - sets the cloudId;
      - clears the candidates and `status().lastError`;
      - enqueues `jira.sync_incremental` plus `jira.reconcile` (no checkpoint);
      - writes one audit row with `details` `{ keys: ["jira.cloudId"] }` and no site name;
    - `cloudId: "0f0f0f0f-0000-0000-0000-00000000dead"` throws `JiraUnknownSite`, with nothing written (Review Focus 1);
    - with no candidates, any id matching the regex is accepted;
    - changing a set cloudId to another resets the checkpoint and queues a fresh reconcile;
    - the same id is a no-op (no audit row).
  - `jira.test.ts` (route): `PUT { cloudId: "nope" }` gives 400; an unknown candidate gives 400 `{ error: "unknown_site" }`; `GET /api/jira/status` includes `sites`.
  - Web `jira.test.ts`: both `jiraErrorLabel` hints.
  - `jira-ui.test.tsx`: an enabled status with `multiple_sites` and two sites renders `aria-label="Jira site"`, both names and "Use this site". With `sites: []` it renders no select and the "use Sync now" hint. A disabled status renders no select.
- [ ] **Step 2: Run** `bun test apps/api/test/workers/jira-sync.test.ts apps/api/test/modules/jira-tracking.test.ts apps/api/test/routes/jira.test.ts apps/web/test/jira.test.ts apps/web/test/jira-ui.test.tsx`. Expect FAIL.
- [ ] **Step 3: Implement** the interfaces above. Add `sites: []` to the web status fixtures.
  - `jira.md`:
    - B1 gains the internal setting;
    - B4: the candidates are stored and the user picks one in the Jira section;
    - the status shape gains `sites`;
    - `PUT /api/jira/settings` accepts `cloudId` and answers `unknown_site`;
    - update the two hint strings;
    - replace "No route sets `jira.cloudId`" in "Doc and code differences".
- [ ] **Step 4: Run** `bun run check && bun run --cwd apps/web build`. Expect PASS.
- [ ] **Step 5: Commit:** `feat(jira): store candidate sites and let the user choose jira.cloudId (K1.2)`.

### Task 4: Away-reply limits the user can only tighten (K2.1)

**Files:**
- Modify:
  - `apps/api/src/core/config/settings.ts`;
  - `apps/api/src/modules/auto-reply/service.ts`;
  - `apps/web/lib/api.ts`;
  - `apps/web/app/page.tsx`;
  - `docs/modules/auto-reply.md`;
  - `docs/decisions/ADR/ADR-033-away-mode-auto-replies.md` (one Implementation line).
- Create:
  - `apps/web/app/components/system/AwayReplySettings.tsx`.
- Test:
  - `apps/api/test/routes/settings.test.ts`;
  - `apps/api/test/core/config.test.ts`;
  - `apps/api/test/modules/auto-reply-service.test.ts`;
  - `apps/web/test/system.test.tsx`.

**Interfaces:**
- `settingSchemas`: the five schemas from decision 4. `allowedKinds` adds `.max(4).refine((a) => new Set(a).size === a.length)`.
- `USER_EDITABLE_SETTINGS` appends the five keys. `autoReply.awayMode` stays out.
- `AutoReplyService` (the `decideAutoReply` call): `maxPerDay: reviewOnly ? Number.POSITIVE_INFINITY : settings.get("autoReply.maxPerPersonPerDay")`.
- Web:
  - `export interface AwayReplySettingsDto { "autoReply.allowedKinds": AutoReplyKind[]; "autoReply.maxPerPersonPerDay": number; "autoReply.minMinutesBetweenInThread": number; "autoReply.minConfidence": number; "autoReply.maxSendDelayMinutes": number }`, with `AutoReplyKind = "code_answer" | "stalled_reminder" | "followup_question" | "acknowledgement"`.
  - `SettingsDto = ClaudeSettingsDto & OpsSettingsDto & AwayReplySettingsDto`.
  - `AwayReplySettings({ values, onChange }: { values: AwayReplySettingsDto | null; onChange: (key: keyof AwayReplySettingsDto, value: number | AutoReplyKind[]) => void })`:
    - "Settings unavailable." when `values` is null;
    - four checkboxes in the fixed kind order, each toggle sending the new array in that order;
    - four number inputs following `ClaudeSettings`' blur pattern, with min/max from decision 4 and `step={0.05}` for confidence;
    - the hint paragraph.
  - `page.tsx` renders it after `ClaudeSettings` in the system section, with the same `putSettings` and toast handling.

- [ ] **Step 1: Write the failing tests.**
  - `settings.test.ts`:
    - `GET` includes the five defaults;
    - `PUT` gives 400 `invalid_setting` for each of these:
      - `maxPerPersonPerDay` 4 and −1;
      - `minMinutesBetweenInThread` 29;
      - `minConfidence` 0.7;
      - `maxSendDelayMinutes` 16 and 0;
      - `allowedKinds ["bogus"]` and `["acknowledgement","acknowledgement"]`;
      - `autoReply.awayMode` true (not editable);
    - `PUT { "autoReply.maxPerPersonPerDay": 0, "autoReply.allowedKinds": [] }` gives 200, and one `settings.updated` audit row whose `details.keys` is exactly those two keys.
  - `config.test.ts`: `settings.set("autoReply.minConfidence", 0.5)` throws.
  - `auto-reply-service.test.ts` (Review Focus 2), with `maxPerPersonPerDay` 0, away on and a high-priority recipient:
    - a `followup_question` with confidence 0.9 holds as `daily_cap`;
    - an acknowledgement holds as `daily_cap`;
    - a `code_answer` with `codeAnswer.away.autoSend` false still becomes the review approval (the existing `code_answer_review` outcome);
    - with `autoSend` true it holds as `daily_cap`.
  - `system.test.tsx`:
    - `AwayReplySettings` with defaults renders "Away replies", the four kind labels checked, the four number labels and the hint;
    - `values={null}` renders "Settings unavailable.";
    - the confidence input has `min="0.75"` and `max="1"`.
- [ ] **Step 2: Run** `bun test apps/api/test/routes/settings.test.ts apps/api/test/core/config.test.ts apps/api/test/modules/auto-reply-service.test.ts apps/web/test/system.test.tsx`. Expect FAIL.
- [ ] **Step 3: Implement** the interfaces above.
  - Docs:
    - `auto-reply.md` Settings: a range column; "editable through `PUT /api/settings` and the Away replies card"; 0 means no automatic replies, while a code-answer review approval is still created. Replace the paragraph that says there is no UI.
    - ADR-033 Implementation: "Follow-ups batch 3: the five limits are editable, only towards stricter values (ranges in `docs/modules/auto-reply.md`)."
- [ ] **Step 4: Run** `bun run check && bun run --cwd apps/web build`. Expect PASS.
- [ ] **Step 5: Commit:** `feat(auto-reply): stricter-only away-reply limits in settings (K2.1)`.

### Task 5: Robustness: linger timeout, scheduler isolation, PASSIVE checkpoint, backup 409 (K3.1–K3.4)

**Files:**
- Create:
  - `apps/api/src/infrastructure/run-command.ts`;
  - `apps/api/test/integration/run-command.test.ts`.
- Modify:
  - `apps/api/src/container.ts`;
  - `apps/api/src/core/health/checks.ts`;
  - `apps/api/src/core/scheduler/scheduler.ts`;
  - `apps/api/src/core/ops/retention.ts`;
  - `apps/api/src/workers/ops.ts`;
  - `apps/web/lib/api.ts` (the `startBackup` comment only);
  - `docs/architecture/runtime-design.md`;
  - `docs/architecture/database-design.md`.
- Test:
  - `apps/api/test/core/health.test.ts`;
  - `apps/api/test/core/scheduler.test.ts`;
  - `apps/api/test/core/ops-retention.test.ts`;
  - `apps/api/test/routes/system.test.ts`.

**Interfaces:**
- `run-command.ts`:
  - `export type CommandRunner = (cmd: string[], opts?: { timeoutMs?: number }) => Promise<string>`;
  - `export class CommandTimeoutError extends Error` (name `"CommandTimeoutError"`, message `"command timed out"`);
  - `export const runCommand: CommandRunner`. It is today's body plus, when `timeoutMs` is set, a timer that calls `proc.kill("SIGKILL")` and rejects with `CommandTimeoutError`. The timer is cleared on normal exit.
- `container.ts`: the local `runCommand` is removed and imported instead, and `ContainerDeps.run?: CommandRunner`. Existing one-argument fakes stay compatible.
- `checks.ts`: `export const LINGER_TIMEOUT_MS = 3_000`. `lingerCheck(run: CommandRunner, user?)` calls `run([...], { timeoutMs: LINGER_TIMEOUT_MS })` and maps `CommandTimeoutError` to `{ status: "degraded", detail: "timeout" }`.
- `scheduler.ts`:
  - `export const MAX_INTERVAL_SECONDS = 604_800`, `export const FAILED_TASK_RETRY_MS = 60_000`.
  - `upsert` stores `Math.min(s.intervalSeconds, MAX_INTERVAL_SECONDS)` after the positive-integer check.
  - In `tick`, each task's transaction sits in `try/catch`. On a throw it logs `` console.error(`scheduler: task failed name=${task.name} error=${e instanceof Error ? e.name : "unknown"}`) ``, then runs a best-effort `update scheduled_tasks set next_run_at = now + FAILED_TASK_RETRY_MS where id = ?` in its own try/catch, then continues.
- `retention.ts`: `pragma wal_checkpoint(PASSIVE)`. `core/system/shutdown.ts` keeps TRUNCATE.
- `workers/ops.ts`: `backupJobLive(db)` uses the rule from decision 7.
- `startBackup` comment: "409 (`already_running`) while a manual backup is queued or running, or a scheduled one is running."

- [ ] **Step 1: Write the failing tests.**
  - `run-command.test.ts`:
    - `runCommand(["echo", "hi"])` resolves `"hi\n"`;
    - `runCommand(["sleep", "5"], { timeoutMs: 50 })` rejects with `CommandTimeoutError` in under 1 000 ms.
  - `health.test.ts`:
    - a `run` that throws `new CommandTimeoutError()` gives `{ status: "degraded", detail: "timeout" }`;
    - the fake receives `{ timeoutMs: 3000 }`;
    - the existing yes/no cases still pass.
  - `scheduler.test.ts` (Review Focus 3), with schedules `a` (job type `boom`) and `b` both due and a queue whose `enqueue` throws for `boom`:
    - `tick()` returns 1 and `b`'s job exists;
    - `console.error` (spied) got exactly `scheduler: task failed name=a error=Error`;
    - `a`'s `nextRunAt` is now + 60 s;
    - a second `tick()` at the same time logs nothing new.
    - Separately, `upsert({ intervalSeconds: 10_000_000 })` stores 604 800, and `0` still throws.
  - `ops-retention.test.ts`: spy on `sqlite.exec`. A run executes `pragma wal_checkpoint(PASSIVE)` and never a TRUNCATE checkpoint.
  - `system.test.ts`:
    - a scheduled `ops.backup` job (`input` null) PENDING → `POST` 202;
    - the same job RUNNING → 409 `already_running`;
    - a manual job in RETRY → 409;
    - the existing "second POST while pending is 409" still passes.
- [ ] **Step 2: Run** `bun test apps/api/test/integration/run-command.test.ts apps/api/test/core/health.test.ts apps/api/test/core/scheduler.test.ts apps/api/test/core/ops-retention.test.ts apps/api/test/routes/system.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** the interfaces above.
  - Docs:
    - `runtime-design.md`: the linger check's 3 s timeout and `timeout` detail; scheduler per-task isolation, the 7-day clamp and the 60 s retry; the "Back up now" 409 rule.
    - `database-design.md` retention paragraph: `wal_checkpoint(PASSIVE)`, while shutdown keeps TRUNCATE.
- [ ] **Step 4: Run** `bun run check && bun run --cwd apps/web build`. Expect PASS.
- [ ] **Step 5: Commit:** `fix(core): linger timeout, scheduler isolation, passive checkpoint, sharper backup 409 (K3.1-K3.4)`.

### Task 6: Overview fixes: unverified sends, footer ports, malformed responses (K1.1, K4.2, K4.3)

**Files:**
- Modify:
  - `apps/api/src/modules/dashboard/service.ts`;
  - `packages/contracts/src/runtime.ts`;
  - `apps/api/src/core/ops/runtime.ts`;
  - `apps/api/src/container.ts`;
  - `apps/web/lib/api.ts`;
  - `apps/web/lib/format.ts`;
  - `apps/web/app/components/shell/Sidebar.tsx`;
  - `apps/web/app/components/header/HealthPill.tsx`;
  - `apps/web/app/components/header/Header.tsx`;
  - `apps/web/app/page.tsx`;
  - `docs/modules/dashboard.md`;
  - `docs/modules/web-dashboard.md`;
  - `docs/architecture/runtime-design.md` (the runtime view fields).
- Test:
  - `apps/api/test/modules/dashboard.test.ts`;
  - `apps/api/test/core/ops-runtime.test.ts`;
  - `apps/web/test/api.test.ts`;
  - `apps/web/test/header.test.tsx`;
  - `apps/web/test/shell.test.tsx`;
  - `apps/web/test/page-wiring.test.tsx`.

**Interfaces:**
- `DashboardService.overview`: `outgoingAttention` counts `or(eq(status, "needs_attention"), and(eq(status, "sent_unverified"), eq(failure, "unverified")))`.
- `RuntimeView` gains `endpoints: { api: { host: string; port: number }; web: { host: string; port: number } }`. `RuntimeDeps` gains `endpoints: RuntimeView["endpoints"]`, and the container passes `{ api: config.api, web: config.web }`.
- `format.ts`: `export function footerAddresses(r: RuntimeView | null): { api: string; web: string } | null`. It returns `null` for `null`. The API address is `host.includes(":") ? \`[${host}]:${port}\` : \`${host}:${port}\``, and the web address is `` `:${web.port}` ``.
- `Sidebar` `footer: { addresses: { api: string; web: string } | null; lock: string }`. The api/web `dt`/`dd` pairs render only when `addresses` is non-null.
- `page.tsx`: the `FOOTER` constant is deleted, and the footer becomes `{ addresses: footerAddresses(runtime), lock: lockText(...) }`.
- `api.ts`:
  - `OverviewFailure = { kind: "network" } | { kind: "http"; status: number } | { kind: "unexpected" }`;
  - `classifyOverviewFailure` follows decision 9.
- `HealthPill`:
  - `unexpected`: label "Unexpected response", tone `degraded`, popover title "Overview unavailable", text as in Global Constraints;
  - `http` keeps its status sentence.
- `Header`: `unexpected` uses the `http` sentences.

- [ ] **Step 1: Write the failing tests.**
  - `dashboard.test.ts`: outgoing rows `needs_attention`, `sent_unverified`/`unverified`, `sent_unverified`/null and `sent` give `counts.outgoingAttention === 2`.
  - `ops-runtime.test.ts`: `view().endpoints` equals the injected `{ api: { host: "127.0.0.1", port: 7400 }, web: { host: "127.0.0.1", port: 7401 } }`.
  - `api.test.ts`:
    - `classifyOverviewFailure(new TypeError("fetch failed"))` gives `network`;
    - `new ApiError("x", 500)` gives `http` 500;
    - `new SyntaxError("bad json")` gives `unexpected`;
    - `getOverview` with a fake returning `new Response("not json", { status: 200 })` rejects, and classifying that rejection gives `unexpected`.
  - `header.test.tsx`: failure `{ kind: "unexpected" }` renders "Unexpected response", and renders neither "Unreachable" nor "Can&#x27;t reach".
  - `shell.test.tsx`:
    - addresses `{ api: "127.0.0.1:7400", web: ":7401" }` render both;
    - `addresses: null` renders neither `7400` nor a `<dt>api`;
    - `footerAddresses` with host `::1` gives `[::1]:7400`;
    - `footerAddresses(null)` is `null`.
  - `page-wiring.test.tsx`: the `page.tsx` source does not contain `127.0.0.1:7400`.
- [ ] **Step 2: Run** `bun test apps/api/test/modules/dashboard.test.ts apps/api/test/core/ops-runtime.test.ts apps/web/test/api.test.ts apps/web/test/header.test.tsx apps/web/test/shell.test.tsx apps/web/test/page-wiring.test.tsx`. Expect FAIL.
- [ ] **Step 3: Implement** the interfaces above. Update the existing test that renders `Sidebar` with the old footer shape.
  - Docs:
    - `dashboard.md`: the `outgoingAttention` row.
    - `web-dashboard.md`: the footer comes from `/api/system/runtime` and is omitted while unavailable; the "Unexpected response" state.
    - `runtime-design.md`: the `endpoints` field.
- [ ] **Step 4: Run** `bun run check && bun run --cwd apps/web build`. Expect PASS.
- [ ] **Step 5: Commit:** `fix(dashboard): count unverified sends, footer ports from the API, unexpected-response state (K1.1, K4.2, K4.3)`.

### Task 7: Boundaries: the auto-reply read port and content-free executor errors (K6.1, K6.2)

**Files:**
- Create: `apps/api/src/modules/auto-reply/read.ts`.
- Modify:
  - `apps/api/src/modules/inbox/conversations.ts`;
  - `apps/api/src/container.ts`;
  - `packages/contracts/src/errors.ts`;
  - `apps/api/src/core/approvals/approvals.ts`;
  - `apps/api/src/core/approvals/execution.ts`;
  - `apps/api/src/modules/outgoing/service.ts`;
  - `apps/api/src/modules/people/profiles.ts`;
  - `apps/api/src/modules/engineering-tasks/steps.ts`;
  - `docs/architecture/module-boundaries.md`;
  - `docs/modules/auto-reply.md`;
  - `docs/architecture/integration-contracts.md` (the approvals executor contract).
- Test:
  - `apps/api/test/modules/auto-reply-service.test.ts`;
  - `apps/api/test/modules/inbox-conversations.test.ts`;
  - `apps/api/test/core/approvals.test.ts`;
  - `apps/api/test/core/approval-execution.test.ts`;
  - `apps/api/test/modules/outgoing.test.ts`;
  - `apps/api/test/modules/people-profiles.test.ts`.

**Interfaces:**
- `read.ts`: `export function autoSentOutgoingIds(db: DbOrTx, outgoingIds: readonly string[]): Set<string>`. It returns an empty set without a query for `[]`, and otherwise selects `outgoing_id` where `outgoing_id in (…)` and `decision = 'sent'`.
- Inbox:
  - `InboxConversationsDeps.autoSent: (outgoingIds: readonly string[]) => ReadonlySet<string>`;
  - the outgoing select also takes `id` and drops the `exists` subquery;
  - `auto` becomes `autoSent(ids).has(o.id)`, with one call per thread, skipped when the thread has no outgoing rows.
- Contracts: `export class ExecutorError extends Error { constructor(readonly code: string) }`, with message = code and name `"ExecutorError"`.
- Approvals: `export function executorErrorCode(e: unknown): string`, as in decision 14. The catch stores `{ error: executorErrorCode(e) }`. The router throws `new ExecutorError("no_executor")`.
- Executors:
  - `OutgoingSendError`: `get code(): SendFailure { return this.failure; }`;
  - `ProfileApplyError(code: "invalid_payload" | "recommendation_not_found" | "profile_write_failed")`, with `readonly code` and message = code;
  - `steps.ts`: every `throw new Error(<code>)` in an executor path becomes `throw new ExecutorError(<code>)`.

- [ ] **Step 1: Write the failing tests.**
  - `auto-reply-service.test.ts`: `autoSentOutgoingIds(db, ["o1","o2","o3"])`, with `o1` sent, `o2` held and `o3` having no row, gives `{"o1"}`. `[]` gives an empty set.
  - `inbox-conversations.test.ts`:
    - the existing `sentViaSynapse.auto` cases still pass with `autoSent` injected;
    - a thread with no outgoing rows still renders when `autoSent` throws, because it is not called for an empty list;
    - the `conversations.ts` source does not contain `auto_replies`.
  - `approvals.test.ts`:
    - an executor throwing `new Error("token SECRET-TEXT")` gives `executionResult` `{ error: "executor_failed" }`, the `approval.failed` audit details `{ error: "executor_failed" }`, and neither row containing `SECRET`;
    - `new JobError({ kind: "timeout", message: "SECRET" })` gives `{ error: "timeout" }`;
    - `new ExecutorError("protected_branch")` gives `{ error: "protected_branch" }`;
    - an `Error` with `code` `"Bad Code!"` gives `executor_failed`.
  - Update the existing expectations:
    - `approval-execution.test.ts`: `{ error: "no_executor" }`;
    - `outgoing.test.ts`: `{ error: "<failure>" }`, for example `{ error: "tool_error" }`, `{ error: "not_started" }`, `{ error: "outcome_unrecorded" }`;
    - `people-profiles.test.ts`: the new codes.
- [ ] **Step 2: Run** `bun test apps/api/test/modules/auto-reply-service.test.ts apps/api/test/modules/inbox-conversations.test.ts apps/api/test/core/approvals.test.ts apps/api/test/core/approval-execution.test.ts apps/api/test/modules/outgoing.test.ts apps/api/test/modules/people-profiles.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** the interfaces above. Run `bun test apps/api/test/workers/engineering-steps.test.ts` to confirm the engineering executors are unchanged in behaviour.
  - Docs:
    - `module-boundaries.md`: `auto-reply` exposes `autoSentOutgoingIds` (read), and `inbox` consumes it.
    - `auto-reply.md`: the read port.
    - `integration-contracts.md` (approvals): the stored error is a fixed code (`JobError` kind, an error's `code`, else `executor_failed`), and executors throw `ExecutorError` for refusals.
- [ ] **Step 4: Run** `bun run check`. Expect PASS.
- [ ] **Step 5: Commit:** `refactor(core): auto-reply read port for the inbox, fixed-code executor errors (K6.1, K6.2)`.

### Task 8: Fingerprint git config includes, and close the follow-ups (K6.3)

**Files:**
- Create: `apps/api/src/integrations/repository/git-includes.ts`.
- Modify:
  - `apps/api/src/integrations/repository/git-workflow.ts`;
  - `docs/architecture/security-model.md`;
  - `docs/modules/engineering-tasks.md`;
  - the follow-ups files:
    - `docs/superpowers/plans/2026-11-05-phase-1-followups.md`;
    - `docs/superpowers/plans/2026-11-05-phase-4-followups.md`;
    - `docs/superpowers/plans/2026-11-06-phase-5-followups.md`;
    - `docs/superpowers/plans/2026-11-06-phase-6b-followups.md`;
    - `docs/superpowers/plans/2026-11-06-phase-7-followups.md`;
    - `docs/superpowers/plans/2026-11-06-phase-8-followups.md`;
    - `docs/superpowers/plans/2026-11-06-phase-9-followups.md`;
    - `docs/superpowers/plans/2026-11-06-phase-10-followups.md`;
    - `docs/superpowers/plans/2026-11-07-phase-11-followups.md`.
- Test:
  - `apps/api/test/integrations/git-includes.test.ts`;
  - `apps/api/test/integrations/git-workflow.test.ts`.

**Interfaces:**
- `git-includes.ts`:
  - `export const INCLUDE_DEPTH_MAX = 5`;
  - `export function includeTargets(text: string, file: string, home: string): string[]`, parsing as in decision 15. It returns resolved absolute paths in file order, duplicates kept.
- `git-workflow.ts`, in `configFingerprint`, uses a private `configFile(h, label, path, visited)`. It hashes the marker as today, then follows includes depth-first:
  - read the text (an unreadable or missing file has no targets);
  - for each target `t` at index `i`, `h.update(\`${label}>include${i}\0${t}\0${fileMarker(t)}\0\`)`;
  - recurse into `t` while depth < `INCLUDE_DEPTH_MAX` and `t` is not in `visited`, adding it first.

  The six config files use `configFile`. `info/attributes`, `xdg/attributes` and hooks keep `file`/`walk`. `gitDirFingerprint` inherits the change through `configFingerprint`.

- [ ] **Step 1: Write the failing tests.**
  - `git-includes.test.ts` (pure, file `/home/u/r/.git/config`, home `/home/u`):
    - `[include]\n\tpath = extra.cfg` gives `["/home/u/r/.git/extra.cfg"]`;
    - `[includeIf "gitdir:/home/u/"]\n\tpath = ~/inc.cfg` gives `["/home/u/inc.cfg"]`;
    - `[Include]\n\tPath = "/abs/x.cfg" ; note` gives `["/abs/x.cfg"]`;
    - `path = y # c` gives `…/y`;
    - `[core]\n\tpath = no` gives `[]`;
    - `[include] path = same-line.cfg` gives one target;
    - an empty value gives `[]`;
    - `"a\\"b"` unescapes to `a"b`.
  - `git-workflow.test.ts` (existing fixture with `f.home`):
    - `git config include.path extra.cfg`, then fingerprint, then writing `.git/extra.cfg` changes it (missing to present);
    - a second change changes it again;
    - a global `~/.gitconfig` with `[includeIf "gitdir:/"] path = ~/inc.cfg`: changing `<home>/inc.cfg` changes the fingerprint and makes `diffSummary` with an old baseline report `git_dir_changed`;
    - (Review Focus 4) a cycle `extra.cfg` → `b.cfg` → `extra.cfg` gives two equal consecutive fingerprints with no hang;
    - a chain of seven includes from the repo config: changing the file at depth 5 changes the fingerprint, and changing depth 6 does not (the documented cap);
    - an unreadable target (`chmod 000`, skipped when running as root) gives a stable fingerprint.
- [ ] **Step 2: Run** `bun test apps/api/test/integrations/git-includes.test.ts apps/api/test/integrations/git-workflow.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** the interfaces above.
  - `security-model.md` (§3.1 area) and `engineering-tasks.md`: include targets are fingerprinted (depth 5, `includeIf` unconditional, missing hashes as `missing`).
- [ ] **Step 4: Tick the follow-ups.** For each item, use the existing style: `~~**Item.**~~ **Done in follow-ups batch 3.** <one line>. Original note: …`, or `(done in follow-ups batch 3)` in table rows.
  - Phase 1:
    - G4 (scheduler);
    - G5 first half (the raw executor messages; note that surfacing stuck claims stays open);
    - G6 (linger);
    - the minors "No indexes on FK columns" and "Heartbeat … no retention yet" (already fixed: `retention.jobsDays` prunes terminal jobs);
    - annotate G3 with decision 16's text and leave it open.
  - Phase 4: `skipStale`.
  - Phase 5: the approvals note "the engine stores an executor's `e.message`".
  - Phase 6b: M3 and M5.
  - Phase 7: the briefing count, the sidebar footer addresses, and `classifyOverviewFailure`.
  - Phase 8: the multi-site manual step (multi-site support itself stays open), the "route to set `jira.cloudId`" in Smaller items, and "Lookup by `jira_id`". The count-only mentions view stays open.
  - Phase 9: the remove button, the Jira gate and the permission denials.
  - Phase 10: the `include.path` item.
  - Phase 11: the `wal_checkpoint(TRUNCATE)` item and the "Back up now" 409 item.
- [ ] **Step 5: Run** `bun run check && bun run --cwd apps/web build`. Expect PASS.
- [ ] **Step 6: Commit:** `feat(git): fingerprint include.path and includeIf targets; close batch-3 follow-ups (K6.3)`.

## File overlap between tasks

- **Tasks 3 and 4** both touch `apps/api/src/core/config/settings.ts`. Run them one after the other.
- **`apps/web/lib/api.ts`** is touched by Tasks 2, 3, 4, 5 (comment only) and 6. **`apps/web/app/page.tsx`** is touched by Tasks 2, 3, 4 and 6. Every web task therefore runs sequentially.
- **`apps/api/src/container.ts`** is touched by Tasks 3, 5, 6 and 7.
- **Task 2 depends on Task 1** (the `inspection_warning` column).
- **`docs/architecture/runtime-design.md`** is touched by Tasks 5 and 6. **`docs/architecture/database-design.md`** by Tasks 1 and 5. **`docs/modules/auto-reply.md`** and **`apps/api/test/modules/auto-reply-service.test.ts`** by Tasks 4 and 7.
- **Task 8** touches only git-workflow files and docs; it ticks the follow-ups, so it runs last.
- Nothing pairs cleanly for parallel work except Task 1 against Task 8's code steps. Run the tasks in order.
