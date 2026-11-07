# Follow-ups Batch 2: Dashboard Fixes, Engineering History, Develop Retry and Runtime Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three dashboard customise bugs (lost drafts, racing layout switches, a stale active id). Show cleanup outcomes in engineering history. Let the user retry a develop step that stopped on a sandbox problem. Move backups and `quick_check` off the event loop, and close five small runtime gaps.

**Architecture:**
- **H1 (web only, plus one API response change):**
  - An in-memory draft store, `apps/web/lib/drafts.ts`, behind a `useDraft` hook keeps reply drafts across remounts.
  - `createLayoutSaver().flush()` reports whether its saves worked. A pure `runLayoutCall` serialises picker calls: lock, flush, abort on a failed flush, then the call, then apply.
  - `POST …/activate` returns the `GET /api/dashboard/layouts` body, and the web applies it directly.
- **H2:**
  - `EngineeringTaskView` gains `cleanup: EngineeringCleanupView | null`. It is computed in `store.ts` from rows that already exist: the cleanup and push_pr step rows, and the `engineering.cancelled` audit row.
  - The History rows render badges.
- **H3 + H4.6:**
  - A new develop failure, `sandbox_root_masked`, is checked by the step worker before a run.
  - `sandbox_disabled`, `sandbox_path_too_long` and `sandbox_root_masked` now end in `needs_attention` like `sandbox_unavailable` does, so the task keeps the lock and can be retried.
  - `EngineeringStepService.retryDevelop` is behind `POST …/retry-develop`, and the Needs-you card gets "Try again".
- **H4.1/H4.2:**
  - `runDbTask` runs `VACUUM INTO` plus `integrity_check`, or `quick_check`, in a Bun `Worker` with its own read-only connection. `BackupService.run` and `DatabaseIntegrity.check` become async.
  - `SchedulerService.runNow` makes `main.ts`'s first tick enqueue the daily backup tick at start.
- **H4.3–H4.7:**
  - Runtime panel note, snapshot retention, absolute `dbPath`, and pruning of old instance run roots.
  - H4.8 is already done. The unused `Hono` import was removed in commit `fbed758`, and `bun run check` / `bunx biome check .` report nothing today, so Task 7 only verifies and ticks it.
- No migration, no new npm dependency.

**Tech Stack:** Bun 1.4.4 (`Worker`, `bun:sqlite`), TypeScript strict, Hono, Drizzle, Zod 4, Next.js (`renderToString` tests), `bun test`.

**Spec:** `docs/superpowers/specs/2026-11-07-followups-batch-2.md` (H1.1–H1.3, H2.1–H2.2, H3.1–H3.3, H4.1–H4.8). It is binding, together with ADR-023, ADR-030, ADR-040, ADR-018, `docs/modules/web-dashboard.md`, `docs/modules/engineering-tasks.md` and the two follow-ups files `docs/superpowers/plans/2026-11-07-phase-11-followups.md` and `docs/superpowers/plans/2026-11-06-phase-10-followups.md`.

## Plan decisions (spec gaps)

1. **H1.1 scope.** Four reply drafts use the store, with these keys:
   - the Inbox reply composer and the Needs-you urgent card both use `reply:<messageId>`, so one draft per urgent message;
   - the code-answer edit box uses `code_answer:<codeAnswerId>`;
   - the follow-up draft card uses `followup:<id>`.
   Other textareas found in sections also lose their text on a remount, but they are not reply drafts: the engineering commit and PR text edits, New task, Register repository, project notes, commitment edits, Jira setup and the recommendation reason. They are recorded as a follow-up.
2. **H1.2 applies to every picker call.** Switch, Save as new, Reset, Rename and Delete all lock the gate and disable customise buttons while in flight. Only the calls that change the active layout's content or id flush first (switch, save-as, reset, as today), and only those abort when the flush fails.
3. **H2 sources.** These are the values recorded today:
   - `branchKept`: the cleanup step `output.outcome === "branch_kept"`.
   - `pushedNotPr`: the push_pr step `output.outcome === "pushed_not_pr"`. This sits on the push_pr row, not the cleanup row, and is trivially derivable.
   - `dirtyTree`: the cleanup step has `status === "failed"` and `output.failure === "dirty_tree"`. A successful re-cleanup overwrites that row, so a dirty tree that the user later tidied reads `false`.
   - `priorStatus` is the status the task was cancelled from. The cleanup step's own `output.priorStatus` cannot fill it: that field means "the terminal status before a failed cleanup", which equals the task's current status after a retry, and would render "Cancelled from Completed". So `priorStatus` is read from `details.from` of the task's latest `engineering.cancelled` audit row, for `cancelled` tasks only, when it is a known `EngineeringTaskStatus`. Otherwise it is `null`, and it also becomes `null` once retention prunes that audit row (`retention.auditDays`, at least 90 days).
   - `cleanup` is `null` for non-terminal tasks. For a terminal task it is `null` when none of the three sources exists.
4. **H3.1 reachability.** Today `sandbox_disabled` and `sandbox_path_too_long` end `failed` (with cleanup) on a clean tree, so a retry could never apply to them. H3.1 lists them as `needs_attention` reasons, and H3.3 expects a retry after a restart. They now always end `needs_attention`, keeping the lock, exactly like `sandbox_unavailable` (F1.4). The new `sandbox_root_masked` does the same. `repo_in_masked_path` is unchanged (`failed`).
5. **H3.1 codes.** `not_retryable` also covers "the lock is not held by this task". A degraded `sandbox` check whose detail is `run_root_masked` answers 409 `sandbox_root_masked` (plan-chosen), and any other degraded detail answers 409 `sandbox_unavailable`.
6. **H3.2 copy.** The web `REASONS.sandbox_unavailable` keeps its install instruction but now ends "…then use Try again." instead of "cancel this task and propose it again". The health hint for `sandbox` is unchanged. Retry errors use their own short sentences (Task 5).
7. **H4.1 fallbacks.** An in-memory database (`:memory:`), or an injected `vacuumInto` test seam, keeps the current inline path, because a worker's connection cannot see an in-memory database. A quick_check that times out reads `failed`; a backup that times out fails with `timeout`.
8. **H4.6 health hint.** Hints are keyed by check name today. A new `healthHint(check, detail)` returns the H4.6 hint for `sandbox` with detail `run_root_masked`, and `HEALTH_HINTS[check]` otherwise.

## Global Constraints

- **Tests never run real `claude`, `gh`, `bwrap` or `socat`.**
  - Health tests inject `which`.
  - Every test path comes from `mkdtempSync(join(tmpdir(), "syn-"))`.
  - Pure functions take placeholders such as `/home/u`, `/home/u/.config/c` and `/home/u/.local/share/synapse`.
  - H4.1 tests run the real `Worker` against a temp database file.
