# Phase 11: Dashboard Customisation and Runtime Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Part D lets the user reorder, hide, collapse and resize the dashboard sections and save named layouts in the database. Part R makes the runtime survive crashes, restarts, a full disk and mistakes: private data files, verified local backups, a CLI-only restore, operational retention, local monitoring, hardened service units and a graceful shutdown.

**Architecture:**
- **Part D:**
  - The `dashboard` module gains a pure `normaliseLayout` and a `DashboardLayoutService` over the new `dashboard_layouts` table (migration 0021), behind `routes/dashboard-layouts.ts`.
  - The web renders the page's sections from the active layout through one `DashboardSection` wrapper. Pure helpers in `lib/layout.ts` drive customise mode, and a debounced saver in `lib/layout-saver.ts` sends each change.
- **Part R:**
  - A new `core/ops` area holds `daily.ts`, `backup.ts`, `integrity.ts`, `retention.ts` and `runtime.ts`. `workers/ops.ts` wires the jobs `ops.backup` and `ops.retention`, and `routes/system.ts` serves `/api/system/*`.
  - `infrastructure/private-files.ts` (R1) and `core/system/shutdown.ts` (R6) are called from `main.ts`.
  - The restore CLI is `scripts/ops/restore.ts`, and the read-only status script is `scripts/setup/service-status.ts`.
- No AI runs, no external writes, no new runtime dependency.

**Tech Stack:** Bun 1.4.4, TypeScript strict, Hono, bun:sqlite + Drizzle (generated migrations), Zod 4, Next.js 16 (`renderToString` tests), `bun test`.

**Spec:** `docs/superpowers/specs/2026-11-07-phase-11-dashboard-runtime.md` (D1–D5, R1–R7, Out of scope, Tests). This spec is the binding authority, together with ADR-023, ADR-006/007, ADR-018, `docs/modules/web-dashboard.md` and `docs/modules/dashboard.md`.

## Global Constraints

- **Tests touch temp dirs and temp files only.**
  - Use `mkdtempSync(join(tmpdir(), "syn-"))` for every path a test writes, and file databases from `openDatabase` + `runMigrations` in that dir.
  - Never touch the real `~/.local/share/synapse`, `~/.config/systemd`, the real API port or the repository tree.
  - In-memory containers resolve the backup dir to `join(scratchDir, "backups")` (the `claudeProjectsDir` pattern).
- **Never run `systemctl`, `loginctl`, `journalctl`, real `claude` or real `gh` in a test.**
  - Commands go through an injected runner stub (`run` in `ContainerDeps`, `EnvDeps.run`, `StatusDeps.run`).
  - Containers in tests keep the existing throwing `fakeProvider` and `run: async () => "Linger=no"`.
- **Placeholder data only.** Use layout names such as `Focus` and `Default`, and backup names such as `synapse-20261107-030000.db`. Use the sentinel `SENTINEL-ROW-7f3a` in seeded rows, so a test can prove that no output prints row content.
- **Fixed codes and ids only.**
  - Audit `details`, event payloads, log lines and API error bodies hold ids, counts, file names, byte sizes and fixed codes.
  - They never hold layout names (user text), row content, paths outside the data dir, or journal text.
  - Every API error body is `{ error: "<fixed_code>" }`.
- **CLAUDE.md rules.**
  - Rule 6: the web renders what the API returns, and normalisation is backend-only.
  - Rule 8: migration `0021_*` only.
  - Rule 10: no new runtime dependency (`node:fs` `statfsSync`, `bun:sqlite`, `drizzle-orm/migrator` are already available).
  - Restore and unit installation are user-run commands, listed under "Ask the user for approval".
- **Migration.** Generate it from `packages/database` with `bunx --bun drizzle-kit generate --name dashboard_layouts`, after confirming that the latest is `0020_claude_activity_code_answers.sql`. Commit the SQL as generated, and never edit an applied migration.
- **Health statuses are `ok | degraded | down`** (`packages/contracts/src/health.ts`). The spec's "failing" maps to `down`.
- **Checks stay green.** Each task ends with `bun run check` passing. Web tasks also pass `bun run --cwd apps/web build`.
- **Exact copy from the spec:**
  - toast: "Couldn't save the layout";
  - palette action: "Customise dashboard";
  - header toggle: "Customise";
  - tray heading: "Hidden sections";
  - file-permissions hint: "Synapse's data files are readable by other users; run chmod 700 on the data directory";
  - restore success line: "restored; start the API to apply any newer migrations".
- **Exact values from the spec:**
  - layouts: name 1–40 characters, at most 10, debounce 500 ms, pairing from 1100 px;
  - backups: `ops.backup.hour` 3, `keep` 7, space floor 2 × db + 1 GiB, file name `synapse-YYYYMMDD-HHMMSS.db`, dir mode `0700`, file mode `0600`;
  - backup health: 36 h without a backup, after 24 h uptime;
  - disk: warn at 5 GiB, `down` below 1 GiB;
  - retention: 30/30/7/365/90 days, batches of 500;
  - units: `StartLimitIntervalSec=300`, `StartLimitBurst=5`, `TimeoutStopSec=30`, `UMask=0077`, `NoNewPrivileges=yes`;
  - shutdown: worker grace 10 s.

## Review Focus

1. **A live refresh while a layout edit is pending.** The user's own PUT publishes `dashboard.layout_changed`, which triggers `refresh()`. A refresh that lands while an edit is debounced or in flight must not overwrite the local layout, so sections never jump back. `refresh()` applies the fetched layout only when `saver.isBusy()` is false. Test in Task 3.
2. **A stored layout row that is corrupt or not parseable.** This covers a hand-edited row, `version: 2`, a non-object, or a `sections` value that is not an array. `GET /api/dashboard/layouts` must not 500: `normaliseLayout(unknown)` returns the default layout for anything that fails the input schema. Test in Task 2.
3. **A backup dir that holds other files**, or that is the data dir itself. Pruning deletes only names matching `^synapse-\d{8}-\d{6}\.db$`. It never touches `synapse.db`, `synapse.db.before-restore-*`, `synapse-notes.db` or `other.db`. Test in Task 5.
4. **Restore over a live database whose `-wal` holds committed but uncheckpointed rows.** The set-aside copy must keep those rows, and the restored database must not pick up the old WAL. Restore checkpoints (`TRUNCATE`) before moving, and moves `-wal`/`-shm` away before copying in. Test in Task 6.
5. **The disk filling up during `VACUUM INTO`.** No half-written file may be left, and none may be named `synapse-*.db`. The tmp file is removed, the failure is audited as `vacuum_failed`, and `backup` health turns degraded. Test in Task 5.

---

### Task 1: Contracts, migration 0021, settings and backup-dir config

**Files:**
- Create:
  - `packages/contracts/src/dashboard-layout.ts`;
  - `packages/contracts/src/runtime.ts`;
  - `packages/contracts/test/dashboard-layout.test.ts`;
  - `packages/database/test/schema-phase11.test.ts`.
- Modify:
  - `packages/contracts/src/index.ts` (exports);
  - `packages/contracts/src/events.ts` and `apps/web/lib/live-events.ts` (mirror);
  - `packages/database/src/schema/platform.ts`;
  - `apps/api/src/core/config/settings.ts`;
  - `apps/api/src/core/config/config.ts`;
  - `apps/api/test/core/config.test.ts`;
  - `apps/api/test/routes/settings.test.ts`;
  - `apps/web/lib/api.ts` (`OpsSettingsDto`, `SettingsDto`).
- Generated: `packages/database/migrations/0021_dashboard_layouts.sql`, plus its snapshot and journal entry.

**Interfaces:**
- Produces from `dashboard-layout.ts`:
  - `DASHBOARD_SECTION_IDS = ["triage","running","inbox","commitments","jira","projects","engineering","people","system"] as const`, with `type DashboardSectionId`. These are every `<section id>` in `apps/web/app/page.tsx` except `overview`.
  - `sectionWidthSchema` (`"full" | "half"`).
  - `dashboardLayoutSchema`: strict, `{ version: z.literal(1), sections: z.array(z.strictObject({ id: z.enum(DASHBOARD_SECTION_IDS), visible: z.boolean(), collapsed: z.boolean(), width: sectionWidthSchema })) }`, with `type DashboardLayout`.
  - `dashboardLayoutInputSchema`: the same shape with `id: z.string().min(1).max(40)` and `sections.max(50)`. Unknown ids pass it and are dropped by normalisation.
  - `layoutNameSchema = z.string().trim().min(1).max(40)`.
  - `DEFAULT_DASHBOARD_LAYOUT: DashboardLayout`: the ids in the order above, all visible and expanded, `triage` and `running` `half`, the rest `full` (D3).
  - `DashboardLayoutView { id; name; isActive: boolean; layout: DashboardLayout; updatedAt }`, `DashboardLayoutSummary { id; name; isActive; updatedAt }`, `DashboardLayoutsResponse { active: DashboardLayoutView; layouts: DashboardLayoutSummary[] }`.
  - `DashboardLayoutErrorCode = "name_taken" | "limit_reached" | "active_layout" | "last_layout" | "not_found" | "invalid_layout" | "invalid_name"`.
  - `MAX_DASHBOARD_LAYOUTS = 10`.
- Produces from `runtime.ts`:
  - `BackupEntry { name; bytes: number; createdAt: string }`;
  - `BackupFailureCode = "insufficient_space" | "vacuum_failed" | "integrity_failed" | "target_exists" | "dir_unavailable" | "unexpected"`;
  - `retentionSummarySchema` (strict), with `type RetentionSummary = { at: string; date: string; jobs: number; notifications: number; events: number; audit: number; claudeRunsCompacted: number; quickCheck: "ok" | "failed" }`;
  - `RuntimeView { startedAt; uptimeSeconds; version: string | null; memoryRssBytes; dbBytes; walBytes; dataDirFreeBytes: number | null; lastBackup: { name; createdAt } | null; backupCount; queue: { pending; running; retry; needsAttention; oldestPendingAgeSeconds: number | null }; retention: RetentionSummary | null }`.
- Produces the event `dashboard.layout_changed { layoutId: string }`.
- Produces the Drizzle table `dashboardLayouts` (D1): `id`, `name` text not null, `is_active` bool not null default false, `layout` json not null, `created_at`, `updated_at`. Indexes:
  - `dashboard_layouts_name_uq`: unique on `lower(name)`;
  - `dashboard_layouts_active_uq`: unique on `(1)` `where is_active = 1`, in the same style as `away_sessions_open_uq`.
- Produces settings (R7), each with its exact bounds and default:
  - `ops.backup.enabled` (true);
  - `ops.backup.hour` (int 0–23, 3);
  - `ops.backup.keep` (int 1–60, 7);
  - `ops.disk.warnFreeGiB` (int 1–100, 5);
  - `retention.jobsDays` (int 7–365, 30);
  - `retention.notificationsDays` (int 7–365, 30);
  - `retention.claudeRunsDays` (int 14–730, 90);
  - `retention.auditDays` (int 90–3650, 365).
  All 8 are appended to `USER_EDITABLE_SETTINGS`; update its doc comment. Also produces the internal keys, which are not editable:
  - `ops.backup.dir` (`z.string().startsWith("/").nullable().default(null)`);
  - `ops.backup.lastRunDate` (string | null);
  - `ops.retention.lastRun` (`retentionSummarySchema.nullable().default(null)`).
- Produces from `config.ts`:
  - `AppConfig.backupDir: string | null`, from env `SYNAPSE_BACKUP_DIR`;
  - `REPO_ROOT = resolve(import.meta.dir, "../../../../..")`;
  - `checkBackupDir(dir: string, repoRoot = REPO_ROOT): "ok" | "not_absolute" | "inside_repo"`. It compares with `path.relative`, after `realpathSync` when the path exists. `loadConfig` throws `"SYNAPSE_BACKUP_DIR must be an absolute path outside the repository"` on anything but `ok`.
- Produces in `apps/web/lib/api.ts`: `OpsSettingsDto` (the 8 keys) and `SettingsDto = ClaudeSettingsDto & OpsSettingsDto`. `getSettings`/`putSettings` use `SettingsDto`, and `ClaudeSettings` keeps compiling against the superset.

- [ ] **Step 1: Write the failing tests.**
  - Contracts:
    - `DEFAULT_DASHBOARD_LAYOUT.sections.map(s => s.id)` equals `DASHBOARD_SECTION_IDS`, and the widths are `half, half, full ×7`;
    - `dashboardLayoutSchema` rejects an extra key, `width: "third"`, `version: 2` and `id: "overview"`;
    - `dashboardLayoutInputSchema` accepts `id: "x-unknown"`;
    - `layoutNameSchema` rejects `""`, `"   "` and 41 characters, and accepts `" Focus "` → `"Focus"`.
  - Schema:
    - 0021 applies on a fresh temp DB;
    - two rows with `is_active = 1` violate `dashboard_layouts_active_uq`, and two inactive rows coexist;
    - `Focus` and `focus` violate `dashboard_layouts_name_uq`.
  - Settings:
    - the defaults read back as R7;
    - `ops.backup.hour = 24` and `retention.auditDays = 89` throw;
    - `PUT /api/settings {"ops.backup.keep": 0}` → 400 `invalid_setting`;
    - `PUT {"ops.backup.dir": "/tmp/x"}` → 400 (not editable);
    - `PUT {"ops.backup.lastRunDate": "2026-11-07"}` → 400;
    - `GET` includes `ops.backup.enabled: true`.
  - Config:
    - `SYNAPSE_BACKUP_DIR=rel/dir` throws;
    - `SYNAPSE_BACKUP_DIR=${REPO_ROOT}/backups` throws;
    - a temp dir is accepted as `backupDir`;
    - unset → `null`.
  - `apps/web/test/live-events.test.ts` passes with `dashboard.layout_changed` mirrored.
- [ ] **Step 2: Run** `bun test packages apps/api/test/core/config.test.ts apps/api/test/routes/settings.test.ts apps/web/test/live-events.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement**, and generate the migration with the Global Constraints command.
- [ ] **Step 4: Run** `bun run check`. Expect PASS.
- [ ] **Step 5: Commit:** `feat(11): contracts, settings and migration 0021 for dashboard layouts and runtime`.

### Task 2: Layout normalisation, `DashboardLayoutService` and the layouts API

**Files:**
- Create:
  - `apps/api/src/modules/dashboard/layout.ts` (pure);
  - `apps/api/src/modules/dashboard/layouts.ts`;
  - `apps/api/src/routes/dashboard-layouts.ts`;
  - `apps/api/test/modules/dashboard-layout.test.ts`;
  - `apps/api/test/routes/dashboard-layouts.test.ts`.
- Modify:
  - `apps/api/src/container.ts` (`dashboardLayouts: DashboardLayoutService`);
  - `apps/api/src/app.ts` (mount the routes).

**Interfaces:**
- Consumes: Task 1's layout contracts, `dashboardLayouts` and the event.
- Produces:
  - `normaliseLayout(input: unknown): DashboardLayout`:
    - anything failing `dashboardLayoutInputSchema` → a deep copy of `DEFAULT_DASHBOARD_LAYOUT` (Review Focus 2);
    - otherwise unknown ids are dropped, and duplicates keep their first occurrence;
    - missing ids are appended in registry order with their default (visible, expanded, default width);
    - `triage` is forced to `visible: true, collapsed: false`.
  - `class LayoutError extends Error { constructor(readonly code: Exclude<DashboardLayoutErrorCode, "invalid_layout" | "invalid_name">) }`.
  - `DashboardLayoutServiceDeps { db; clock; audit: Pick<AuditLogger,"record">; events: Pick<EventPublisher,"publish"> }`.
  - `class DashboardLayoutService`, with these methods:
    - `list(): DashboardLayoutsResponse`. It seeds "Default" (active, default layout) in one immediate transaction when the table is empty. If rows exist but none is active, it activates the most recently updated one.
    - `create(name: string, fromId?: string): DashboardLayoutView`. It copies `fromId` or the active layout, and throws `limit_reached` at 10 rows, `name_taken` (compared case-insensitively) and `not_found` (unknown `fromId`).
    - `update(id: string, patch: { name?: string; layout?: unknown }): DashboardLayoutView`. It stores `normaliseLayout(layout)`.
    - `activate(id: string): DashboardLayoutView`. It clears the old active row and sets the new one in one immediate transaction.
    - `reset(id: string): DashboardLayoutView`. It replaces the layout with the default and keeps the name.
    - `remove(id: string): void`. It checks `last_layout` (count = 1) first, then `active_layout`, then `not_found`.
  - Every write runs in one immediate transaction. It audits `dashboard.layout_{created,updated,activated,reset,deleted}` (actor `user`, or `system` for the seed; module `dashboard`; details `{layoutId}` only) and publishes `dashboard.layout_changed {layoutId}` (aggregateType `dashboard_layout`).
  - `dashboardLayoutRoutes(c: Container): Hono`, with the D4 endpoints:
    - `POST` create → 201 `DashboardLayoutView`;
    - `PUT`, activate and reset → 200 `DashboardLayoutView`;
    - `DELETE` → 204.
    - Bodies are parsed with Zod. A bad name → 400 `invalid_name`, and a bad layout shape → 400 `invalid_layout`. `LayoutError` maps `not_found` → 404 and the rest → 409.

- [ ] **Step 1: Write the failing tests.**
  - `normaliseLayout`:
    - unknown id `"x-old"` dropped;
    - a duplicate `jira` keeps the first;
    - a layout listing only `system` gets the other 8 appended in registry order with default widths;
    - `triage` with `visible:false, collapsed:true` comes back `true/false`;
    - `null`, `42`, `{version:2, sections:[]}` and `{version:1, sections:"x"}` → `DEFAULT_DASHBOARD_LAYOUT`;
    - the input object is not mutated.
  - Routes (in-memory container, fixed clock):
    - first `GET` seeds exactly one "Default" active row and audits `dashboard.layout_created` with actor `system`;
    - a second `GET` seeds nothing;
    - `POST {name:"Focus"}` → 201 with the active layout copied;
    - `POST {name:"focus"}` → 409 `name_taken`;
    - the 11th `POST` → 409 `limit_reached`;
    - `POST {name:""}` → 400 `invalid_name`;
    - `PUT {layout:{version:1, sections:[{id:"triage",visible:false,collapsed:true,width:"half"}]}}` → 200, `triage` visible and expanded, and all 9 ids present;
    - `PUT {layout:{version:1, sections:[{id:"jira", width:"third"}]}}` → 400 `invalid_layout`;
    - `activate` flips `isActive`, so exactly one active row exists;
    - `reset` restores the default and keeps the name;
    - `DELETE` of the only layout → 409 `last_layout`;
    - with two layouts, `DELETE` of the active one → 409 `active_layout`, and of the inactive one → 204;
    - an unknown id → 404 `not_found`.
  - Each write appends one `dashboard.layout_changed` domain event with `{layoutId}`. No audit `details` or event payload contains the name "Focus".
  - A stored row whose `layout` is set by raw SQL to `'{"version":2}'` → `GET` returns 200 with the default layout (Review Focus 2).
- [ ] **Step 2: Run** `bun test apps/api/test/modules/dashboard-layout.test.ts apps/api/test/routes/dashboard-layouts.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** the signatures above.
- [ ] **Step 4: Run** `bun run check`. Expect PASS.
- [ ] **Step 5: Commit:** `feat(dashboard): layout normalisation, layout service and layouts API (D1-D4)`.