- **Placeholder data only:** repository `demo`, branches `main`/`stage`, Slack ids `U0PLACE`, message ids `m1`, layout names `Focus`. Never a real name, username or `/home/<realuser>` path.
- **Error bodies are `{ error: "<fixed_code>" }`.** Audit `details` hold ids, counts and codes only, never text, paths or branch names.
- **Drafts are never written to `localStorage`, `sessionStorage` or IndexedDB** (H1.1). Slack text is never persisted by the web.
- **Exact copy:**
  - layout toasts: "Couldn't save the layout" (existing `LAYOUT_SAVE_FAILED`) and "Couldn't switch the layout";
  - history badges: "Branch kept", "Pushed, no PR", "Uncommitted changes left", "Cancelled from <STATUS_LABELS[priorStatus]>";
  - Needs-you button: "Try again";
  - H4.6 reason and hint: "Set XDG_CACHE_HOME to a directory outside ~/.config and the other protected folders, then restart Synapse and try again.";
  - H4.3: "Automatic backups are off; Back up now still makes one".
- **Exact codes and values:**
  - route codes: 404 `not_found`, 409 `not_retryable`, 409 `sandbox_disabled`, 409 `sandbox_unavailable`, 409 `sandbox_root_masked`;
  - audit action: `engineering.develop_retried`;
  - develop reason: `sandbox_root_masked`;
  - `BackupFailureCode` gains `timeout`;
  - worker timeouts: backup 600 000 ms, quick_check 300 000 ms;
  - setting `retention.snapshotsDays`: integer 7–365, default 30;
  - instance prune age: 7 days.
- **CLAUDE.md rules.** Rule 2: retry-develop only re-enqueues the develop step, and every later step stays approval-gated. Rule 6: the web renders API values, and client checks only enable or disable buttons. Rules 8 and 10: no migration, no new dependency.
- **Checks stay green.** Each task ends with `bun run check` passing. Web tasks also pass `bun run --cwd apps/web build`.

## Review Focus

1. **A layout switch while a debounced save is pending and then fails.** Expect no switch, the toast "Couldn't save the layout", the gate unlocked and buttons enabled again afterwards. The old layout stays active on the server and on screen. Test in Task 1.
2. **Two drafts at once, and a send that fails.** Drafts for `reply:m1` and `reply:m2` never bleed into each other. A failed `urgentReply` (an API error) keeps the draft. A successful one clears only `reply:<id>`. An Undo on a follow-up discard keeps the draft. Tests in Task 2.
3. **Retry-develop clicked twice, or racing a cancel.** The second call is 409 `not_retryable` and exactly one develop job is enqueued. A cancel that lands between the checks and the transaction makes the transaction's re-check throw `not_retryable`, and nothing is enqueued. Test in Task 5.
4. **A stored `ops.retention.lastRun` written before this batch** (no snapshot counts). `settings.get` would throw on every read if the schema demanded the new keys. Expect it to parse, with the new counts optional. Test in Task 7.
5. **A backup worker that hangs or crashes.** Expect it to be terminated after the timeout, no `.synapse-*.tmp` left, failure `timeout` audited, and the next run to work. A worker that throws on load gives `unexpected` and never hangs the job. Test in Task 6.

---

### Task 1: Serialised layout switch that applies the server's answer (H1.2, H1.3)

**Files:**
- Modify:
  - `apps/api/src/modules/dashboard/layouts.ts`;
  - `apps/api/src/routes/dashboard-layouts.ts` (the comment only, if any);
  - `apps/web/lib/api.ts`;
  - `apps/web/lib/layout-saver.ts`;
  - `apps/web/app/components/layout/LayoutPicker.tsx`;
  - `apps/web/app/components/layout/HiddenTray.tsx`;
  - `apps/web/app/components/layout/DashboardSection.tsx`;
  - `apps/web/app/page.tsx`;
  - `docs/modules/dashboard.md` (activate row);
  - `docs/modules/web-dashboard.md` (Customise mode).
- Test:
  - `apps/api/test/routes/dashboard-layouts.test.ts`;
  - `apps/web/test/layout-saver.test.ts`;
  - `apps/web/test/customise-ui.test.tsx`;
  - `apps/web/test/api.test.ts`.

**Interfaces:**
- API: `DashboardLayoutService.activate(id: string): DashboardLayoutsResponse`, in one immediate transaction that does the check, the update, `emit("user", "activated", id)`, then `{ active, layouts }` built like `list()`. Extract a private `snapshot(rows: Row[]): DashboardLayoutsResponse` shared with `list()`. The route returns it unchanged.
- Web `api.ts`: `activateLayout(id: string, fetchImpl?): Promise<DashboardLayoutsResponse>`.
- `layout-saver.ts`:
  - `flush(): Promise<boolean>` is true when nothing was pending or in flight, or every PUT it awaited succeeded, and false when any of them failed. `onError` and `reload` behave as today.
  - `export const LAYOUT_SWITCH_FAILED = "Couldn't switch the layout"`.
  - `export type LayoutCallOutcome = "applied" | "busy" | "flush_failed" | "call_failed" | "refetch_failed"`.
  - `export interface LayoutCallDeps { gate: ReturnType<typeof createLayoutGate>; flush: () => Promise<boolean>; setBusy: (busy: boolean) => void; getLayouts: () => Promise<DashboardLayoutsResponse>; apply: (r: DashboardLayoutsResponse) => void; toast: (text: string) => void }`.
  - `export async function runLayoutCall(deps: LayoutCallDeps, op: { run: () => Promise<DashboardLayoutsResponse | undefined>; flushFirst: boolean; errorText: (e: unknown) => string }): Promise<LayoutCallOutcome>`, in this order:
    1. `gate.isLocked()` → `"busy"`, and nothing else happens.
    2. `gate.lock(); setBusy(true)`.
    3. If `flushFirst && !(await flush())` → `"flush_failed"`. The saver already toasted and reloaded, and `run` is never called.
    4. `run()` throws → `toast(errorText(e))`, then `"call_failed"`, with nothing applied.
    5. When `run` returned a response → `gate.bump(); apply(r)` → `"applied"`.
    6. Otherwise `getLayouts()` → `bump` and `apply` → `"applied"`. If that fetch throws → `"refetch_failed"`.
    7. `finally { gate.unlock(); setBusy(false) }`.
- Components gain `busy?: boolean` (default false). When true:
  - `LayoutPicker` disables every button (Switch, Rename, Delete, Save name, Cancel, Save as new, Reset to default);
  - `HiddenTray` disables Show;
  - `DashboardSection` disables every toolbar button. The collapsed-header expand is local and not a layout edit, so it stays enabled.
- `page.tsx`:
  - `const [layoutBusy, setLayoutBusy] = useState(false)`.
  - `layoutCall` is replaced by `runLayoutCall({ gate, flush: () => saver.flush(), setBusy: setLayoutBusy, getLayouts, apply: (r) => { applyLayouts(r); setLocalShown(new Set()); setLocalExpanded(new Set()); }, toast: toast.show }, op)`, followed by `await refresh()` as today.
  - Switch: `{ run: () => activateLayout(id), flushFirst: true, errorText: () => LAYOUT_SWITCH_FAILED }`.
  - Save as new: `run` creates the layout (an error propagates as is), then returns `activateLayout(made.id)`. An activate error is rethrown as `new Error(LAYOUT_SWITCH_FAILED)`. `errorText: (e) => e instanceof ApiError ? layoutErrorText(e.code) : LAYOUT_SWITCH_FAILED`.
  - Rename, Delete and Reset keep their calls, return `undefined`, and use `errorText: (e) => layoutErrorText(e instanceof ApiError ? e.code : undefined)`.
  - `busy={layoutBusy}` is passed to the three components. ⌘K "Customise dashboard" is untouched.

- [ ] **Step 1: Write the failing tests.**
  - API: `POST /:id/activate` → 200, and the body `toEqual` a following `GET` body (`active.id === focus.id`, `layouts` holds both with exactly one `isActive`). The 404 case is unchanged.
  - `layout-saver.test.ts`, with the existing fake timers and put:
    - `flush()` resolves `true` with nothing pending;
    - `true` after a pending change whose put resolves;
    - `false` when it rejects, with `onError` called once with `LAYOUT_SAVE_FAILED`.
  - `runLayoutCall`, with a real `createLayoutGate()` and spies:
    - (Review Focus 1) `flush` resolving false → `"flush_failed"`; `run`, `apply` and `getLayouts` not called; `setBusy` calls `[true, false]`; `gate.isLocked()` false afterwards;
    - `run` resolving a response `R` → `apply` called once with `R`, `getLayouts` not called;
    - `run` rejecting → `toast` called with `errorText`'s value, `apply` not called, `getLayouts` not called;
    - `run` resolving `undefined` → `getLayouts` called and applied; a `getLayouts` rejection → `"refetch_failed"` and still unlocked;
    - inside `run`, `gate.isLocked()` is true;
    - a second call started while the first is pending → `"busy"`, its `run` never called.
  - `customise-ui.test.tsx`: `LayoutPicker busy` renders every `<button` with `disabled`; `HiddenTray busy` → Show is disabled; `DashboardSection busy customising` → "Move down", "Hide", "Collapse" and "Half width" are disabled; `busy={false}` renders none disabled except the existing `isFirst`/active cases.
  - `api.test.ts`: `activateLayout` resolves the fake body unchanged.
- [ ] **Step 2: Run** `bun test apps/api/test/routes/dashboard-layouts.test.ts apps/web/test/layout-saver.test.ts apps/web/test/customise-ui.test.tsx apps/web/test/api.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** the signatures above.
  - Docs:
    - `dashboard.md`: the activate row reads "the same body as `GET /api/dashboard/layouts`".
    - `web-dashboard.md`: picker calls are serialised; the flush is awaited and a failed flush cancels the switch; the switch applies the server's answer; a failed activate toasts "Couldn't switch the layout".
    - In `phase-11-followups.md`, do not tick anything yet (Task 7 ticks).
- [ ] **Step 4: Run** `bun run check && bun run --cwd apps/web build`. Expect PASS.
- [ ] **Step 5: Commit:** `fix(dashboard): serialise layout switches and apply the activate response (H1.2, H1.3)`.

### Task 2: Reply drafts survive remounts (H1.1)

**Files:**
- Create:
  - `apps/web/lib/drafts.ts`;
  - `apps/web/app/components/ui/useDraft.ts`;
  - `apps/web/test/drafts.test.tsx`.
- Modify:
  - `apps/web/app/components/inbox/Composer.tsx`;
  - `apps/web/app/components/triage/UrgentCard.tsx`;
  - `apps/web/app/components/triage/FollowupCard.tsx`;
  - `apps/web/lib/needs-you-actions.ts`;
  - `apps/web/app/page.tsx` (the code-answer send, discard and dismiss);
  - `docs/modules/web-dashboard.md` (replace the "Customise actions can lose an unsent draft" bullet).
- Test:
  - `apps/web/test/needs-you-actions.test.ts`;
  - `apps/web/test/inbox-ui.test.tsx`.

**Interfaces:**
- `lib/drafts.ts` (no React, module-level `Map<string, string>`):
  - `export type DraftKey = \`reply:${string}\` | \`code_answer:${string}\` | \`followup:${string}\``;
  - `readDraft(key: DraftKey): string | undefined`;
  - `writeDraft(key: DraftKey, text: string): void`;
  - `clearDraft(key: DraftKey): void`;
  - `clearAllDrafts(): void` (for tests).
- `useDraft.ts`: `useDraft(key: DraftKey, initial: string): [string, (text: string) => void]`. The initial state is `readDraft(key) ?? initial`, and the setter does `setState` plus `writeDraft`.
- Components:
  - `ReplyComposer`: `useDraft(\`reply:${urgentId}\`, draft ?? "")`. "Reset to draft" calls the setter with `draft ?? ""`.
  - `CodeAnswerComposer`: `useDraft(\`code_answer:${codeAnswerId}\`, draft)`.
  - `UrgentCard`: `useDraft(\`reply:${i.messageId}\`, i.draft?.text ?? "")`.
  - `FollowupCard`: `useDraft(\`followup:${f.id}\`, f.draftText ?? "")`.
- `needs-you-actions.ts`:
  - `now` returns `Promise<boolean>` (true when `fn` resolved).
  - `urgentReply` clears `reply:<id>` on success, and `sendFollowup` clears `followup:<id>` on success.
  - `discardFollowup`'s deferred commit clears `followup:<id>` after `api.discardFollowup` resolves. An Undo never clears it.
- `page.tsx`: `sendCodeAnswerDraft` clears `code_answer:<id>` after `sendCodeAnswer` resolves, and `onDiscard` and `onDismissed` clear it too. `onDiscard` needs the id, so it uses `codeDraft?.codeAnswerId`.

- [ ] **Step 1: Write the failing tests.**
  - `drafts.test.tsx`, with `clearAllDrafts()` in `beforeEach`:
    - `writeDraft("reply:m1", "x")`, then `readDraft("reply:m1")` is `"x"` and `readDraft("reply:m2")` is undefined;
    - `clearDraft` removes it;
    - `renderToString(<Composer state={{ mode: "reply", urgentId: "m1", draft: "model text" }} onReply={noop} />)` contains `model text` with no stored draft, and contains `edited text` after `writeDraft("reply:m1", "edited text")`;
    - the same for `code_answer:c1` with `mode: "code_answer"`;
    - an `UrgentCard` for `messageId: "m1"` shows the stored `reply:m1` text;
    - a `FollowupCard` for `f1` shows `followup:f1`;
    - the source of `lib/drafts.ts` and `useDraft.ts` contains none of `localStorage`, `sessionStorage` or `indexedDB`.
  - `needs-you-actions.test.ts` (fake api):
    - (Review Focus 2) with `reply:m1` and `reply:m2` stored, `urgentReply("m1", "t")` resolving clears only `reply:m1`;
    - `requestUrgentReply` rejecting keeps `reply:m1`;
    - `sendFollowup("f1", "t")` resolving clears `followup:f1`;
    - `discardFollowup("f1")` followed by Undo, after the delay, keeps `followup:f1`;
    - without Undo, after the delay and the commit, `followup:f1` is cleared.