### Task 3: Web customise mode, layout picker and rendering by layout

**Files:**
- Create:
  - `apps/web/lib/layout.ts`;
  - `apps/web/lib/layout-saver.ts`;
  - `apps/web/app/components/layout/DashboardSection.tsx`;
  - `apps/web/app/components/layout/HiddenTray.tsx`;
  - `apps/web/app/components/layout/LayoutPicker.tsx`;
  - `apps/web/test/layout.test.ts`;
  - `apps/web/test/layout-saver.test.ts`;
  - `apps/web/test/customise-ui.test.tsx`.
- Modify:
  - `apps/web/app/page.tsx`;
  - `apps/web/app/components/header/Header.tsx`;
  - `apps/web/lib/nav.ts`;
  - `apps/web/lib/api.ts`;
  - `apps/web/app/styles/shell.css`;
  - `apps/web/test/page-wiring.test.tsx`;
  - `apps/web/test/header.test.tsx`;
  - `apps/web/test/shell.test.tsx`.

**Interfaces:**
- Consumes: Task 1's layout contracts and Task 2's endpoints.
- Produces in `api.ts`:
  - `getLayouts(): Promise<DashboardLayoutsResponse>`;
  - `createLayout(name, fromId?)`;
  - `updateLayout(id, patch: { name?: string; layout?: DashboardLayout })`;
  - `activateLayout(id)`;
  - `resetLayout(id)`;
  - `deleteLayout(id): Promise<void>`. It uses `request(..., { method: "DELETE" })`, because `send` takes only POST/PUT.
- Produces in `lib/layout.ts` (pure; each returns a new layout and never mutates):
  - `moveSection(l: DashboardLayout, id, delta: -1 | 1)`, which does nothing at either end;
  - `setVisible(l, id, visible)` and `setCollapsed(l, id, collapsed)`, which do nothing for `triage`;
  - `setWidth(l, id, width)`;
  - `hiddenSections(l): DashboardSectionId[]`;
  - `type LayoutRow = { kind: "pair"; ids: [DashboardSectionId, DashboardSectionId] } | { kind: "single"; id: DashboardSectionId }`;
  - `layoutRows(l): LayoutRow[]`. It walks the visible sections in order and pairs two consecutive visible `half` sections (hidden ones are skipped), and a lone `half` becomes `single`;
  - `SECTION_LABELS: Record<DashboardSectionId, string>`, where `running` is "How Synapse is running" and the rest match `sidebarItems` labels.
- Produces in `lib/layout-saver.ts`:
  - `LAYOUT_SAVE_FAILED = "Couldn't save the layout"`;
  - `createLayoutSaver(deps: { put: (layout: DashboardLayout) => Promise<DashboardLayoutView>; onSaved: (v: DashboardLayoutView) => void; onError: (text: string) => void; reload: () => void; timers?: TimerApi }): { change(l: DashboardLayout): void; flush(): Promise<void>; isBusy(): boolean; cancel(): void }`. It is built on `trailingDebounce(fn, 500, timers)`, and `isBusy()` is true from the first `change` until the PUT settles.
- Produces `nav.ts`: `sidebarItems(counts, needsYou, waitingConversations = 0, hidden: ReadonlySet<string> = new Set())`, which leaves out hidden ids.
- Produces these components:
  - `DashboardSection({ id, label, count?, hot?, width, collapsed, customising, isFirst, isLast, canHide, onMove, onHide, onCollapse, onWidth, children })`. It renders `<section id={id} className="syn-section …">`.
    - In customise mode it adds a toolbar of `<button type="button">`s: "Move up", "Move down", "Hide" (absent when `!canHide`), "Collapse"/"Expand", and "Half width"/"Full width".
    - When collapsed, it renders only a header button (label plus count badge, `aria-expanded="false"`). Outside customise mode a click expands the section locally, through a page-held `Set` that is never saved.
  - `HiddenTray({ hidden, onShow })`, headed "Hidden sections".
  - `LayoutPicker({ layouts, activeId, onSwitch, onSaveAs, onRename, onDelete, onReset })`. Delete is disabled on the active layout.
  - `Header` gains `customising: boolean` and `onToggleCustomise(): void`, which drive a "Customise" / "Done" button with `aria-pressed`.

Page wiring:
- `page.tsx` keeps `overview` as a literal first section outside the layout.
- It builds `const sectionBodies: Record<DashboardSectionId, ReactNode>` from today's JSX, then renders `layoutRows(layout)`: a `pair` inside `<div className="syn-pair">`, a `single` on its own.
- `layout` state starts as `DEFAULT_DASHBOARD_LAYOUT`, so the first paint matches Phase 7.
- `refresh()` adds `getLayouts()` to its `Promise.allSettled` and applies it only when `!saver.isBusy()` (Review Focus 1).
- The customise toggle lives in the header and in ⌘K ("Customise dashboard", group `action`).
- `ProfileDrawer` moves out of the `people` section to page level, so it still opens when People is hidden or collapsed.
- `GO_TO` palette items and `sidebarItems` leave out hidden sections.
- Picker errors toast by code:
  - `name_taken` "A layout with that name already exists";
  - `limit_reached` "You can keep up to 10 layouts";
  - `active_layout` "Switch to another layout before deleting this one";
  - `last_layout` "You can't delete the only layout".
- Before switching layouts, the page calls `saver.flush()`.
- CSS: `.syn-top` becomes `.syn-pair` (the same `minmax(0, 1.45fr) minmax(320px, 1fr)` grid from 1100 px, and its nested `.syn-stages`/`.syn-run-facts` rules move with it), plus `.syn-section-toolbar`, `.syn-section.is-collapsed` and `.syn-hidden-tray`. Colours come from tokens only.