- [ ] **Step 2: Run** `bun test apps/web/test/drafts.test.tsx apps/web/test/needs-you-actions.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** the signatures above. Update the `web-dashboard.md` bullet: reply, code-answer and follow-up drafts survive customise actions and layout switches (memory only, lost on reload); other form fields do not.
- [ ] **Step 4: Run** `bun run check && bun run --cwd apps/web build`. Expect PASS.
- [ ] **Step 5: Commit:** `fix(web): keep reply drafts across section remounts (H1.1)`.

### Task 3: Cleanup outcomes in engineering history (H2)

**Files:**
- Modify:
  - `packages/contracts/src/engineering.ts`;
  - `apps/api/src/modules/engineering-tasks/store.ts`;
  - `apps/api/src/modules/engineering-tasks/service.ts`;
  - `apps/web/lib/engineering.ts`;
  - `apps/web/app/components/engineering/EngineeringSection.tsx`;
  - `apps/web/test/engineering-fixtures.ts` (`cleanup: null`);
  - `docs/modules/engineering-tasks.md`.
- Test:
  - `apps/api/test/modules/engineering-tasks.test.ts`;
  - `apps/api/test/routes/engineering.test.ts`;
  - `apps/web/test/engineering.test.ts`;
  - `apps/web/test/engineering-ui.test.tsx`.

**Interfaces:**
- Contracts:
  - `export interface EngineeringCleanupView { branchKept: boolean; pushedNotPr: boolean; dirtyTree: boolean; priorStatus: EngineeringTaskStatus | null }`;
  - `EngineeringTaskView.cleanup: EngineeringCleanupView | null`, which `EngineeringTaskDetail` inherits.
- `store.ts`:
  - `export function cleanupViews(tx: DbOrTx, tasks: ReadonlyArray<Pick<TaskRow, "id" | "status">>): Map<string, EngineeringCleanupView>`. It covers terminal tasks only. It runs one query on `engineeringTaskSteps` (step in `cleanup`, `push_pr`; taskId in the ids) and one on `auditEvents` (`action = 'engineering.cancelled'`, `targetRef` in the cancelled ids, newest `occurredAt` then rowid first). The values follow Plan decision 3. A task with no source is absent from the map.
  - `toView(r: TaskRow, cleanup: EngineeringCleanupView | null = null)`.
  - `detail()` passes `cleanupViews(tx, [r]).get(r.id) ?? null`.
- `service.ts`: `list()` runs `const rows = store.list(...)` and `const c = cleanupViews(db, rows)`, then maps `toView(r, c.get(r.id) ?? null)`.
- `lib/engineering.ts`: `export function cleanupBadges(c: EngineeringCleanupView | null): string[]` returns, in this order, "Branch kept", "Pushed, no PR", "Uncommitted changes left", then `` `Cancelled from ${STATUS_LABELS[c.priorStatus]}` `` when `priorStatus` is non-null. It returns `[]` for null.
- `TaskRow` renders `cleanupBadges(task.cleanup)` as `<Chip tone="neutral">` items in `.syn-eng-task-meta`, only when `isTerminal(task.status)`.

- [ ] **Step 1: Write the failing tests.**
  - API, with the module test's fixtures:
    - a task cancelled from `awaiting_approval` whose cleanup step output is `{ git: true, deleted: false, outcome: "branch_kept" }` lists `cleanup` `{ branchKept: true, pushedNotPr: false, dirtyTree: false, priorStatus: "awaiting_approval" }`;
    - a push_pr row with `outcome: "pushed_not_pr"` → `pushedNotPr: true`;
    - a cleanup row `failed` with `failure: "dirty_tree"` on a cancelled task → `dirtyTree: true`;
    - a `completed` task whose cleanup output has `priorStatus: "completed"` → `priorStatus: null`;
    - a cancelled task whose audit row was deleted → `priorStatus: null`;
    - a non-terminal task → `cleanup: null`;
    - a terminal task with no step rows and no audit row → `cleanup: null`.
  - Route: the `GET /api/engineering/tasks` JSON for a cancelled task contains no `taskBranch` value inside `cleanup`, and `Object.keys(cleanup)` is exactly the four keys.
  - Web:
    - `cleanupBadges({ branchKept: true, pushedNotPr: true, dirtyTree: true, priorStatus: "in_progress" })` equals the four strings, ending "Cancelled from In progress";
    - `cleanupBadges(null)` is `[]`;
    - a History row renders "Branch kept", and an active row with the same `cleanup` renders no badge.
- [ ] **Step 2: Run** `bun test apps/api/test/modules/engineering-tasks.test.ts apps/api/test/routes/engineering.test.ts apps/web/test/engineering.test.ts apps/web/test/engineering-ui.test.tsx`. Expect FAIL.
- [ ] **Step 3: Implement** the signatures above. In `engineering-tasks.md`, document the `cleanup` field, its sources and the audit-retention fade of `priorStatus`, and remove "A history view showing cleanup outcomes" from Deferred.
- [ ] **Step 4: Run** `bun run check && bun run --cwd apps/web build`. Expect PASS.
- [ ] **Step 5: Commit:** `feat(engineering): cleanup outcomes on history rows (H2)`.

### Task 4: `sandbox_root_masked`, and sandbox refusals that keep the task (H4.6, Plan decision 4)

**Files:**
- Modify:
  - `packages/contracts/src/ai.ts`;
  - `packages/contracts/src/engineering.ts`;
  - `apps/api/src/intelligence/engineering/develop-prompt.ts`;
  - `apps/api/src/workers/engineering/steps.ts`;
  - `apps/api/src/modules/engineering-tasks/steps.ts` (`runDevelop` catch);
  - `apps/api/src/core/health/checks.ts`;
  - `apps/api/src/modules/dashboard/health-hints.ts`;
  - `apps/api/src/modules/dashboard/service.ts`;
  - `apps/api/src/container.ts` (`sandboxCheck` deps);
  - `docs/decisions/ADR/ADR-040-sandboxed-test-commands.md`;
  - `docs/modules/engineering-tasks.md`.
- Test:
  - `apps/api/test/intelligence/develop-prompt.test.ts`;
  - `apps/api/test/workers/engineering-steps.test.ts`;
  - `apps/api/test/core/health.test.ts`;
  - `apps/api/test/modules/dashboard.test.ts`.

**Interfaces:**
- `ai.ts`:
  - `export const SANDBOX_ROOT_MASKED = "sandbox_root_masked"`;
  - `export const SANDBOX_ROOT_MASKED_HINT = "Set XDG_CACHE_HOME to a directory outside ~/.config and the other protected folders, then restart Synapse and try again."`.
- `engineering.ts`: `export const DEVELOP_RETRY_REASONS = ["sandbox_unavailable", "sandbox_disabled", "sandbox_path_too_long", "sandbox_root_masked"] as const`.
- `develop-prompt.ts`: `export function runRootMasked(runRoot: string, home: string, protectedDirs: readonly string[], roots: readonly string[] = SANDBOX_MASKED_ROOTS): boolean`. It is true when `real(runRoot)` is at or under any `sandboxDenyRead(home, protectedDirs)` entry or any of `roots`. It is pure, apart from the existing realpath of existing paths.
- Worker develop `run`: when `sandboxed`, right after the repository check, `runRootMasked(sandbox.runRoot, sandbox.home, sandbox.protectedDirs, maskedRoots)` throws `JobError({ kind: "invalid_input", message: SANDBOX_ROOT_MASKED })`. Nothing is created.
- `runDevelop` catch: these all go through `this.attention(taskId, "develop", code, { ...fp, failure: code, ...extra }, runner.runId())`, always `needs_attention` with the lock kept:
  - `sandbox_disabled`;
  - `SANDBOX_PATH_TOO_LONG`, with extra `{ hint: SANDBOX_PATH_TOO_LONG_HINT }`;
  - `SANDBOX_ROOT_MASKED`, with extra `{ hint: SANDBOX_ROOT_MASKED_HINT }`.
  `REPO_IN_MASKED_PATH` keeps `developFailed`.
- `checks.ts`: `sandboxCheck(deps: { settings; which; runRootMasked?: () => boolean })`, checked in this order:
  1. setting off → `ok`/`disabled`;
  2. missing binaries → as today;
  3. `runRootMasked?.()` → `{ status: "degraded", detail: "run_root_masked" }`;
  4. otherwise `ok`.
- `health-hints.ts`: `export function healthHint(check: string, detail: string | null): string | null`. `dashboard/service.ts` uses it instead of `HEALTH_HINTS[check]`.
- Container: `sandboxCheck({ settings, which, runRootMasked: () => runRootMasked(runRoot, home, [dataDir, backupDir], deps.sandboxMaskedRoots ?? SANDBOX_MASKED_ROOTS) })`.

- [ ] **Step 1: Write the failing tests.**
  - `develop-prompt.test.ts`:
    - `runRootMasked("/home/u/.config/c/synapse/abcd1234", "/home/u", [])` is true;
    - `("/home/u/.cache/synapse/abcd1234", "/home/u", ["/home/u/.local/share/synapse"])` is false;
    - `("/tmp/x/synapse/abcd1234", "/home/u", [])` is true;
    - the same with `roots: []` is false;
    - a run root equal to a protected dir is true.
  - `engineering-steps.test.ts`:
    - with `sandbox.runRoot = join(fx.home, ".config", "c", "synapse", "abcd1234")` and `maskedRoots: []` → task `needs_attention`, `failure` `sandbox_root_masked`, develop output `hint === SANDBOX_ROOT_MASKED_HINT`, no orchestrator request, `existsSync(runRoot)` false, lease held.
    - Update the existing tests "a tmpDir over 64 bytes refuses the run…" and "rule M's refusal surfaces as sandbox_disabled…": both now expect `needs_attention`, the lease held and no cleanup enqueued, and the `hint` assertion stays.
    - `repo_in_masked_path` still ends `failed`.
  - `health.test.ts`: `runRootMasked: () => true` with both binaries → degraded `run_root_masked`; missing `socat` plus masked → `missing: socat`; setting off → `ok`/`disabled`.
  - `dashboard.test.ts`:
    - `healthHint("sandbox", "run_root_masked") === SANDBOX_ROOT_MASKED_HINT`;
    - `healthHint("sandbox", "missing: socat") === HEALTH_HINTS.sandbox`;
    - `healthHint("unknown", null)` is null;
    - the overview issue for a degraded `run_root_masked` carries that hint.
- [ ] **Step 2: Run** `bun test apps/api/test/intelligence/develop-prompt.test.ts apps/api/test/workers/engineering-steps.test.ts apps/api/test/core/health.test.ts apps/api/test/modules/dashboard.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** the signatures above. Docs:
  - ADR-040:
    - add a Decision row "Run root inside a mask" (`sandbox_root_masked`, the hint, the health detail);
    - rewrite the Consequences "Cache directory" sentence (it no longer says rule M refuses every run);
    - note that `sandbox_disabled` and `sandbox_path_too_long` now end `needs_attention`, keeping the lock (batch 2).
  - `engineering-tasks.md`: rewrite the line-96 bullet: `sandbox_unavailable`, `sandbox_disabled`, `sandbox_path_too_long` and `sandbox_root_masked` end `needs_attention` with the lock kept, and `repo_in_masked_path` ends `failed`. Add `sandbox_root_masked` to the reason list.
- [ ] **Step 4: Run** `bun run check`. Expect PASS.
- [ ] **Step 5: Commit:** `feat(engineering): sandbox_root_masked and sandbox refusals that keep the task (H4.6)`.

### Task 5: Retry the develop step (H3)

**Files:**
- Modify:
  - `apps/api/src/modules/engineering-tasks/store.ts` (error codes);
  - `apps/api/src/modules/engineering-tasks/steps.ts`;
  - `apps/api/src/routes/engineering.ts`;
  - `apps/api/src/container.ts`;
  - `apps/web/lib/api.ts`;
  - `apps/web/lib/engineering.ts`;
  - `apps/web/lib/needs-you-actions.ts`;
  - `apps/web/app/components/triage/EngineeringCards.tsx`;
  - `apps/web/app/components/triage/NeedsYou.tsx`;
  - `docs/modules/engineering-tasks.md`.
- Test:
  - `apps/api/test/workers/engineering-steps.test.ts`;
  - `apps/api/test/routes/engineering.test.ts`;
  - `apps/web/test/engineering.test.ts`;
  - `apps/web/test/engineering-ui.test.tsx`;
  - `apps/web/test/needs-you-actions.test.ts`.

**Interfaces:**
- Consumes: `DEVELOP_RETRY_REASONS`, `SANDBOX_ROOT_MASKED_HINT` and the `run_root_masked` health detail (Task 4).
- `ENGINEERING_TASK_ERROR_CODES` gains `not_retryable`, `sandbox_disabled`, `sandbox_unavailable` and `sandbox_root_masked`, all 409 in the route `STATUS` map.
- `EngineeringStepDeps` gains `settings: Pick<SettingsService, "get">` and `sandboxHealth: HealthCheck`. In the container, `sandboxHealth: () => sandboxHealthCheck()`, where `sandboxHealthCheck` is the Task 4 `sandboxCheck(...)` value. Hoist it into a `const` used by both `HealthService` and this closure; the closure is called only after construction.
- `EngineeringStepService.retryDevelop(taskId: string): Promise<void>`, with checks in this order:
  1. The task is missing → `not_found`.
  2. Any of these → `not_retryable`: status not `needs_attention`; `currentStep !== "develop"`; `failure` not in `DEVELOP_RETRY_REASONS`; `lock.holder()?.taskId !== taskId`.
  3. `!settings.get("engineering.sandbox.enabled")` → `sandbox_disabled`.
  4. `await sandboxHealth()`, when `status !== "ok"` → `detail === "run_root_masked" ? "sandbox_root_masked" : "sandbox_unavailable"`.
  5. One immediate transaction:
     - re-read the task and re-check step 2 (else `not_retryable`);
     - `store.transition(tx, id, "in_progress", { failure: null }, ["needs_attention"])`;
     - `store.upsertStep(tx, id, "develop", "pending", { output: null, claudeRunId: null })`;
     - `this.enqueue(tx, id, "develop")` (a fresh `newId()` key);
     - `this.audit(tx, "engineering.develop_retried", id, "ok", {})`.