- [ ] **Step 1: Write the failing tests.**
  - `layout.test.ts`:
    - `moveSection(DEFAULT, "triage", -1)` is unchanged, and `moveSection(DEFAULT, "triage", 1)` puts `running` first;
    - `setVisible(DEFAULT, "triage", false)` and `setCollapsed(DEFAULT, "triage", true)` are unchanged;
    - `layoutRows(DEFAULT)` → `[{pair:["triage","running"]}, …7 singles]`;
    - `[jira half, people half hidden, system half]` → pair `["jira","system"]`;
    - one lone half → single;
    - three consecutive halves → pair, single;
    - `hiddenSections` after hiding `jira` → `["jira"]`;
    - inputs are not mutated.
  - `layout-saver.test.ts` (fake `TimerApi`, `put` stub):
    - three `change` calls before the timer fires → one `put`, with the last layout;
    - a `put` that rejects → `onError` called once with exactly "Couldn't save the layout", `reload` called once, and `onSaved` not called;
    - `isBusy()` is true after `change` and while `put` is pending, and false after it settles;
    - `flush()` sends a pending change at once and resolves after the `put`;
    - a `change` after a failure is still sent.
  - `customise-ui.test.tsx` (`renderToString`):
    - a customising `DashboardSection` for `jira` shows the five buttons; for `triage` (`canHide=false`) "Hide" is absent; `isFirst` → "Move up" disabled;
    - a collapsed `inbox` with `count=4`, outside customise mode, renders "Inbox", a badge `4` and `aria-expanded="false"`, and not the child marker text;
    - `HiddenTray` with `["jira"]` shows "Hidden sections", "Jira" and a "Show" button;
    - `LayoutPicker` disables delete on the active row;
    - `Header` with `customising` shows "Done" and `aria-pressed="true"`.
  - `shell.test.tsx`: `sidebarItems(null, 0, 0, new Set(["jira"]))` has no `jira` item, and the remaining counts are unchanged.
  - `page-wiring.test.tsx`, updated:
    - the page renders sections through `layoutRows(` and `<DashboardSection`;
    - `id="overview"` is the only literal `<section id=`;
    - `className="syn-pair"` is present and `syn-top` is gone;
    - every id in `DASHBOARD_SECTION_IDS` is a key of `sectionBodies`;
    - `<ProfileDrawer` appears after the closing of the layout map, not inside the `people` body;
    - the page contains "Customise dashboard";
    - `refresh` applies layouts only under `!saver.isBusy()` (a regex over the source).
- [ ] **Step 2: Run** `bun test apps/web/test`. Expect FAIL.
- [ ] **Step 3: Implement**, keeping each section's existing props unchanged inside `sectionBodies`.
- [ ] **Step 4: Run** `bun run check && bun run --cwd apps/web build`. Expect PASS.
- [ ] **Step 5: Commit:** `feat(web): customise mode, layout picker and layout-ordered sections (D5)`.

### Task 4: Private data files, umask and `file_permissions` health (R1)

**Files:**
- Create:
  - `apps/api/src/infrastructure/private-files.ts`;
  - `apps/api/test/infrastructure/private-files.test.ts`.
- Modify:
  - `apps/api/src/main.ts`;
  - `apps/api/src/container.ts` (`ContainerDeps.filePermissions?`, health entry `file_permissions`);
  - `apps/api/src/core/health/checks.ts` (`filePermissionsCheck`);
  - `apps/api/src/modules/dashboard/health-hints.ts`;
  - `apps/api/test/routes.test.ts` (health keys).

**Interfaces:**
- Produces:
  - `PrivateFsOps { stat(p: string): { uid: number; mode: number; isDir: boolean } | null; chmod(p: string, mode: number): void; mkdir(p: string, mode: number): void; readdir(dir: string): string[] }` and `defaultPrivateFsOps`;
  - `PrivateFilesResult { ok: boolean; changed: number; failed: number }`;
  - `securePrivateFiles(dbPath: string, opts?: { fs?: PrivateFsOps; uid?: number }): PrivateFilesResult`:
    - `:memory:` → `{ok:true, changed:0, failed:0}`, with no fs call;
    - a missing data dir is created with `0700`;
    - an existing data dir, owned by `uid` and with mode ≠ `0700`, is chmodded to `0700`;
    - `dbPath`, `-wal`, `-shm` and every `*.db.bak*` entry in the data dir, when owned by `uid` and with mode ≠ `0600`, are chmodded to `0600`;
    - entries owned by another uid are skipped and not counted;
    - each thrown chmod or mkdir counts in `failed`;
  - `PRIVATE_FILES_LOG_LINE = "synapse: could not make the data files private"`;
  - `filePermissionsCheck(r: PrivateFilesResult): HealthCheck`, which is `degraded` with detail `chmod failed for <n> path(s)` when `!ok`;
  - `HEALTH_LABELS.file_permissions = "Data file permissions"`, and `HEALTH_HINTS.file_permissions` = the exact spec hint;
  - `main.ts`, before `createContainer`, runs `process.umask(0o077)`, then `securePrivateFiles(config.dbPath)`. If that is not ok it logs `PRIVATE_FILES_LOG_LINE` once, then passes `filePermissions` into `createContainer`. The default is ok.

- [ ] **Step 1: Write the failing tests** (temp dir; a recording fake `PrivateFsOps` for the ownership and failure cases).
  - Real fs:
    - a data dir at `0755` → `0700`;
    - `synapse.db`, `-wal` and `-shm` at `0644` → `0600`;
    - `synapse.db.bak` and `synapse.db.bak.2` → `0600`;
    - `notes.txt` stays `0644`;
    - a missing data dir is created at `0700`;
    - an already private set → `changed: 0`.
  - Fake fs:
    - a file whose `stat.uid` is not `uid` → no `chmod` call, and `ok: true`;
    - `chmod` throwing EPERM → `{ok:false, failed:1}`, then `filePermissionsCheck` → `degraded`;
    - `HEALTH_HINTS.file_permissions` equals the spec text exactly;
    - `:memory:` → the recorder sees no call.
  - Static: in `main.ts`, `process.umask(0o077)` and `securePrivateFiles(` appear before `createContainer(`.
  - `routes.test.ts`: the health keys include `file_permissions`.
- [ ] **Step 2: Run** `bun test apps/api/test/infrastructure/private-files.test.ts apps/api/test/routes.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun run check`. Expect PASS.
- [ ] **Step 5: Commit:** `feat(runtime): private data files, umask 077 and file_permissions health (R1)`.

### Task 5: Backup service, daily job, backups API, and `backup`/`disk` health (R2)

**Files:**
- Create:
  - `apps/api/src/core/ops/daily.ts`;
  - `apps/api/src/core/ops/backup.ts`;
  - `apps/api/src/workers/ops.ts`;
  - `apps/api/src/routes/system.ts`;
  - `apps/api/test/core/ops-backup.test.ts`;
  - `apps/api/test/workers/ops-jobs.test.ts`;
  - `apps/api/test/routes/system.test.ts`.
- Modify:
  - `apps/api/src/container.ts` (`backup`, `startedAt: Date`, `ContainerDeps.backupDir?` and `diskFree?`, health entries `backup` and `disk`);
  - `apps/api/src/app.ts`;
  - `apps/api/src/core/health/checks.ts` (`backupCheck`, `diskCheck`);
  - `apps/api/src/modules/dashboard/health-hints.ts`;
  - `apps/api/test/routes.test.ts`.

**Interfaces:**
- Consumes: Task 1's settings, `BackupEntry`, `BackupFailureCode` and `AppConfig.backupDir`.
- Produces from `daily.ts`:
  - `LocalTime = (now: Date) => { date: string; hour: number }`, and `processLocalTime` (the same local-date logic as `reminders.ts`);
  - `dailyDue(now: Date, hour: number, lastRunDate: string | null, localTime?: LocalTime): { due: boolean; date: string; reason?: "not_due" | "done_today" }`.
- Produces from `backup.ts`:
  - `BACKUP_NAME_RE = /^synapse-\d{8}-\d{6}\.db$/` and `BACKUP_TMP_RE = /^\.synapse-.+\.tmp$/`;
  - `backupFileName(now: Date): string` (local time);
  - `BackupServiceDeps { db; sqlite: Database; clock; audit; dir: string; dbPath: string; diskFree: (path: string) => number | null; vacuumInto?: (target: string) => void; fileName?: (now: Date) => string }`;
  - `type BackupResult = { ok: true; name: string; bytes: number; pruned: number } | { ok: false; failure: BackupFailureCode }`;
  - `class BackupService` with `readonly dir`, plus:
    - `run(keep: number): BackupResult` (never throws);
    - `list(): BackupEntry[]`, which lists only `BACKUP_NAME_RE` names, newest first by mtime (`createdAt` = mtime ISO);
    - `lastAttempt(): { ok: boolean; at: string } | null`, which reads the newest audit row with action `ops.backup_created` or `ops.backup_failed`.
  - `run` steps, in order:
    1. Make the dir: mkdir `0700`, and chmod it when owned (else `dir_unavailable`).
    2. Delete leftover `BACKUP_TMP_RE` files.
    3. Check space: when `diskFree(dir) < 2 × (page_count × page_size + walBytes) + 2^30`, fail with `insufficient_space`.
    4. Run `vacuumInto(<dir>/.synapse-<stamp>-<rand>.tmp)`. The default is `sqlite.run("VACUUM INTO ?", [tmp])`. If it throws, delete the tmp and fail with `vacuum_failed`.
    5. Open the tmp with `{readonly: true}`. Unless `PRAGMA integrity_check` returns exactly `[{integrity_check:"ok"}]`, delete it and fail with `integrity_failed`.
    6. chmod the tmp to `0600`. If the target exists, delete the tmp and fail with `target_exists`.
    7. Rename the tmp to the target.
    8. Prune the `BACKUP_NAME_RE` files beyond the newest `keep`.
  - It audits `ops.backup_created {name, bytes, pruned}` or `ops.backup_failed {code}` (actor `system`, module `ops`).
- Produces from `workers/ops.ts`:
  - `OPS_BACKUP_JOB = "ops.backup"`;
  - `OpsJobDeps { db; handlers; scheduler; queue; settings; clock; backup: BackupService; localTime?: LocalTime }`;
  - `runBackupTick(deps: OpsJobDeps): { skipped: "not_due" | "done_today" } | { date: string; backup: BackupResult | "disabled" }`. When due, it runs the backup if `ops.backup.enabled`, then sets `ops.backup.lastRunDate` (with `emit:false`) whether the backup succeeded or failed, so a failure does not retry every 15 minutes;
  - `registerOpsJobs(deps: OpsJobDeps): void`. Its handler takes input `{manual?: true}`: manual → `backup.run(keep)` (allowed even when disabled, because the user asked); scheduled → `runBackupTick`. It upserts the schedule `{ name: OPS_BACKUP_JOB, jobType: OPS_BACKUP_JOB, intervalSeconds: 900, coalesce: true }`, with timeout 600 s;
  - `backupJobLive(db): boolean`, true when an `ops.backup` job with `input.manual = true` is PENDING, RETRY or RUNNING.
- Produces from `routes/system.ts`:
  - `systemRoutes(c: Container): Hono`;
  - `GET /api/system/backups` → `BackupEntry[]`;
  - `POST /api/system/backups` → 202 `{jobId}` (idempotency key `ops.backup.manual:<newId>`), or 409 `already_running` when `backupJobLive`.
- Produces from `checks.ts`:
  - `backupCheck(deps: { settings; backup: Pick<BackupService,"list"|"lastAttempt">; clock; startedAt: Date }): HealthCheck`:
    - disabled → `ok` "disabled";
    - last attempt failed → `degraded` "last backup failed";
    - uptime ≥ 24 h and the newest backup missing or older than 36 h → `degraded` "no backup in 36 h";
    - otherwise `ok`.
  - `diskCheck(deps: { settings; diskFree; dataDir: string }): HealthCheck`:
    - `null` → `degraded` "free space unknown";
    - < 1 GiB → `down`;
    - < `ops.disk.warnFreeGiB` → `degraded` `<n.n> GiB free`;
    - otherwise `ok`.
  - Labels "Backups" and "Disk space", with the hints:
    - `backup`: "The daily backup is missing or failed. Check free space in the backup directory, then use Back up now in System."
    - `disk`: "Free space is low where Synapse keeps its data. Delete old files or move backups with SYNAPSE_BACKUP_DIR."
- Container wiring:
  - The backup dir resolves as `deps.backupDir ?? config.backupDir ?? settings.get("ops.backup.dir") ?? (":memory:" ? join(scratchDir, "backups") : join(dirname(dbPath), "backups"))`. A settings value that fails `checkBackupDir` throws at startup with the Task 1 message.
  - `diskFree` defaults to `statfsSync(p).bavail * bsize`, or null on error.
  - `startedAt = clock.now()`.

- [ ] **Step 1: Write the failing tests** (temp file DB with migrations, a seeded row holding `SENTINEL-ROW-7f3a`, fixed clock, `fileName` stub `() => "synapse-20261107-030000.db"`).
  - Success:
    - the file exists with mode `0600` and the dir `0700`;
    - opening it read-only shows the seeded row;
    - the result is `{ok:true, name, bytes>0}`;
    - one audit `ops.backup_created`, whose details hold `name` and `bytes` and no sentinel.
  - Corrupt output (`vacuumInto` writes 4 KiB of garbage) → `integrity_failed`; no `.tmp` and no `synapse-*.db` left; audit `ops.backup_failed {code:"integrity_failed"}`; `lastAttempt().ok === false`.
  - `vacuumInto` writes half a file, then throws `SQLITE_FULL` → `vacuum_failed`, and the dir holds no tmp and no `synapse-*.db` (Review Focus 5).
  - `diskFree` returning 100 MiB → `insufficient_space`, and `vacuumInto` never called.
  - Prune: with `keep = 2`, four backups with ascending mtimes, plus `synapse.db`, `synapse.db.before-restore-20261101-000000`, `synapse-notes.db` and `other.db` → only the two newest backups and all four other files remain (Review Focus 3).
  - A leftover `.synapse-old.tmp` is deleted.
  - `list()` is newest first and ignores non-matching names.
  - Ticks (with a `localTime` stub):
    - at 02:59 → `not_due`, with no file;
    - at 03:00 → a backup and `lastRunDate = "2026-11-07"`;
    - again at 03:15 → `done_today`;
    - a fresh `registerOpsJobs` at 03:10 with the same date stored → `done_today`;
    - with `ops.backup.enabled` false → `{backup:"disabled"}`, no file, and `lastRunDate` set;
    - with `insufficient_space` → `lastRunDate` still set.
  - Routes:
    - `POST` → 202 with a job of type `ops.backup`, input `{manual:true}`;
    - a second `POST` while it is pending → 409 `already_running`;
    - `GET` lists the backups.
  - Health:
    - `backupCheck`:
      - disabled → `ok`/"disabled";
      - failed last attempt → degraded;
      - uptime 23 h with no backup → `ok`;
      - uptime 25 h with no backup → degraded;
      - a backup 35 h old → `ok`;
      - one 37 h old → degraded.
    - `diskCheck` at 6 GiB → `ok`, at 4 GiB → degraded, at 0.5 GiB → `down`.
  - `routes.test.ts` health keys add `backup` and `disk` (inject `diskFree: () => 100 * 2 ** 30`).
- [ ] **Step 2: Run** `bun test apps/api/test/core/ops-backup.test.ts apps/api/test/workers/ops-jobs.test.ts apps/api/test/routes/system.test.ts apps/api/test/routes.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun run check`. Expect PASS.
- [ ] **Step 5: Commit:** `feat(runtime): verified local backups, daily backup job, backups API and health (R2)`.

### Task 6: Restore CLI (R3)

**Files:**
- Create:
  - `scripts/ops/restore.ts`;
  - `scripts/ops/test/restore.test.ts`.
- Modify:
  - `packages/database/src/migrate.ts` and `src/index.ts` (`knownMigrationHashes`);
  - `packages/database/test/client.test.ts`.

**Interfaces:**
- Produces:
  - `knownMigrationHashes(): Set<string>`, from `readMigrationFiles({ migrationsFolder })` (`drizzle-orm/migrator`); it holds the sha256 of each journal entry, the same hashes `__drizzle_migrations` stores;
  - `RESTORE_USAGE = "usage: bun scripts/ops/restore.ts <backup-file> --yes"`, and `RESTORED_LINE` = the exact spec line;
  - `type RestoreRefusal = "usage" | "no_confirm" | "backup_missing" | "api_running" | "database_busy" | "integrity_failed" | "not_a_synapse_backup" | "unknown_migration"`;
  - `RestoreDeps { dbPath: string; port: number; probe: (url: string) => Promise<boolean>; knownHashes: Set<string>; now: () => Date; log: (line: string) => void }`;
  - `restore(args: string[], deps: RestoreDeps): Promise<{ ok: true } | { ok: false; refusal: RestoreRefusal }>`. Checks run in the spec order:
    1. `--yes`.
    2. The backup file exists.
    3. `probe("http://127.0.0.1:<port>/health/live")`; any HTTP answer counts as the API being up.
    4. The live DB opens with `{readwrite: true, create: false}` and `PRAGMA busy_timeout = 0`. `BEGIN IMMEDIATE` succeeds, then `ROLLBACK`; an error is `database_busy`. A missing live DB skips this check and step 7.
    5. The backup opens read-only, and `integrity_check` returns exactly `ok`.
    6. `__drizzle_migrations` exists (else `not_a_synapse_backup`), and every one of its `hash` values is in `knownHashes` (else `unknown_migration`).
    7. On the live DB, run `PRAGMA wal_checkpoint(TRUNCATE)` and close it. Rename `synapse.db` → `synapse.db.before-restore-<YYYYMMDD-HHMMSS>`, and `-wal`/`-shm` (if present) → the same name plus `-wal`/`-shm`. chmod each to `0600`.
    8. Copy the backup to `<dbPath>.restore-tmp` at `0600`, then rename it to `dbPath`.
    9. Log `RESTORED_LINE`.
  - Log lines: `restore refused: <code>`, `moved aside: <basename> (<bytes> bytes)` and `restored: <basename> (<bytes> bytes)`. These are basenames and sizes only.
  - The `import.meta.main` runner calls `process.umask(0o077)` and uses `loadConfig(process.env)` for `dbPath` and `api.port`. Its probe is `fetch` with `AbortSignal.timeout(1000)`: true on any response, false on any throw. It exits 0 on ok and 1 on a refusal.