- Route: `POST /api/engineering/tasks/:id/retry-develop` → 200 `c.engineering.get(id)`.
- Web:
  - `api.ts`: `retryEngineeringDevelop(taskId: string, fetchImpl?): Promise<EngineeringTaskDetail>`.
  - `lib/engineering.ts`:
    - `canRetryDevelop(t: Pick<EngineeringTaskView, "status" | "failure" | "currentStep">): boolean`;
    - `REASONS.sandbox_root_masked = SANDBOX_ROOT_MASKED_HINT`;
    - `REASONS.sandbox_unavailable`: "The test sandbox could not start. Install bubblewrap and socat (sudo apt install bubblewrap socat), then use Try again.";
    - `retryDevelopErrorText(e: unknown): string`. It maps:
      - `not_retryable` to "This task can't be retried now.";
      - `sandbox_disabled` to "Turn the test sandbox on first.";
      - `sandbox_unavailable` to "The test sandbox still can't start. Install bubblewrap and socat first.";
      - `sandbox_root_masked` to "XDG_CACHE_HOME is still inside a protected folder.";
      - anything else through `engineeringErrorText`.
  - `needs-you-actions.ts`:
    - `NeedsYouHandlers.retryEngineeringDevelop(taskId: string): void`;
    - `NeedsYouApi` adds `"retryEngineeringDevelop"`;
    - `TOASTS.developRetried = "Develop step queued again"`;
    - errors go through `retryDevelopErrorText` into the action error.
  - `EngineeringAttentionCard` gains `onTryAgain: (taskId: string) => void` and renders a primary "Try again" when `canRetryDevelop(task)`. The reason Explainer and Cancel stay. `NeedsYou` passes `h.retryEngineeringDevelop`.

- [ ] **Step 1: Write the failing tests.**
  - `engineering-steps.test.ts` (inject `sandboxHealth` as a mutable stub, and the real settings): drive a task to `needs_attention`/`sandbox_unavailable` with the existing Bash tool_result case, then:
    - `retryDevelop` → the task is `in_progress` at `develop` with `failure` null, the develop step is `pending`, exactly one new `engineering.step {step: "develop"}` job is waiting, and one `engineering.develop_retried` audit has `details` `{}` (or ids only);
    - running the job with a good reply → `awaiting_approval` at `commit`.
    - (Review Focus 3) a second `retryDevelop` → `not_retryable`, and the develop job count is unchanged.
    - Setting off → `sandbox_disabled`. Stub `{ status: "degraded", detail: "missing: socat" }` → `sandbox_unavailable`. Stub `run_root_masked` → `sandbox_root_masked`. In each case the task stays `needs_attention`.
    - (Review Focus 3) a stub `sandboxHealth` that cancels the task before resolving → `not_retryable` and no job enqueued.
    - A `needs_attention`/`dirty_tree` task → `not_retryable`.
  - Routes: an unknown id → 404 `{ error: "not_found" }`; a `planned` task → 409 `{ error: "not_retryable" }`.
  - Web:
    - `canRetryDevelop` is true for each of the four reasons at `develop`, and false for `unsafe_change`, for another step, and for status `failed`;
    - `retryDevelopErrorText(new ApiError("x", 409, "sandbox_disabled"))` is the sentence above;
    - the attention card for `sandbox_unavailable` at `develop` shows "Try again" and "Cancel task", and for `checks_failing` at `merge_pr` shows no "Try again";
    - `retryEngineeringDevelop("t1")` rejecting with `not_retryable` sets the action error to "This task can't be retried now.", and resolving toasts `developRetried`.