- [ ] **Step 1: Write the failing tests** (temp dir; a live DB with migrations and a row holding `SENTINEL-ROW-7f3a`; a backup made with `VACUUM INTO`, then a different row added to the live DB).
  - No `--yes` → `no_confirm`, and the live file's sha256 is unchanged.
  - No args → `usage`. A missing backup path → `backup_missing`.
  - `probe` returning true → `api_running`, with the probed URL `http://127.0.0.1:7400/health/live`.
  - A second connection holding `BEGIN IMMEDIATE` → `database_busy`.
  - A garbage backup → `integrity_failed`.
  - A backup with an added `__drizzle_migrations` row `hash = "f".repeat(64)` → `unknown_migration`.
  - A backup without that table → `not_a_synapse_backup`.
  - Success:
    - setup: a connection with `wal_autocheckpoint = 0` inserts a row and stays open, so the row sits only in `-wal`;
    - after the restore, `synapse.db.before-restore-*` contains that row (Review Focus 4);
    - the restored `synapse.db` has the backup's rows and not the post-backup row;
    - no stale `-wal` belonging to the old DB sits next to the restored DB;
    - all files are `0600`;
    - the logs end with `RESTORED_LINE` and contain no sentinel.
  - `knownMigrationHashes()` has as many entries as the journal, and contains the hash a fresh `runMigrations` DB stores.
- [ ] **Step 2: Run** `bun test scripts/ops/test/restore.test.ts packages/database/test/client.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun run check`. Expect PASS. Never run the script against the real data dir.
- [ ] **Step 5: Commit:** `feat(ops): CLI-only restore with integrity, migration and live-API refusals (R3)`.

### Task 7: Operational retention, quick_check and `database` health (R4)

**Files:**
- Create:
  - `apps/api/src/core/ops/integrity.ts`;
  - `apps/api/src/core/ops/retention.ts`;
  - `apps/api/test/core/ops-retention.test.ts`.
- Modify:
  - `apps/api/src/workers/ops.ts` (the retention handler, and the enqueue after the backup tick);
  - `apps/api/src/core/health/checks.ts` (`databaseCheck(sqlite, integrity?)`);
  - `apps/api/src/modules/dashboard/health-hints.ts` (the `database` hint);
  - `apps/api/src/container.ts` (`integrity`, `retention`);
  - `apps/api/src/main.ts` (`c.integrity.check()` once after recovery, before the worker starts);
  - `apps/api/test/workers/ops-jobs.test.ts`;
  - `apps/api/test/core/health.test.ts`.

**Interfaces:**
- Consumes: Task 5's `OpsJobDeps`, `runBackupTick` and `dailyDue`; Task 1's `RetentionSummary` and settings.
- Produces from `integrity.ts`:
  - `class DatabaseIntegrity { constructor(sqlite: Database, clock: Clock); check(): "ok" | "failed"; last(): { result: "ok" | "failed"; at: string } | null }`. `check()` returns `ok` only when `PRAGMA quick_check` returns exactly one row, `ok`.
- Produces in `checks.ts`: `databaseCheck(sqlite, integrity?: Pick<DatabaseIntegrity,"last">)`. It keeps the WAL check, and returns `down` with detail "quick_check failed" when `last()?.result === "failed"`. The `database` hint becomes "SQLite reported a problem (not in WAL mode, or the integrity check failed). Restart the API; if the integrity check still fails, stop the API and restore the latest backup with bun scripts/ops/restore.ts."
- Produces from `retention.ts`:
  - `RETENTION_BATCH = 500`, and `OUTBOX_RETENTION_DAYS = 7`;
  - `RetentionDeps { db; sqlite: Database; clock; settings; audit; integrity: DatabaseIntegrity; batchSize?: number; yieldFn?: () => Promise<void> }`. The default `yieldFn` is `() => new Promise(r => setTimeout(r, 0))`, called between batches;
  - `class RetentionService { run(date: string): Promise<RetentionSummary> }`.
  - The categories, each in batches of `batchSize` ids, one immediate transaction per batch:

    | Category | Rule |
    |---|---|
    | jobs | `status in ('COMPLETED','CANCELLED','FAILED')` and `coalesce(finished_at, created_at) < now − jobsDays`. Per batch: delete `job_checkpoints` and `job_attempts` for the ids, set `claude_runs.job_id = NULL` for the ids, then delete the `jobs` rows |
    | notifications | `read_at is not null` and `created_at < now − notificationsDays` |
    | events | `dispatched_at is not null` and `dispatched_at < now − 7 d`, and no `event_consumptions` row with `status <> 'done'` (failed consumptions stay visible to `eventsCheck`). Delete the consumptions, then the events |
    | audit | `occurred_at < now − auditDays` |
    | claude_runs compaction | `started_at < now − claudeRunsDays` and (`permission_denials is not null` or `json_extract(error,'$.message') is not null`). Set `permission_denials = NULL` and `error = json_object('kind', json_extract(error,'$.kind'))` (NULL stays NULL). `claude_runs` has no raw-stream, tool-result or final-text column; these two JSON columns are its only payload. Rows are never deleted, so the inbound FKs from `job_attempts`, `quota_snapshots`, `auth_snapshots`, `security_flags`, `message_drafts`, `people_profile_recommendations`, `commitment_sources`, `outgoing_messages` and `followups` stay valid |

  - Never touched: `approvals`, `outgoing_messages`, `auto_replies`, `security_flags`, `engineering_tasks`, `commitments`.
  - Afterwards: `PRAGMA wal_checkpoint(TRUNCATE)`, `PRAGMA optimize`, then `integrity.check()` → `quickCheck`. It audits `ops.retention_ran` (counts only) and sets `ops.retention.lastRun` (`emit:false`).
- Produces in `workers/ops.ts`:
  - `OPS_RETENTION_JOB = "ops.retention"`, with timeout 600 s;
  - `runBackupTick` now, after the backup attempt (including `disabled`), enqueues `{type: OPS_RETENTION_JOB, input: {date}, idempotencyKey: \`ops.retention:${date}\`}`;
  - the handler skips with `{skipped: "done_today"}` when `ops.retention.lastRun?.date === input.date`, else returns `retention.run(input.date)`.

- [ ] **Step 1: Write the failing tests** (temp file DB with migrations, fixed clock `2026-11-07T12:00:00Z`; seed with `PRAGMA foreign_keys = OFF` for minimal rows, filling NOT NULL columns, then turn it back on).
  - Jobs:
    - 40-day-old COMPLETED, CANCELLED and FAILED jobs, each with a `job_attempts` row and one `job_checkpoints` row, one of them referenced by a `claude_runs.job_id` → deleted, and that run's `job_id` is NULL;
    - 40-day-old PENDING, RUNNING, RETRY and NEEDS_ATTENTION jobs → kept;
    - a 10-day-old COMPLETED job → kept.
  - Batching: 1,203 old completed jobs with `batchSize = 500` → `jobs = 1203`, and `yieldFn` called at least twice.
  - Notifications: old read → deleted; old unread → kept; new read → kept.
  - Events:
    - an 8-day-old dispatched event with only `done` consumptions → deleted with its consumptions;
    - one with a `failed` consumption → kept;
    - an undispatched old event → kept;
    - a 6-day-old dispatched event → kept.
  - Audit: 400 days old → deleted; 100 days old → kept.
  - Compaction:
    - a 100-day-old run with `error {kind:"timeout", message:"SENTINEL-ROW-7f3a"}` and denials `["Bash"]`, referenced by `security_flags.claude_run_id` and `job_attempts.claude_run_id` → still present, `error = {kind:"timeout"}`, `permission_denials` NULL, and status, timing, tokens and cost unchanged;
    - a 10-day-old run → unchanged;
    - `PRAGMA foreign_key_check` returns `[]`.
  - Protected tables: the row counts of the six protected tables are unchanged after a run, with 400-day-old rows seeded in each.
  - Summary: the result's counts match, `quickCheck: "ok"`, `settings.get("ops.retention.lastRun").date === "2026-11-07"`, and one audit `ops.retention_ran` whose details contain no sentinel.
  - Jobs:
    - a backup tick at 03:00 enqueues `ops.retention:2026-11-07`, and a disabled backup still enqueues it;
    - the handler run twice for the same date → the second returns `done_today`.
  - Health:
    - `databaseCheck` with an integrity stub returning `{result:"failed"}` → `down` "quick_check failed";
    - with `ok` and WAL → `ok`.