- [ ] **Step 2: Run** `bun test apps/api/test/workers/engineering-steps.test.ts apps/api/test/routes/engineering.test.ts apps/web/test`. Expect FAIL.
- [ ] **Step 3: Implement** the signatures above. In `engineering-tasks.md`, add the route row, the codes to the error list and a "Retry develop" bullet (H3.1, plus H3.3's note that `sandbox_path_too_long` needs a shorter `XDG_CACHE_HOME` and a restart first).
- [ ] **Step 4: Run** `bun run check && bun run --cwd apps/web build`. Expect PASS.
- [ ] **Step 5: Commit:** `feat(engineering): retry the develop step after a sandbox refusal (H3)`.

### Task 6: Backups and `quick_check` in a worker; the backup tick at startup (H4.1, H4.2)

**Files:**
- Create:
  - `apps/api/src/core/ops/db-worker.ts` (worker entry);
  - `apps/api/src/core/ops/db-task.ts`;
  - `apps/api/test/fixtures/hang-db-worker.ts`;
  - `apps/api/test/fixtures/crash-db-worker.ts`.
- Modify:
  - `packages/contracts/src/runtime.ts`;
  - `apps/api/src/core/ops/backup.ts`;
  - `apps/api/src/core/ops/integrity.ts`;
  - `apps/api/src/core/ops/retention.ts` (`await` the check);
  - `apps/api/src/workers/ops.ts`;
  - `apps/api/src/core/scheduler/scheduler.ts`;
  - `apps/api/src/main.ts`;
  - `apps/api/src/container.ts`;
  - `docs/architecture/runtime-design.md`;
  - `docs/architecture/database-design.md`;
  - `docs/architecture/module-boundaries.md` (the `ops` row).
- Test:
  - `apps/api/test/core/ops-backup.test.ts`;
  - `apps/api/test/core/ops-retention.test.ts`;
  - `apps/api/test/core/ops-runtime.test.ts`;
  - `apps/api/test/workers/ops-jobs.test.ts`;
  - `apps/api/test/core/scheduler.test.ts`;
  - `apps/api/test/integration/run-root.test.ts` (the main.ts order check).

**Interfaces:**
- `runtime.ts`: `BackupFailureCode` gains `"timeout"`.
- `db-task.ts`:
  - `export type DbTask = { op: "backup"; dbPath: string; target: string } | { op: "quick_check"; dbPath: string }`;
  - `export type DbTaskResult = { ok: true } | { ok: false; code: "vacuum_failed" | "integrity_failed" | "check_failed" | "timeout" | "worker_failed"; cause?: string }`;
  - `export const BACKUP_WORKER_TIMEOUT_MS = 600_000`, `QUICK_CHECK_WORKER_TIMEOUT_MS = 300_000`;
  - `export function runDbTask(task: DbTask, opts: { timeoutMs: number; url?: URL }): Promise<DbTaskResult>`. It creates `new Worker(opts.url ?? new URL("./db-worker.ts", import.meta.url))`, posts `task` and resolves with the first message. A worker `error` event (or `close` before a message) resolves `worker_failed`. The timer calls `worker.terminate()` and resolves `timeout`. The worker is always terminated after it settles. It never rejects.
- `db-worker.ts`:
  - opens `new Database(dbPath, { readonly: true })` and sets `PRAGMA busy_timeout = 5000`;
  - `backup` runs `VACUUM INTO ?` (failure → `vacuum_failed`, with `cause` only when the error `code` matches `/^[A-Z_]{2,32}$/`), then `pragma integrity_check` on a read-only open of `target`, which must be exactly one row `ok` (else `integrity_failed`);
  - `quick_check` gives `{ ok: true }` for exactly one row `ok`, else `check_failed`;
  - it closes every handle, posts one message, and never logs paths or messages.
- `BackupService`:
  - `run(keep: number): Promise<BackupResult>` (still never throws, audits as today);
  - `BackupServiceDeps.worker?: { url?: URL; timeoutMs?: number }`.
  - In `attempt`, when `vacuumInto` is injected or `dbPath === ":memory:"`, the vacuum and `integrityOk` run inline as today. Otherwise `runDbTask({ op: "backup", dbPath, target: tmp }, { timeoutMs: worker?.timeoutMs ?? BACKUP_WORKER_TIMEOUT_MS, url: worker?.url })` runs, and a result that is not ok throws `new Failure(code === "worker_failed" || code === "check_failed" ? "unexpected" : code, cause)`. The existing `catch` removes `tmp`.
  - Names, the space check, keep-N, link and prune are unchanged.
- `DatabaseIntegrity`:
  - `constructor(sqlite: Database, clock: Clock, opts: { dbPath?: string; worker?: { url?: URL; timeoutMs?: number } } = {})`;
  - `check(): Promise<"ok" | "failed">`. Without `dbPath`, or with `":memory:"`, it runs inline as today. Otherwise it uses `runDbTask({ op: "quick_check", dbPath }, …)`, where `ok` gives `"ok"` and anything else (`timeout` included) gives `"failed"`. It records `latest` as today.
- `RetentionService.run` does `const quickCheck = await this.d.integrity.check()`.
- `workers/ops.ts`:
  - `runBackupTick(deps): Promise<…>` (same shape), and the handler awaits both paths.
  - `BACKUP_TIMEOUT_MS` becomes `BACKUP_WORKER_TIMEOUT_MS + 60_000`, so the handler outlives the worker's own timeout.
- `SchedulerService.runNow(name: string): boolean` sets `nextRunAt = now` for an enabled schedule of that name in one immediate transaction. It returns false when there is no such enabled row.
- `main.ts`:
  - `void c.integrity.check()` replaces the synchronous call;
  - right before the first `tick();`, call `c.scheduler.runNow(OPS_BACKUP_JOB)`, so that tick enqueues the daily backup tick (coalesced, and the handler's `dailyDue` decides);
  - import `OPS_BACKUP_JOB` from `./workers/ops`.
- Container: `new DatabaseIntegrity(sqlite, clock, { dbPath: config.dbPath })`.

- [ ] **Step 1: Write the failing tests.**
  - `ops-backup.test.ts`:
    - the existing success test (no `vacuumInto`) now goes through the real worker. `await s.run(7)` gives a 0600 file whose `sentinel` row reads back.
    - Add `await` to every existing `run` call.
    - (Review Focus 5) `worker: { url: new URL("../fixtures/hang-db-worker.ts", import.meta.url), timeoutMs: 100 }` → `{ ok: false, failure: "timeout" }`; `readdirSync(dir)` has no `.tmp`; the audit details are `{ code: "timeout" }`. A following `await svc().run(7)` succeeds.
    - `crash-db-worker.ts` (throws at top level) → `failure: "unexpected"`, resolved well within the test timeout.
    - The fixtures are a few lines: one ignores messages, the other `throw new Error("boom")` on load.
  - `ops-retention.test.ts`:
    - `await new DatabaseIntegrity(sqlite, clock, { dbPath: <temp db> }).check()` is `"ok"` through the worker;
    - with the hang fixture and `timeoutMs: 100` it is `"failed"`, and `last()?.result` is `"failed"`;
    - the existing stub and throwing-sqlite tests `await check()` with no `dbPath` (inline).
  - `ops-runtime.test.ts` and `ops-jobs.test.ts`: `await` the backup call and the tick.
  - `scheduler.test.ts`:
    - a non-coalesced interval-900 schedule, after one `tick()` (1 job), then `runNow(name)` → true, and the next `tick()` enqueues 1;
    - `runNow("missing")` → false;
    - a disabled schedule → false.
  - `run-root.test.ts`: in `main.ts`, `runNow(OPS_BACKUP_JOB)` appears after `Bun.serve(` and before the first `tick();` (the call, not the `const tick` definition).
- [ ] **Step 2: Run** `bun test apps/api/test/core/ops-backup.test.ts apps/api/test/core/ops-retention.test.ts apps/api/test/core/ops-runtime.test.ts apps/api/test/workers/ops-jobs.test.ts apps/api/test/core/scheduler.test.ts apps/api/test/integration/run-root.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** the signatures above. Docs:
  - `runtime-design.md`:
    - replace the "run synchronously on the API thread" bullet with the worker, the read-only connection, the timeouts and `timeout`;
    - startup now enqueues the daily tick once after bind;
    - the database check row: quick_check runs in a worker.
  - `database-design.md`, backups paragraph: the worker. Also update `module-boundaries.md` row `ops` if it says "synchronously".
- [ ] **Step 4: Run** `bun run check`. Expect PASS.
- [ ] **Step 5: Commit:** `perf(ops): backups and quick_check in a worker; backup tick at startup (H4.1, H4.2)`.

### Task 7: Runtime polish, prune old run roots, and the follow-ups (H4.3, H4.4, H4.5, H4.7, H4.8)

**Files:**
- Modify:
  - `packages/contracts/src/runtime.ts`;
  - `apps/api/src/core/ops/retention.ts`;
  - `apps/api/src/core/config/settings.ts`;
  - `apps/api/src/core/config/config.ts`;
  - `apps/api/src/workers/engineering/steps.ts`;
  - `apps/api/src/main.ts`;
  - `apps/web/lib/api.ts` (`OpsSettingsDto`);
  - `apps/web/app/components/system/RuntimePanel.tsx`;
  - `docs/architecture/runtime-design.md`;
  - `docs/architecture/database-design.md`;
  - `docs/decisions/ADR/ADR-040-sandboxed-test-commands.md` (the pruning sentence);
  - `docs/modules/engineering-tasks.md`;
  - `docs/modules/web-dashboard.md`;
  - `docs/superpowers/plans/2026-11-07-phase-11-followups.md`;
  - `docs/superpowers/plans/2026-11-06-phase-10-followups.md`.
- Test:
  - `apps/api/test/core/ops-retention.test.ts`;
  - `apps/api/test/routes/settings.test.ts`;
  - `apps/api/test/core/config.test.ts`;
  - `apps/api/test/integration/run-root.test.ts`;
  - `apps/web/test/runtime-ui.test.tsx`.

**Interfaces:**
- `retentionSummarySchema` gains `quotaSnapshots: z.number().int().optional()` and `authSnapshots: z.number().int().optional()`. They are optional so an older stored `ops.retention.lastRun` still parses.
- Settings: `"retention.snapshotsDays": z.number().int().min(7).max(365).default(30)`, appended to `USER_EDITABLE_SETTINGS`. `OpsSettingsDto` gains it.
- `RetentionService.run` adds two `prune` calls before the checkpoint, with cutoff `retention.snapshotsDays`:
  - `select id from quota_snapshots where observed_at < ? and id <> (select id from quota_snapshots order by observed_at desc, rowid desc limit 1) limit ?` → `delete from quota_snapshots where id in …`;
  - the same for `auth_snapshots`.
  Both counts go into the summary and the `ops.retention_ran` audit details.
- `RuntimePanel`:
  - when `settings?.["ops.backup.enabled"] === false`, render `<p className="syn-empty">Automatic backups are off; Back up now still makes one</p>` under the Backups head;
  - `NUMBERS` gains `{ key: "retention.snapshotsDays", label: "Keep quota and login snapshots (days)", min: 7, max: 365 }`.
- `config.ts`: `loadConfig` sets `dbPath` to `p === ":memory:" ? p : resolve(p)`, where `p` is `env.SYNAPSE_DB_PATH || defaultDbPath(env)` and `resolve` uses the process cwd.
- `workers/engineering/steps.ts`:
  - `export const INSTANCE_ROOT_MAX_AGE_MS = 7 * 86_400_000`;
  - `export function pruneInstanceRoots(base: string, keepRoot: string, opts: { nowMs?: number; maxAgeMs?: number } = {}): { removed: number; kept: number }`. Candidates are entries of `base` named `/^[0-9a-f]{8}$/` other than `basename(keepRoot)`. A candidate is removed (`rmSync` recursive) only when `lstat` shows a real directory (not a symlink) owned by this uid, and the newest `lstat` mtime of the directory and everything inside it is older than `maxAgeMs`. The walk never follows symlinks; a symlink's own mtime counts. Every other candidate counts as `kept`. Errors are swallowed per entry (counted as kept). A missing `base` gives `{ removed: 0, kept: 0 }`.
- `main.ts`, right after `sweepRunScratch(c.runRoot)`: `const pruned = pruneInstanceRoots(dirname(c.runRoot), c.runRoot)`, then the one fixed line `` console.log(`engineering.step: old run roots removed=${pruned.removed} kept=${pruned.kept}`) ``.

- [ ] **Step 1: Write the failing tests.**
  - `ops-retention.test.ts`:
    - quota snapshots at now−40 d, now−40 d and now−1 d, with auth snapshots at now−40 d and now−39 d. A run deletes 2 quota rows and 1 auth row (the newest auth row is kept although it is old). The summary has `quotaSnapshots: 2, authSnapshots: 1`, and the audit details carry both.
    - A table with one old row keeps it.
    - (Review Focus 4) `settings.set("ops.retention.lastRun", <summary without the two keys>)`, then `settings.get("ops.retention.lastRun")`, does not throw.
  - `settings.test.ts`: `GET` includes `"retention.snapshotsDays": 30`; `PUT 6` → 400 `invalid_setting`; `PUT 60` → 200.
  - `config.test.ts`:
    - `loadConfig({ HOME: "/home/u", SYNAPSE_DB_PATH: "data/t.db" }).dbPath === resolve(process.cwd(), "data/t.db")`;
    - `":memory:"` is unchanged;
    - `"/home/u/x.db"` is unchanged.
  - `run-root.test.ts` (H4.7), in a temp `base`:
    - `aaaaaaaa/r/x/f`, with every entry `utimesSync` to 8 days ago → removed;
    - `bbbbbbbb`, old with one file touched now → kept;
    - the keep root, old → untouched and not counted;
    - `cccccccc`, a symlink to an old dir outside `base` → kept, and its target still exists;
    - `dddddddd`, a regular file → kept;
    - `old-dir` (not hex) → untouched and not counted.
    The result is `{ removed: 1, kept: 3 }`. A missing base gives `{ removed: 0, kept: 0 }`. The `main.ts` source has `pruneInstanceRoots(` after `sweepRunScratch(c.runRoot)`.
  - `runtime-ui.test.tsx`: with `"ops.backup.enabled": false` the panel contains the H4.3 sentence, and with `true` it does not; the snapshots input renders.
- [ ] **Step 2: Run** `bun test apps/api/test/core/ops-retention.test.ts apps/api/test/routes/settings.test.ts apps/api/test/core/config.test.ts apps/api/test/integration/run-root.test.ts apps/web/test/runtime-ui.test.tsx`. Expect FAIL.
- [ ] **Step 3: Implement** the signatures above.
- [ ] **Step 4: H4.8.** Run `bunx --bun biome check .` and `grep -rn 'import { Hono } from "hono"' apps/api/test`. Expect no diagnostic and no match: the import was removed in `fbed758`. Remove any unused import that appears; otherwise change nothing.
- [ ] **Step 5: Docs and follow-ups.**
  - `runtime-design.md` and `database-design.md`:
    - snapshot retention, keeping the newest row of each table, with the setting row `retention.snapshotsDays` 30 (7–365);
    - remove "`quota_snapshots` and `auth_snapshots` are not pruned";
    - relative `SYNAPSE_DB_PATH` is resolved at load;
    - the Runtime panel note.
  - ADR-040 and `engineering-tasks.md`: old instance roots are pruned at start (8-hex real directories, not this instance's, nothing modified in 7 days).
  - `phase-11-followups.md`, mark done in batch 2:
    - the synchronous `VACUUM INTO`/`quick_check`;
    - the missed backup at startup;
    - the manual-backup note;
    - snapshot pruning;
    - the failed `getLayouts` after a switch;
    - the edit between flush and lock;
    - the lost composer draft (note decision 1's scope).
    Add a new item: other form fields (engineering text edits, New task, Register repository, project notes, commitment edits, Jira setup, recommendation reason) still lose text on a remount.
  - `phase-10-followups.md`, mark done in batch 2:
    - the history view;
    - retry after `sandbox_unavailable` (plus the three other reasons);
    - relative `SYNAPSE_DB_PATH`;
    - `XDG_CACHE_HOME` inside a mask (`sandbox_root_masked`);
    - old instance directories;
    - the unused Hono import ("already removed in the batch-1 final fix").
    Add a new item: `priorStatus` on history rows fades when retention prunes the cancel audit row.
- [ ] **Step 6: Run** `bun run check && bun run --cwd apps/web build`. Expect PASS.
- [ ] **Step 7: Commit:** `feat(ops): snapshot retention, absolute db path, run-root pruning and the backups-off note (H4.3-H4.8)`.

## File overlap between tasks

- **Tasks 1 and 2** both touch `apps/web/app/page.tsx` and `docs/modules/web-dashboard.md`. Run them one after the other.
- **Tasks 3 and 5** touch `apps/web/lib/engineering.ts`, `docs/modules/engineering-tasks.md` and `apps/web/test/engineering*.ts`.
- **Tasks 4 and 5** touch `apps/api/src/modules/engineering-tasks/steps.ts`, `engineering-steps.test.ts` and `container.ts`. Task 5 depends on Task 4.
- **Tasks 6 and 7** touch `retention.ts`, `main.ts`, `run-root.test.ts` and `runtime-design.md`. Task 7 also touches `workers/engineering/steps.ts`, which Task 4 changed.
- The independent pairs are web Tasks 1–2 against API Tasks 4 and 6.