- [ ] **Step 2: Run** `bun test apps/api/test/core/ops-retention.test.ts apps/api/test/workers/ops-jobs.test.ts apps/api/test/core/health.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun run check`. Expect PASS.
- [ ] **Step 5: Commit:** `feat(runtime): operational retention, claude_runs compaction and quick_check health (R4)`.

### Task 8: Runtime API and the web Runtime panel (R5)

**Files:**
- Create:
  - `apps/api/src/core/ops/runtime.ts`;
  - `apps/web/app/components/system/RuntimePanel.tsx`;
  - `apps/api/test/core/ops-runtime.test.ts`;
  - `apps/web/test/runtime-ui.test.tsx`.
- Modify:
  - `apps/api/src/routes/system.ts` (`GET /api/system/runtime`);
  - `apps/api/src/container.ts` (`runtime`);
  - `apps/web/lib/api.ts`;
  - `apps/web/lib/format.ts` (`formatBytes`);
  - `apps/web/test/format.test.ts`;
  - `apps/web/app/page.tsx` (System section);
  - `apps/web/app/styles/system.css`;
  - `apps/api/test/routes/system.test.ts`.

**Interfaces:**
- Consumes: Task 5's `BackupService.list` and `diskFree`, Task 7's `ops.retention.lastRun`, and Task 1's `RuntimeView`.
- Produces from `runtime.ts`:
  - `readVersion(repoRoot: string, run: (cmd: string[]) => Promise<string>): Promise<string | null>`:
    - it reads `apps/api/package.json` `version`, and returns null when that is unreadable;
    - it runs `git -C <repoRoot> rev-parse --short HEAD`, and accepts the output only when it matches `/^[0-9a-f]{7,12}$/` after trimming;
    - it returns `"<version>+<sha>"`, or `"<version>"`.
  - `RuntimeDeps { db; sqlite; clock; settings; startedAt: Date; dbPath: string; dataDir: string; diskFree; backup: Pick<BackupService,"list">; version: Promise<string | null> }`.
  - `class RuntimeService { view(): Promise<RuntimeView> }`:
    - `uptimeSeconds` is `floor((now − startedAt)/1000)`;
    - `memoryRssBytes` is `process.memoryUsage.rss()`;
    - `dbBytes` is `page_count × page_size`, and `walBytes` is the stat of `<dbPath>-wal` or 0;
    - `dataDirFreeBytes` is `diskFree(dataDir)`;
    - the queue counts come from `jobs` by status, and `oldestPendingAgeSeconds` is from the min `run_after` of due PENDING jobs, or null;
    - `retention` is `ops.retention.lastRun`.
  - The container starts `readVersion(REPO_ROOT, run)` once at creation and passes the promise in.
- Produces in the web `api.ts`: `getRuntime(): Promise<RuntimeView>`, `getBackups(): Promise<BackupEntry[]>` and `startBackup(): Promise<{ jobId: string }>`.
- Produces `formatBytes(n: number): string`, using binary units with one decimal from KiB: `0 → "0 B"`, `1536 → "1.5 KiB"`, `5 × 2^30 → "5.0 GiB"`.
- Produces `RuntimePanel({ runtime, backups, settings, now, onBackupNow, backupPending, onSetting })`, in a `Card` headed "Runtime":
  - the R5 values: uptime, version (or "unknown"), memory, database plus WAL, free space and the queue counts;
  - the last backup and the backups list (names and sizes), with a "Back up now" button that is disabled while `backupPending`; an empty list shows "No backups yet";
  - the retention last-run counts, or "Retention has not run yet";
  - the R7 keys, using the `ClaudeSettings` input pattern with the R7 bounds: a switch for `ops.backup.enabled` and number inputs for the other 7.
- Page wiring: it fetches `getRuntime()` and `getBackups()` in `refresh()`. "Back up now" calls `startBackup()`, then toasts "Backup started". A 409 toasts "A backup is already running"; any other error toasts "Couldn't start the backup". Settings reuse the existing `putSettings` toast "Could not save that setting".

- [ ] **Step 1: Write the failing tests.**
  - Route (in-memory container, fixed clock 90 s after `startedAt`, `diskFree` stub `42 × 2^30`, `run` stub returning `"abc1234\n"` for `git`):
    - `GET /api/system/runtime` has exactly the `RuntimeView` keys;
    - `uptimeSeconds: 90`, `version: "0.0.0+abc1234"`, `walBytes: 0`, `dataDirFreeBytes: 42 × 2^30`;
    - `lastBackup: null`, `backupCount: 0` and `retention: null`;
    - after seeding 2 PENDING jobs (one due 5 min ago), 1 RUNNING, 1 RETRY and 1 NEEDS_ATTENTION → the queue is `{pending:2, running:1, retry:1, needsAttention:1, oldestPendingAgeSeconds:300}`.
  - `readVersion`:
    - `run` returning `"Linger=no"` → `"0.0.0"`;
    - `run` throwing → `"0.0.0"`;
    - a missing package.json (temp repoRoot) → `null`.
  - With one backup made through `c.backup.run(7)` → `lastBackup.name` matches `BACKUP_NAME_RE` and `backupCount: 1`.
  - `RuntimePanel` (`renderToString`):
    - shows "Runtime", "Back up now", the backup name, `formatBytes` sizes and the retention counts;
    - `backupPending` → the button is `disabled`;
    - empty backups → "No backups yet";
    - `retention: null` → "Retention has not run yet";
    - the `ops.backup.keep` input has `min="1"` and `max="60"`.
  - `formatBytes` cases as above.
- [ ] **Step 2: Run** `bun test apps/api/test/core/ops-runtime.test.ts apps/api/test/routes/system.test.ts apps/web/test/runtime-ui.test.tsx apps/web/test/format.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun run check && bun run --cwd apps/web build`. Expect PASS.
- [ ] **Step 5: Commit:** `feat(runtime): runtime API and the System Runtime panel (R5)`.

### Task 9: Service units, graceful shutdown and the service-status script (R6)

**Files:**
- Create:
  - `apps/api/src/core/system/shutdown.ts`;
  - `apps/api/test/core/shutdown.test.ts`;
  - `scripts/setup/service-status.ts`;
  - `scripts/setup/test/service-status.test.ts`.
- Modify:
  - `scripts/setup/systemd/synapse-api.service` and `synapse-web.service`;
  - `scripts/setup/test/install-services.test.ts`;
  - `apps/api/src/core/jobs/queue.ts` (`expireLeasesOwnedBy`);
  - `apps/api/src/core/leases/leases.ts` (`releaseHeldBy`);
  - `apps/api/src/container.ts` (expose `workerId`);
  - `apps/api/src/main.ts`.

**Interfaces:**
- Produces:
  - `JobQueue.expireLeasesOwnedBy(workerId: string): number`. It sets `lease_expires_at = now` on RUNNING jobs whose `lease_owner` starts with `${workerId}:`, so startup recovery reclaims them at once under its existing external-write rules.
  - `LeaseService.releaseHeldBy(holder: string): number`. It deletes `leases` rows whose holder equals `holder` or starts with `${holder}:`, and never the `engineering` lease (ADR-030 and E6: that lock outlives restarts).
  - `Container.workerId: string`.
  - `ShutdownDeps { intervals: ReturnType<typeof setInterval>[]; worker: Pick<JobWorker,"stop">; releaseLeases: () => void; server: { stop(): void }; sqlite: Pick<Database,"run"|"close">; exit: (code: number) => void; log?: (line: string) => void }`.
  - `SHUTDOWN_GRACE_MS = 10_000`.
  - `createShutdown(deps: ShutdownDeps): (signal: string) => Promise<void>`. The first call runs, in order:
    1. clear the intervals (this stops the scheduler, the dispatcher, expiry and the reaper);
    2. `await worker.stop(SHUTDOWN_GRACE_MS)`;
    3. `releaseLeases()`;
    4. `server.stop()`;
    5. `sqlite.run("PRAGMA wal_checkpoint(TRUNCATE)")`;
    6. `sqlite.close()`;
    7. `exit(0)`.
    A step that throws logs `shutdown: <step> failed <ErrorName>` and the sequence continues. A second call while the first is running → `exit(1)` immediately.
  - `main.ts` uses `createShutdown`, with `releaseLeases: () => { c.queue.expireLeasesOwnedBy(c.workerId); c.leases.releaseHeldBy(c.workerId); }`, for SIGTERM and SIGINT.
  - The unit templates:
    - both units: `[Unit]` gains `StartLimitIntervalSec=300` and `StartLimitBurst=5`; `[Service]` gains `TimeoutStopSec=30` (was 20), `UMask=0077` and `NoNewPrivileges=yes`;
    - web: `After=synapse-api.service` and `Wants=synapse-api.service`.
  - `StatusDeps { run: (cmd: string[]) => Promise<{ stdout: string; code: number }>; fetchHealth: () => Promise<string | null>; user: string }`.
  - `UNITS = ["synapse-api.service", "synapse-web.service"]`.
  - `collectServiceStatus(deps: StatusDeps): Promise<string[]>`. It runs exactly `systemctl --user is-active <unit>`, `systemctl --user is-enabled <unit>` and `loginctl show-user <user> -p Linger`. It prints these lines:
    - `<unit>: active=<word> enabled=<word>`, where each word is the first output token if it matches `^[a-z-]+$`, else `unknown`; a non-zero exit is normal and still parsed;
    - `linger: on | off | unknown`;
    - `api health: <ok|degraded|down|unreachable>`, from `GET http://127.0.0.1:<port>/health/ready` `.status`, accepting a 503 body.
  - The `import.meta.main` runner prints the lines and always exits 0.

- [ ] **Step 1: Write the failing tests.**
  - `install-services.test.ts`, for both rendered units:
    - each contains `StartLimitIntervalSec=300`, `StartLimitBurst=5`, `TimeoutStopSec=30`, `UMask=0077` and `NoNewPrivileges=yes`;
    - the `StartLimit*` lines sit between `[Unit]` and `[Service]`;
    - neither contains `TimeoutStopSec=20`;
    - web contains `Wants=synapse-api.service` and `After=synapse-api.service`.
  - `shutdown.test.ts`:
    - with recording fakes, the call order is `clear, stop(10000), release, server.stop, checkpoint, close, exit(0)`;
    - a second call while `worker.stop` is pending → `exit(1)` recorded before the first sequence finishes;
    - `worker.stop` rejecting → the rest still runs and `exit(0)`;
    - real `:memory:` container:
      - claim a job with `c.workerId`, then run `expireLeasesOwnedBy` → its `lease_expires_at` ≤ now, and `recoverOnStartup` then requeues it as RETRY;
      - a job claimed by `other-worker` → unchanged;
      - an `engineering` lease held by `task:t1` → untouched by `releaseHeldBy(c.workerId)`;
      - a lease held by `${c.workerId}:x` → deleted.
  - `service-status.test.ts` (a stub `run` that records commands):
    - `active` and `enabled` with Linger=yes and health `ok` → the four exact lines;
    - `inactive` with exit code 3 → `active=inactive`;
    - output `"Failed to connect to bus: …"` → `unknown`;
    - `fetchHealth` null → `api health: unreachable`;
    - every recorded command is one of the three read-only forms, and none contains `start`, `stop`, `restart`, `enable`, `daemon-reload` or `journalctl`.
- [ ] **Step 2: Run** `bun test apps/api/test/core/shutdown.test.ts scripts/setup/test`. Expect FAIL.
- [ ] **Step 3: Implement.** Do not run `install-services.ts`, `systemctl` or `loginctl`.
- [ ] **Step 4: Run** `bun run check`. Expect PASS.
- [ ] **Step 5: Commit:** `feat(runtime): hardened units, graceful shutdown with lease release, service-status script (R6)`.

### Task 10: Docs

**Files:**
- Create: `docs/superpowers/plans/2026-11-07-phase-11-followups.md`.
- Modify:
  - `CLAUDE.md`;
  - `docs/modules/dashboard.md`;
  - `docs/modules/web-dashboard.md`;
  - `docs/architecture/database-design.md`;
  - `docs/architecture/runtime-design.md`;
  - `docs/architecture/event-system.md`;
  - `docs/architecture/module-boundaries.md`;
  - `docs/decisions/ADR/ADR-023-customizable-dashboard-widgets.md`;
  - `docs/product/roadmap.md`.

**Interfaces:**
- Consumes: the names from Tasks 1–9.
- Produces only documentation. What each file must say:
  - **`CLAUDE.md`, Commands:**
    - add `bun scripts/setup/service-status.ts  # read-only: is-active, is-enabled and linger per unit, plus the API health status; prints no journal content`.
  - **`CLAUDE.md`, "Ask the user for approval before running any of these":**
    - add `bun scripts/ops/restore.ts <backup-file> --yes   # REPLACES the live database with a backup (refuses while the API runs, or when the database is busy, the backup is corrupt or the backup has unknown migrations); the old files are kept as synapse.db.before-restore-<ts>`;
    - note that backups live in `<data dir>/backups` (or `SYNAPSE_BACKUP_DIR`).
  - **`dashboard.md`:** the D4 endpoints and error codes, the `normaliseLayout` rules, default seeding, audit actions and the event.
  - **`web-dashboard.md`:** customise mode, hidden tray, picker, the debounced save and its failure toast, collapsed rendering, pairing from 1100 px, and that hidden sections leave the sidebar and ⌘K.
  - **`database-design.md`:**
    - `dashboard_layouts` replaces the planned `dashboard_widgets`/`dashboard_widget_settings`, which are not built;
    - a new "Operational retention" subsection with the Task 7 table, the never-touched list, and the `claude_runs` columns that compaction nulls;
    - backups use `VACUUM INTO` plus `integrity_check`.
  - **`runtime-design.md`:**
    - rewrite "Backups and retention": R2, the restore at `scripts/ops/restore.ts` (replacing the stale `scripts/maintenance/` reference), and R4;
    - add private files (R1), graceful shutdown, the unit hardening and the new health checks to "Health monitoring";
    - add the R7 keys to "Configuration defaults", plus `SYNAPSE_BACKUP_DIR`.
  - **`event-system.md`:** `dashboard.layout_changed {layoutId}`.
  - **`module-boundaries.md`:** `dashboard` owns `dashboard_layouts`, and a core row `ops` (backup, retention, integrity, runtime: `BackupService`, `RetentionService`, `DatabaseIntegrity`, `RuntimeService`).
  - **ADR-023:** a dated `## Amendment (2026-11-07, Phase 11)`. Sections are the widgets: reorder, hide, collapse, half/full width and named layouts are built; adding new widget types and per-widget configuration are not (spec Out of scope).
  - **`roadmap.md`:** row 11 → "Implemented on branch `phase-11-dashboard-runtime`" with a one-line summary and the follow-ups link.
  - **The follow-ups file:**
    - `VACUUM INTO` and `quick_check` run synchronously on the API thread, so a large DB pauses requests;
    - `reminders.ts` keeps its own local-time helper, not yet folded into `core/ops/daily.ts`;
    - `quota_snapshots` and `auth_snapshots` are not pruned;
    - retention frees the idempotency keys of deleted jobs: the domain state guards replays, but this is not audited per job type;
    - backup names use local time, so a DST fall-back hour can sort by name unlike mtime (pruning uses mtime);
    - a manual backup runs even when `ops.backup.enabled` is false.

- [ ] **Step 1: Write the docs** listed above.
- [ ] **Step 2: Run** `bun run check && bun run --cwd apps/web build`. Expect PASS. Do not run the restore, install or systemctl commands.
- [ ] **Step 3: Commit:** `docs(11): dashboard layouts, runtime hardening, restore and service-status commands`.

---

## Self-review notes

- **Spec coverage:**

  | Spec item | Task |
  |---|---|
  | D1, D2 | 1 and 2 |
  | D3 | 1 (constant) and 2 (seed) |
  | D4 | 2 |
  | D5 | 3 |
  | R1 | 4 (units `UMask` in 9) |
  | R2 | 5 |
  | R3 | 6 |
  | R4 | 7 |
  | R5 | 5 (`backup`, `disk`), 7 (`database`), 4 (`file_permissions`) and 8 (runtime API and panel) |
  | R6 | 9 |
  | R7 | 1, and the panel in 8 |
  | Tests section | every listed case has a named test in its task |
  | CLAUDE.md approval listing | 10 |

- **Type consistency.** `BackupService.run(keep)`, `list()` and `lastAttempt()` are used by Tasks 5, 7 and 8. `RetentionService.run(date)` and `DatabaseIntegrity.last()` are used by 7. `OpsJobDeps` is extended in 7 without being renamed. `SettingsDto` comes from 1 and is used in 8. `DashboardLayoutView` and `DashboardLayoutsResponse` come from 1 and are used in 2 and 3.
