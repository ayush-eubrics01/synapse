# Phase 7: Design Revamp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single debug page with the user's designed dashboard (sidebar shell, briefing header, Needs-you feed, pipeline, inbox with threads, commitments, people, system) in dark and light themes. Every existing capability stays reachable, and the backend serves the new aggregate views.

**Architecture:**
- **Backend.** Two backend tasks add read-only aggregate endpoints (`modules/dashboard`, inbox conversations and thread) and quota thresholds.
- **Web foundation.** One task lays the foundation: tokens, fonts, theme, shell, primitives, toasts with deferred-commit Undo.
- **Web sections.** Each later task replaces one region of the old page with its designed section, then deletes the components it supersedes.
- **Presentation logic.** All of it (briefing text, card order, palette filter, avatar hue) is pure functions in `apps/web/lib/`, tested with `bun test`. Components are tested with `renderToString`, as today.

**Tech Stack:** Bun 1.4.4, TypeScript strict, Hono, Drizzle/bun:sqlite, Zod 4, Next.js 16 (read `apps/web/node_modules/next/dist/docs/` before using a Next API, per `apps/web/AGENTS.md`), React 19, `bun test`.

**Spec:** `docs/superpowers/specs/2026-11-06-phase-7-design-revamp.md` (decisions D1–D16 and the backend contracts). The roadmap entry is `docs/product/roadmap.md` §Phase 7.

## Global Constraints

- **Never read or copy from `~/designs-claude/`.** Sample names, messages, ids and screenshots must not enter the repo. The tokens and layout needed are in the spec and in this plan.
- **Placeholder data only.** Test people are Ada, Grace, Linus and Barbara. Slack ids are `U0ADA0001`-style, conversation ids `D0ADA0001` / `C0OPS0001`. Message text is invented.
- **No new runtime or dev dependency** (rule 10). `next/font/google` is part of `next`.
- **Rule 6.** Components call `lib/api.ts` functions only. They don't compute health, pipeline, counts or annotations; those come from the API.
- **No Slack content in logs.** The new routes return text in responses only, never in logs or audit.
- **`bun run check` stays green** (tsc -b, biome, all tests), and `bun run --cwd apps/web build` passes at the end of every web task.
- **Class names use the `syn-` prefix.** Colours come only from CSS variables in `app/styles/tokens.css`, with no hex literals in components.
- **All copy follows the spec's wording.** No exclamation marks. Sentence case.

## Review Focus

1. **Empty and first-run states.** These apply when there is no identity, no messages, no candidates or no runs, and when the API is down. Every section renders a calm empty line, never a crash or "undefined". Tests are in Tasks 4, 5, 7 and 8.
2. **Expired content (`text: null`).** The inbox preview, thread messages, urgent cards and drafts show "content expired" and never an empty bubble. Tests are in Tasks 2 and 7.
3. **Deferred Undo racing a live refresh.** An item hidden pending commit must stay hidden when SSE refreshes the data before the 5 s elapse, and it must reappear on Undo. Tested in Task 3 (`useDeferred`) and Task 5.
4. **Theme flash and persistence.** If localStorage throws (private mode), the theme falls back to `prefers-color-scheme` without an error. Tested in Task 3.
5. **Palette keyboard nav at the list edges.** ↑ at 0 and ↓ at the last item clamp. Enter on an empty list does nothing. Tested in Task 4.

---

### Task 1: Dashboard overview endpoint and quota thresholds

**Files:**
- Modify: `packages/contracts/src/dashboard.ts` (add the `DashboardOverview`, `PipelineStageId` and `PipelineState` types from the spec)
- Create: `apps/api/src/modules/dashboard/service.ts`, `apps/api/src/modules/dashboard/pipeline.ts`, `apps/api/src/modules/dashboard/health-hints.ts`
- Create: `apps/api/src/routes/dashboard.ts`; register it in `apps/api/src/app.ts`; add `dashboard` to the container in `apps/api/src/container.ts`
- Modify: `apps/api/src/routes/claude.ts` (add `thresholds: QuotaThresholds` to the status response)
- Test: `apps/api/test/modules/dashboard.test.ts`, `apps/api/test/routes/dashboard.test.ts` (follow the existing route-test pattern under `apps/api/test/`)
- Docs: `docs/modules/dashboard.md` (new: endpoints, pipeline rules and hints, as in the spec)

**Interfaces:**
- Produces:
  - `GET /api/dashboard/overview → DashboardOverview`;
  - `GET /api/claude/status` gains `thresholds: { fiveHour: { soft, hard, stop }, sevenDay: { soft, hard } }` in the same units the settings store;
  - `pipelineStages(input: PipelineInput, now: Date): DashboardOverview["pipeline"]` (pure);
  - `HEALTH_LABELS: Record<string, string>` and `HEALTH_HINTS: Record<string, string>`.

- [ ] **Step 1: Write the failing tests for `pipelineStages`.** This is a pure function over a plain `PipelineInput`:
  ```ts
  {
    slack: { lastSuccessAt: string | null; error: boolean; stalled: boolean; searchesToday: number };
    rulesOk: boolean;
    openRedFlags: number;
    assess: { duePending: number; running: number; failedRecent: number };
    openUrgent: number;
    pendingApprovals: number;
  }
  ```
  The cases:
  - `collect` is `waiting` with no success, `ok` at 10 min, `waiting` at 26 min, and `failing` on error or stall;
  - `screen` is `failing` when `rulesOk` is false;
  - `assess` is `failing` when `failedRecent > 0`, even with some pending; `waiting` when pending or running; `ok` and "up to date" otherwise;
  - `surface` is `idle` at 0/0 and `ok` with 1 urgent;
  - the stage order is exactly `["collect","screen","assess","surface"]`, with labels "Collect", "Screen", "Assess" and "Surface".
- [ ] **Step 2: Run** `bun test apps/api/test/modules/dashboard.test.ts`. Expect FAIL (module not found).
- [ ] **Step 3: Implement `pipeline.ts` and `health-hints.ts`.** Thresholds, the summary formats and the hint text are verbatim from the spec.
- [ ] **Step 4: Write the failing service and route tests.** Build a real container on a temp DB, as other route tests do, and seed:
  - a confirmed self id with a person name;
  - one open urgent item;
  - one pending `slack.send` approval;
  - one open warning flag;
  - one commitment in review;
  - one draft follow-up.

  Assert:
  - the counts;
  - `self.name`;
  - `health.issues` lists only non-ok checks, each with a label and its hint (or null);
  - `engineeringLock` is null;
  - `generatedAt` is the clock time.

  Also add a test that `/api/claude/status` includes `thresholds` even when there is no snapshot (`quota: null`).
- [ ] **Step 5: Implement `DashboardService.overview()`.** Use existing services and stores (inbox, urgent, approvals, security flags, commitments, followups, people candidates, sync state, health). Don't duplicate their queries where a method exists. Each count must match what the corresponding existing list endpoint would return. `conversations` is the number of distinct conversations with stored messages.
- [ ] **Step 6: Run** `bun test apps/api` and `bun run check`. Expect PASS.
- [ ] **Step 7: Write `docs/modules/dashboard.md`, then commit:** `feat(api): dashboard overview endpoint, health hints and quota thresholds`.

### Task 2: Inbox conversations and thread endpoints

**Files:**
- Modify: `packages/contracts/src/dashboard.ts` (add `ConversationSummary`, `ThreadMessage` and `ConversationThread` from the spec)
- Create: `apps/api/src/modules/inbox/conversations.ts`
- Modify: `apps/api/src/routes/inbox.ts`
- Modify: `apps/api/src/integrations/slack/sender.ts` (export the existing `normalise` as `normaliseSentText`; don't change its behaviour)
- Test: `apps/api/test/modules/inbox-conversations.test.ts`
- Docs: `docs/modules/slack.md` (an "Inbox views" subsection naming the two routes)

**Interfaces:**
- Consumes: `normaliseSentText(s: string): string` from `sender.ts`.
- Produces:
  - `GET /api/inbox/conversations?limit=1..100 (default 50) → ConversationSummary[]`, newest `lastMessageAt` first;
  - `GET /api/inbox/conversations/:id/thread?limit=1..500 (default 200) → ConversationThread`. Messages are oldest first and are the newest `limit` of the conversation. Unknown id → 404 `{ error: "conversation not found" }`. The id must match `/^[CDG][A-Z0-9]+$/` (400 otherwise).

- [ ] **Step 1: Write the failing tests.** Seed a temp DB with self `U0SELF001`, partner Ada `U0ADA0001`, an im `D0ADA0001`, a self-DM `D0SELF001` (an im whose only sender is self) and a channel `C0OPS0001`. Assert:
  - list order;
  - `isSelfDm` is true only for the self DM;
  - `partner` is Ada for `D0ADA0001` and null for the channel;
  - `theyWroteLast` is true when Ada's message is the latest, and false for the channel and for the self DM;
  - `preview` is truncated to 140 chars, and is null when the latest text is null;
  - `awaitingApproval` is true when a pending approval's payload targets that conversation (seed it via the real `requestSend` path, or insert rows exactly as it does);
  - `openUrgent` lists the open urgent message.

  Thread:
  - oldest-first order;
  - `isSelf`;
  - `flag` carries the highest severity of two flags on one message;
  - `commitment` is set on a message cited in `commitment_sources`;
  - `sentViaSynapse` is `{status:"sent"}` for a self message whose text equals an outgoing row's text after normalisation (for example `&amp;` vs `&`, and extra spaces) with `sentAt` 2 min after `sendingAt`;
  - `sentViaSynapse` is null at 2 h after;
  - unknown id → 404, bad id → 400.
- [ ] **Step 2: Run them.** Expect FAIL.
- [ ] **Step 3: Implement `conversations.ts`.** Write it as a small class taking `{ db, settings }`, wired into the container next to `inbox`. Find the DM partner as the commitment extractor's `partnerOf` does (`workers/commitments/extract.ts`): the first non-self sender in the im. Use one grouped query for the list, not N+1 per conversation (except the partner lookup, which is bounded by `limit`).
- [ ] **Step 4: Add the routes.** Message text is never logged.
- [ ] **Step 5: Run** `bun test apps/api` and `bun run check`. Expect PASS.
- [ ] **Step 6: Update the docs and commit:** `feat(api): inbox conversation list and annotated thread endpoints`.

### Task 3: Web foundation (tokens, fonts, theme, shell, primitives, toasts)

**Files:**
- Create the styles: `apps/web/app/styles/tokens.css`, `base.css`, `shell.css`, `primitives.css`
- Modify: `apps/web/app/layout.tsx`
- Create the components: `apps/web/app/components/shell/Sidebar.tsx`, `shell/ThemeSwitch.tsx`, `ui/Avatar.tsx`, `ui/Button.tsx`, `ui/Chip.tsx`, `ui/Card.tsx`, `ui/Switch.tsx`, `ui/Segmented.tsx`, `ui/Toasts.tsx`
- Create the libs: `apps/web/lib/theme.ts`, `lib/avatar.ts`, `lib/deferred.ts`, `lib/format.ts`
- Modify: `apps/web/lib/api.ts` (add `getOverview()`, `getConversations(limit?)`, `getThread(id, limit?)`, and `thresholds` on `ClaudeStatus`)
- Modify: `apps/web/app/page.tsx` (wrap the existing sections in the shell, add section anchors, fetch the overview; the old sections stay for now)
- Test: `apps/web/test/theme.test.ts`, `avatar.test.ts`, `deferred.test.ts`, `format.test.ts`, `shell.test.tsx`, plus additions to `api.test.ts`

**Interfaces:**
- Consumes: the Task 1 and Task 2 endpoints and contract types.
- Produces (later tasks use exactly these):
  - **Theme:** `type Theme = "dark" | "light"`; `readTheme(storage: Pick<Storage,"getItem"> | null, prefersDark: boolean): Theme`; `writeTheme(storage, t): void` (swallows errors); `THEME_BOOT_SCRIPT: string`, an inline script that applies `data-theme` before paint.
  - **Avatar:** `hueFor(id: string): number` (0–359, stable); `initials(name: string | null, fallback: string): string` (max 2 letters, uppercase; `"?"` when nothing is usable).
  - **Format:** `timeOfDay(d: Date): "morning"|"afternoon"|"evening"|"late"` (5–11 morning, 12–16 afternoon, 17–21 evening, otherwise late); `greeting(d: Date, name: string | null): string`, e.g. "Good morning, Ada.", "Late night, Ada.", or "Good morning." with no name; `dateLine(d: Date): string`, e.g. "FRIDAY, 6 NOVEMBER · 2:25 AM" in the browser locale's time; `relMinutes(iso: string|null, now: Date): string` ("just now", "3 min ago", "2 h ago", "never"); `dayLabel(iso, now)` ("Today", "Yesterday", or "Thursday, 5 November").
  - **Deferred:** `createDeferred(opts: { delayMs: number; setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout })` returns `{ schedule(key: string, commit: () => Promise<void>): void; undo(key): boolean; pending(): Set<string>; flushAll(): void }`. A key is pending until its commit starts. `undo` after the commit started returns false. The hook `useDeferred(delayMs)` wraps it and re-renders on change.
  - **Components:**
    - `<Sidebar items={{id,label,count?,hot?}[]} active={string} onGo={(id)=>void} footer={{api:string; web:string; lock:string}} />`;
    - `<Avatar id name kind?="person"|"channel" size?=28 />`;
    - `<Button variant="primary"|"secondary"|"ghost"|"link" size?="sm"|"md">`;
    - `<Chip tone="neutral"|"red"|"amber"|"green"|"blue">`;
    - `<Card tone?="default"|"quiet">`;
    - `<Switch checked onChange label disabled? hint? />`;
    - `<Segmented options={{value,label}[]} value onChange ariaLabel />`;
    - `<Toasts />` together with `useToast(): { show(text: string, undo?: () => void): void }`, provided by a `ToastProvider`. Each toast shows for 5 s; one at a time, and the newest replaces any earlier one.

- [ ] **Step 1: Write the failing tests for the libs.**
  - `readTheme(null, true)` is `"dark"`.
  - A storage whose `getItem` throws gives the `prefersDark` fallback.
  - A stored `"light"` wins, and a stored junk value is ignored.
  - `hueFor` is stable across calls, in range and differs for two ids.
  - `initials("Ada Lovelace","U1")` is `"AL"`, and `initials(null,"U0ADA")` is `"U0"`.
  - `greeting` at 02:00 is `"Late night, Ada."`, and at 09:00 with a null name is `"Good morning."`.
  - `relMinutes` boundaries: 0 min → "just now", 59 → "59 min ago", 60 → "1 h ago", null → "never".
  - Deferred, with an injected fake timer:
    - schedule then undo → commit is never called;
    - schedule then elapse → commit is called once and the key leaves `pending()`;
    - `undo` after the commit started → `false`;
    - re-scheduling the same key replaces the first.
- [ ] **Step 2: Run** `bun test apps/web`. Expect FAIL.
- [ ] **Step 3: Implement the libs.**
- [ ] **Step 4: Write `tokens.css`.** Copy the spec's palette verbatim, as below. Then write `base.css` (body, links, focus-visible ring `2px solid var(--blueFg)`, `@keyframes synPulse` and `synIn`, `prefers-reduced-motion` disabling both), `shell.css` (fixed 212 px sidebar, main column max-width 920 px with 28 px padding, the D15 breakpoint at 900 px) and `primitives.css`.
  ```css
  :root{--bg:#131210;--surface:#1b1a17;--surface2:#171614;--subtle:#211f1c;--subtle2:#272521;--chip:#2a2824;--navActive:#2f2c27;--line:#2b2925;--line2:#242220;--btnLine:#39362f;--lineHover:#4d4940;--toggleOff:#3e3a33;--ink:#ede8de;--onInk:#161513;--inkHover:#d5cfc3;--ink2:#c6bfb2;--muted:#a69e90;--muted2:#8f8779;--faint:#7a7365;--faint2:#5c574d;--hover:#211f1c;--panel:#1f1d1a;--panelInk:#f3efe6;--panelBorder:#302d28;--panelLine:#3a362f;--redBg:oklch(0.29 0.06 28);--redFg:oklch(0.8 0.12 28);--redLine:oklch(0.42 0.1 28);--amberBg:oklch(0.29 0.05 80);--amberFg:oklch(0.86 0.11 80);--amberLine:oklch(0.45 0.08 80);--greenBg:oklch(0.29 0.045 155);--greenFg:oklch(0.8 0.11 155);--blueBg:oklch(0.29 0.045 255);--blueFg:oklch(0.8 0.09 255);--blueLine:oklch(0.45 0.07 255);--avBgL:0.35;--avFgL:0.87;--dotOk:oklch(0.65 0.14 155);--dotWarn:oklch(0.75 0.15 75);--dotIdle:#4a453c;--high:oklch(0.48 0.11 70);color-scheme:dark}
  :root[data-theme="light"]{--bg:#f6f4ef;--surface:#fffefb;--surface2:#fbf9f4;--subtle:#f1eee7;--subtle2:#e9e5dc;--chip:#ece8df;--navActive:#e3ded3;--line:#e7e2d8;--line2:#efebe3;--btnLine:#e1dbcf;--lineHover:#cfc8ba;--toggleOff:#d9d3c7;--ink:#24211c;--onInk:#fbfaf7;--inkHover:#3a362f;--ink2:#4b463d;--muted:#6f685d;--muted2:#8a8273;--faint:#9a9284;--faint2:#b9b1a2;--hover:#f4f1ea;--panel:#1f1d19;--panelInk:#f3efe6;--panelBorder:transparent;--panelLine:#3a362f;--redBg:oklch(0.95 0.03 28);--redFg:oklch(0.5 0.17 28);--redLine:oklch(0.85 0.07 28);--amberBg:oklch(0.95 0.045 85);--amberFg:oklch(0.44 0.1 70);--amberLine:oklch(0.86 0.07 80);--greenBg:oklch(0.95 0.035 155);--greenFg:oklch(0.45 0.1 155);--blueBg:oklch(0.95 0.03 255);--blueFg:oklch(0.45 0.12 255);--blueLine:oklch(0.85 0.04 255);--avBgL:0.91;--avFgL:0.38;color-scheme:light}
  ```
  The visual reference for each primitive is below. Corners are 8 px on controls, 14 px on cards and 999 px on chips and pills. Text is 14 px with line-height 1.5, and the mono labels (kind tags, meta) are 11.5 px with letter-spacing .06em, uppercase where they are tags.

  | Primitive | Look |
  |---|---|
  | Primary button | `--ink` background, `--onInk` text |
  | Secondary button | `--surface` background, 1 px `--btnLine` border |
  | Ghost button | Transparent background, `--muted` text |
  | Link button | `--blueFg` text |
  | Card | `--surface` background, 1 px `--line` border, 18–20 px padding |
  | Kind tag (e.g. "RED FLAG · WARNING") | A mono chip in its tone's `--*Bg` / `--*Fg` |
  | Sidebar | `--subtle` background. The active nav item is `--navActive`. The count badge is `--ink`/`--bg` when hot, `--navActive`/`--muted` otherwise |
  | Footer card | `--subtle2`, mono 11.5 px rows |
- [ ] **Step 5: Update `layout.tsx`.** Load the fonts with `next/font/google` (`IBM_Plex_Sans` weights 400–700 and `IBM_Plex_Mono` weights 400 and 500, `variable` set to `--font-sans` and `--font-mono`, `display: "swap"`). Apply both variables on `<html>`, import the four stylesheets, put `THEME_BOOT_SCRIPT` in `<head>` (a `dangerouslySetInnerHTML` script) and wrap children in `ToastProvider`. Read the Next 16 font doc in `node_modules/next/dist/docs/` first.
- [ ] **Step 6: Write the failing `shell.test.tsx`.** `renderToString` of `<Sidebar>` with counts shows "Needs you", the count "4" and "Runs locally. Nothing leaves this machine without your approval.", and shows no badge when the count is 0. The footer's lock text is "not in use yet" when given that. `<Switch disabled>` renders `role="switch"`, `aria-checked="false"` and `aria-disabled="true"`. `<Segmented>` renders `role="radiogroup"` with exactly one `aria-checked="true"`.
- [ ] **Step 7: Implement the components.** Then restructure `page.tsx`:
  - the shell with the sidebar (ids `overview`, `triage`, `inbox`, `commitments`, `people`, `system`; counts from the overview);
  - the main column, holding the existing sections inside `<section id=…>` wrappers;
  - the overview added to `refresh()`'s `Promise.allSettled`.

  The active section comes from an IntersectionObserver. `ThemeSwitch` uses `readTheme`/`writeTheme` and sets `document.documentElement.dataset.theme`.
- [ ] **Step 8: Run the checks.** `bun run check` and `bun run --cwd apps/web build` must both PASS.
- [ ] **Step 9: Commit:** `feat(web): design tokens, Plex fonts, theme switch, app shell and UI primitives`.

### Task 4: Header (greeting, briefing, health pill, away toggle, command palette)

**Files:**
- Create: `apps/web/app/components/header/Header.tsx`, `header/HealthPill.tsx`, `header/CommandPalette.tsx`
- Create: `apps/web/lib/briefing.ts`, `apps/web/lib/palette.ts`
- Modify: `apps/web/app/styles/shell.css` (header and palette styles), `apps/web/app/page.tsx` (replace the old `<h1>` + `HealthBadge`)
- Delete: `apps/web/app/components/HealthBadge.tsx`
- Test: `apps/web/test/briefing.test.ts`, `palette.test.ts`, `header.test.tsx`

**Interfaces:**
- Consumes: `DashboardOverview`, plus `greeting`, `dateLine` and `relMinutes` from Task 3.
- Produces:
  - `briefing(o: DashboardOverview, now: Date): string`;
  - `type PaletteItem = { id: string; label: string; group: "go to" | "conversation" | "person" | "action"; run: () => void }`;
  - `filterPalette(items: PaletteItem[], q: string): PaletteItem[]`: case-insensitive substring over `label + " " + group`; empty `q` returns all;
  - `movePalette(i: number, delta: 1 | -1, len: number): number`: clamps; 0 when `len` is 0;
  - `<Header overview now onOpenPalette />` and `<CommandPalette open items onClose />`.

- [ ] **Step 1: Write the failing `briefing` tests.** The format:
  - first, "Nothing urgent." or "<n> urgent item(s).";
  - then, in this order, the non-zero parts: "<n> message(s) awaiting approval", "<n> send(s) need attention", "<n> red flag(s)", "<n> follow-up draft(s)", "<n> possible commitment(s)", "<n> profile suggestion(s)", "<n> setup step(s)";
  - setup steps count: identity unconfirmed, `peopleToEvaluate > 0`, and backfill not started;
  - the parts are joined as "a, b and c waiting on you.";
  - with none: "You're all caught up.";
  - then " Slack synced <relMinutes>." or " Slack hasn't synced yet.".

  Exact-string cases:
  - all zero with a sync 3 min ago → `"Nothing urgent. You're all caught up. Slack synced 3 min ago."`;
  - 1 flag + 1 commitment + 2 setup → `"Nothing urgent. 1 red flag, 1 possible commitment and 2 setup steps waiting on you. Slack synced 3 min ago."`.

  Briefing needs the backfill state and the identity, so pass them in as a second options argument: `briefing(o, now, { backfillStarted: boolean })`. `self.slackUserId === null` means the identity is unconfirmed.
- [ ] **Step 2: Write the failing `palette` tests.** `filterPalette` matches "inb" against "Inbox"; an empty query returns all; `movePalette` clamps at both ends and gives 0 when `len` is 0.
- [ ] **Step 3: Implement the libs.** Run their tests. Expect PASS.
- [ ] **Step 4: Write the failing `header.test.tsx`.** It covers:
  - the greeting with the name, and without one;
  - the Away switch is disabled and has the D9 text;
  - the health pill reads "Healthy" (green dot), "Degraded · 1 check" or "Down · n checks";
  - the popover (rendered open via a prop `initiallyOpen` used only in tests) lists each issue's label, detail and hint;
  - the palette rendered open shows `role="dialog"` and "No matches." for an empty list.
- [ ] **Step 5: Implement the components.**
  - **Health pill.** It toggles the popover, which closes on Esc and on an outside click. The design's popover title is "Why “degraded”?", followed by issue rows (dot, label, detail) and, for the first issue with a hint, "Most likely fix: <hint>".
  - **Palette items**, built in `page.tsx`:
    - go-to entries for each section;
    - one entry per conversation (opens it in the inbox), from `getConversations`;
    - one per person (opens the profile drawer);
    - actions: "Start 90-day Slack backfill" (scrolls to the backfill card in confirm state), "Show system health" and "Toggle theme".
  - **Keyboard.** ⌘K/Ctrl+K toggles the palette. ↑/↓ move, Enter runs the item, Esc closes and focus returns to the opener.
- [ ] **Step 6: Run the checks.** `bun run check` and the web build. Expect PASS.
- [ ] **Step 7: Commit:** `feat(web): header with greeting, briefing, health explanation and command palette`.

### Task 5: Needs-you feed

**Files:**
- Create: `apps/web/lib/needs-you.ts`
- Create the cards: `apps/web/app/components/triage/NeedsYou.tsx`, `triage/UrgentCard.tsx`, `triage/ApprovalCard.tsx`, `triage/OutgoingAttentionCard.tsx`, `triage/FlagCard.tsx`, `triage/FollowupCard.tsx`, `triage/CommitmentReviewCard.tsx`, `triage/RecommendationCard.tsx`, `triage/SetupCards.tsx` (identity, people and backfill), `triage/AllClear.tsx`
- Create: `apps/web/app/styles/cards.css`
- Modify: `apps/web/app/page.tsx`
- Delete these old components: `UrgentInbox`, `ApprovalsList`, `RedFlags`, `FollowupDrafts`, `ProfileRecommendations`, `IdentitySetup`. (`SlackStatus` stays until Task 6, which moves its skip action; its backfill button moves here, so remove only that button from it.) First port their tests in `test/components.test.tsx` into `test/triage.test.tsx`, keeping every behavioural assertion; copy that changes wording follows the spec.
- Test: `apps/web/test/needs-you.test.ts`, `apps/web/test/triage.test.tsx`

**Interfaces:**
- Consumes:
  - the existing `lib/api.ts` actions (`setUrgentStatus`, `requestUrgentReply`, `resolveOutgoing`, `decideApproval`, `reviewFlag`, `getPersonFlags`, `sendFollowup`, `discardFollowup`, `reviewCommitment`, `decideProposal`, the recommendation actions, `confirmSlackIdentity`, `startBackfill`, `evaluatePerson`);
  - `useDeferred`, `useToast` and the primitives from Task 3.
- Produces:
  - `type NeedsCard = { key: string; kind: "urgent"|"outgoing"|"approval"|"flag"|"followup"|"commitment"|"recommendation"|"setup-identity"|"setup-people"|"setup-backfill"; rank: number; data: unknown }`. In the implementation, use a discriminated union keyed by `kind` instead of `unknown`.
  - `buildNeedsYou(input: { urgent; approvals; flags; followups; reviewQueue; recommendations; identity; candidates; slackStatus; hidden: Set<string> }): NeedsCard[]`, sorted by the D7 order, with `hidden` keys removed;
  - `allClearRows(input) → { label: string; value: string }[]`: one row for each empty category among Urgent inbox, Pending approvals, Profile suggestions and Red flags.

- [ ] **Step 1: Write the failing `needs-you` tests.** Covered:
  - D7 order across a mixed input;
  - urgent critical before high before medium;
  - high flags before warning;
  - outgoing sends in `needs_attention` (from urgent or follow-up items with `reply.status === "needs_attention"`) appear as `outgoing` cards ahead of approvals;
  - the setup-identity card only when there is no self id and a suggestion or people exist;
  - the setup-people card only when there are candidates;
  - the setup-backfill card only while the backfill is not done;
  - hidden keys are excluded;
  - `allClearRows` lists exactly the empty categories.
- [ ] **Step 2: Implement `needs-you.ts`.** Run its tests. Expect PASS.
- [ ] **Step 3: Port and extend the component tests.** All behaviour of the old components stays, including:
  - the status transitions;
  - the draft label "Draft — not sent";
  - Copy, shown only for live text;
  - "content expired";
  - the R17 coalesced tag;
  - the outgoing resolve choices (mark sent, resend, discard);
  - the approval's exact text and recipient;
  - the recommendation evidence and decisions;
  - identity confirm;
  - backfill resumable;
  - the skip-unreadable-page action (this moves to Task 6's System section, so its test moves with it).

  New assertions:
  - the kind tags read "URGENT · CRITICAL", "APPROVAL · SLACK SEND", "RED FLAG · WARNING", "POSSIBLE COMMITMENT", "FOLLOW-UP DRAFT", "PEOPLE MEMORY · SETUP" and "SLACK · SETUP";
  - the flag card shows the excerpt in a `<blockquote>` and the line "This text is marked untrusted and never reaches a worker that can send, edit or run anything.";
  - the backfill card has two steps ("Start backfill…" → a confirm panel showing "7-day usage is at <n>%" from the Claude status, with Start now and Cancel);
  - the commitment review card has "Track it" (accept, with the existing optional edits) and "Not a commitment" (deferred reject);
  - `AllClear` renders ✓ rows.
- [ ] **Step 4: Implement the cards.**
  - **D8 deferral:** flag review, commitment reject, recommendation dismiss and follow-up discard go through `useDeferred` and are hidden while pending. Their toasts read "Red flag acknowledged", "Marked as not a commitment", "Suggestion dismissed" and "Draft discarded", each with Undo. Hidden keys are passed into `buildNeedsYou`, so an SSE refresh can't resurrect them.
  - **Immediate actions:** approve, reject, send, request-reply, evaluate and backfill run at once and show plain toasts, for example "Approval request created · nothing is sent until you approve" and "Backfill queued · runs in the background".
  - **Flag history:** the flag card's "History ↗" expands the per-person history inline, as `RedFlags` did.
  - **Section header:** "Needs you" with a count chip and the subtitle "Decisions only you can make. Ordered by impact."
- [ ] **Step 5: Run the checks.** `bun run check` and the web build. Expect PASS.
- [ ] **Step 6: Commit:** `feat(web): needs-you decision feed with deferred undo`.

### Task 6: How Synapse is running, and System

**Files:**
- Create: `apps/web/app/components/system/Running.tsx`, `system/QuotaBars.tsx`, `system/SystemDetails.tsx`
- Create: `apps/web/lib/job-labels.ts`
- Create: `apps/web/app/styles/system.css`
- Modify: `apps/web/app/page.tsx`
- Delete: `JobsTable`, `ClaudePanel`, `SlackStatus` (port their tests)
- Test: `apps/web/test/system.test.tsx`, `apps/web/test/job-labels.test.ts`

**Interfaces:**
- Consumes: `overview.pipeline`, `ClaudeStatus` (with `thresholds`), `ClaudeRun[]`, `Job[]`, `SlackStatusDto` and `skipUnreadablePage`.
- Produces:
  - `jobLabel(type: string): string`. The known labels are listed below; an unknown type returns the type itself.
  - `<Running pipeline status runs />` and `<SystemDetails jobs slack runs onSkip />`.

  | Job type | Label |
  |---|---|
  | `system.heartbeat` | Heartbeat |
  | `slack.collect_incremental` | Collect new Slack messages |
  | `slack.backfill_page` | Slack backfill page |
  | `slack.retention_cleanup` | Delete expired messages |
  | `urgency.assess` | Urgency assessment |
  | `people.generate_initial_profile` | Draft a person profile |
  | `people.recommend_update` | Profile update suggestions |
  | `people.expire_temporary` | Expire temporary contacts |
  | `commitments.extract` | Find commitments |
  | `commitments.stall_check` | Check stalled commitments |
  | `commitments.remind` | Commitment reminders |
  | `followup.draft` | Draft a follow-up |
  | `approval.execute` | Run an approved action |
  | `outgoing.verify` | Verify a sent message |

  Before writing the table, check the real job type strings with `grep -rn 'type: "' apps/api/src/workers` and use only types that exist.

- [ ] **Step 1: Write the failing tests.**
  - `jobLabel` returns known and unknown types as specified.
  - `Running` renders the four stages, with `data-state` on each dot, and the explainer "Messages are collected every 10 minutes, screened with cheap rules, and only likely-urgent ones go to Claude.".
  - Quota bars show "Five-hour window <p>%" and "Seven-day window <p>%", with a marker at the soft threshold, `title="Non-urgent jobs pause above this"`, and the caption "Marker = pause threshold for non-urgent jobs, keeping headroom for your own Claude Code work.".
  - With quota null: "No quota reading yet.".
  - Claude login shows "<d>d <h>h left" from `refreshExpiresAt`, or "unknown".
  - The last run shows "Succeeded · 11.4s" / "collector · haiku", or "No Claude runs yet.".
  - The engineering task shows "None running" / "lock not in use yet" (D11).
  - System: the job rows show the label, mono type, status chip (PENDING amber, COMPLETED green labelled DONE, FAILED red, NEEDS_ATTENTION red) and "attempts/max · time".
  - Slack rows: Last sync, Searches today, 90-day backfill (not started, running with pages done, done, or failed), and checkpoint.
  - The skip button appears only when the incremental stream is stalled, as before.
  - The Claude runs table is kept, ported from `ClaudePanel`.
- [ ] **Step 2: Implement the components.** The dark pipeline panel uses `--panel` and `--panelInk` in both themes, as the design does. The amber stage dot gets the `synPulse` ring.
- [ ] **Step 3: Run the checks.** `bun run check` and the web build. Expect PASS.
- [ ] **Step 4: Commit:** `feat(web): pipeline, quota and system sections`.

### Task 7: Inbox (conversation list, thread, composer)

**Files:**
- Create: `apps/web/app/components/inbox/Inbox.tsx`, `inbox/ConversationList.tsx`, `inbox/Thread.tsx`, `inbox/Composer.tsx`
- Create: `apps/web/lib/inbox.ts`
- Create: `apps/web/app/styles/inbox.css`
- Modify: `apps/web/app/page.tsx` (selected conversation state and thread fetch, refetched in `refresh()`)
- Delete: `InboxPanel` (port its tests)
- Test: `apps/web/test/inbox.test.ts`, `apps/web/test/inbox-ui.test.tsx`

**Interfaces:**
- Consumes: `getConversations`, `getThread`, `requestUrgentReply`, `reviewCommitment`, the urgent items (for drafts), and `dayLabel` / `Avatar` from Task 3.
- Produces:
  - `type InboxFilter = "all" | "dm" | "channel" | "waiting"`;
  - `filterConversations(list: ConversationSummary[], f: InboxFilter): ConversationSummary[]`. `dm` covers im, mpim and the self DM; `channel` covers channels; `waiting` covers `theyWroteLast`.
  - `conversationChip(c): { label: string; tone: ChipTone }`, with this precedence: "Awaiting approval" (blue); "Urgent" (red, when `openUrgent` is non-empty); "Channel"; "Notes" (self DM); "They wrote last"; otherwise "You replied" (neutral).
  - `groupThread(msgs: ThreadMessage[], now: Date): Array<{ daySep: string | null; showHead: boolean; m: ThreadMessage }>`. `showHead` is true on a new day, a sender change, or a gap over 5 min.
  - `composerState(c, urgentById): { mode: "reply"; urgentId: string; draft: string | null } | { mode: "note"; text: string }`.

- [ ] **Step 1: Write the failing lib tests.** `filterConversations` for each filter. `conversationChip` precedence. `groupThread`'s day separators across midnight, head grouping at 4 vs 6 min, and the sender change. `composerState`:
  - reply mode when `openUrgent` is non-empty, using the first open item's draft text;
  - note mode texts: "Reply is waiting for your approval in Needs you." when `awaitingApproval`; "Your own notes. Not screened." for the self DM; "They wrote last." when `theyWroteLast`; otherwise "You replied last. Nothing waiting.".
- [ ] **Step 2: Implement `lib/inbox.ts`.** Run its tests. Expect PASS.
- [ ] **Step 3: Write the failing UI tests.**
  - The header reads "Inbox", with the summary "<n> messages · <k> conversations".
  - The filter tabs are All, Direct, Channels and They wrote last, with `aria-pressed` on the active one.
  - List rows show the avatar (`#` for channels), the title (partner name, channel `#name`, or "Notes to self"), the time, the preview with a "You: " prefix when self wrote last, the chip, and "<n> msgs".
  - The empty filter reads "Nothing in this view.".
  - The thread header shows the name, the sub-line ("Direct message · <n> messages", "Channel", or "Self DM") and "Open in Slack ↗" only when a permalink exists.
  - Expired messages read "content expired".
  - A flagged message carries "Flagged: <reason>. Treated as untrusted. Synapse never follows instructions found inside messages.".
  - A commitment in review shows "Looks like a commitment. Track it?" with Track and Ignore buttons. An accepted one shows "Tracking: <description>".
  - A sent message shows "sent via Synapse · approved by you · delivery verified", or "… · delivery not yet verified" for `sent_unverified`.
  - The composer in reply mode shows the textarea prefilled, "Edit freely. Sending needs your approval.", Discard and "Request approval to send".
  - With no conversations: "No messages collected yet.".
- [ ] **Step 4: Implement the components.** Ignore uses a deferred commitment reject (D8). Track calls accept. "Request approval to send" calls `requestUrgentReply(urgentId, text)` and toasts "Approval request created · nothing is sent until you approve". The thread pane scrolls to the newest message when a conversation opens. The palette's conversation entries call the same `openConversation(id)`.
- [ ] **Step 5: Run the checks.** `bun run check` and the web build. Expect PASS.
- [ ] **Step 6: Commit:** `feat(web): conversation inbox with annotated threads and approval-gated replies`.

### Task 8: People and Commitments sections

**Files:**
- Create: `apps/web/app/components/people/People.tsx`, `people/ReadyToEvaluate.tsx`, `people/PriorityList.tsx`, `people/ProfileDrawer.tsx`, `commitments/Commitments.tsx`
- Create: `apps/web/app/styles/people.css`
- Modify: `apps/web/app/page.tsx`
- Delete: `PeopleCandidates`, `PriorityPeople`, `PersonProfile`, `CommitmentsPanel` (port all their tests into `test/people.test.tsx` and `test/commitments.test.tsx`)
- Test: `apps/web/test/people.test.tsx`, `apps/web/test/commitments.test.tsx`

**Interfaces:**
- Consumes: `CandidatesResponse`, `PersonDto[]`, `PersonDetail`, `identity.selfUserId`, `evaluatePerson`, `setPersonPriority`, the commitment actions, and the `Segmented`, `Switch`, `Avatar` and `useToast` primitives.
- Produces: `<People candidates people self onEvaluate onPriority onOpen />`, `<ProfileDrawer person onClose onEvaluate onPriority />` and `<Commitments queue items filter onFilter … />`, with the same callbacks as the old `CommitmentsPanel`.

- [ ] **Step 1: Write the failing tests** (the ported assertions plus the following).
  - **Section header:** "People", with "Profiles exist only for people you choose. Claude never changes priority.".
  - **Ready to evaluate:**
    - the subtitle "Ranked by how much you talk to them";
    - rows show the avatar, the name, "score <s> · <n> msgs" and a bar with width `max(score,2)%` (scores are 0–100 as returned);
    - the Evaluate button is primary for score ≥ 30 and secondary otherwise;
    - a queued row shows "Queued · draft profile will appear in Needs you for approval";
    - "Evaluate top 3" calls `onEvaluate` for the first three unqueued candidates, in order;
    - with no candidates: "No one to evaluate right now.".
  - **Priority:**
    - the subtitle "Extra attention screens a person's messages more carefully.". Don't mention away-mode auto-replies until 6b; this is D9;
    - the filter input is labelled "Filter people";
    - each row has a Low/Normal/High radiogroup and an "Extra attention" switch;
    - the self id is excluded, with the line "<self name> is you, so you are left out of this list." when self is known;
    - changing either control calls `onPriority` with the person's existing rationale, as before.
  - **Profile drawer:** `role="dialog"` with an accessible name of the person, all the existing `PersonProfile` content, and Close.
  - **Commitments:** every existing panel behaviour (the filter tabs, status transitions, proposals, draft follow-up), restyled as cards with a direction chip ("You owe" amber, "Owed to you" blue). This is the D1 section, with the subtitle "Promises made by you and to you, confirmed by you.".
- [ ] **Step 2: Implement the components.**
- [ ] **Step 3: Run the checks.** `bun run check` and the web build. Expect PASS.
- [ ] **Step 4: Commit:** `feat(web): people and commitments sections with profile drawer`.

### Task 9: Assembly, cleanup, docs and smoke

**Files:**
- Modify: `apps/web/app/page.tsx` (final order: header → Needs you + Running in a two-column grid ≥ 1100 px, as the design does, otherwise stacked → Inbox → Commitments → People → System). Remove any leftover old imports and inline `style={…}` colours.
- Delete: any component left unused (`git grep` each file in `app/components/*.tsx` at top level).
- Modify: `docs/product/roadmap.md` (Phase 7 status), `docs/architecture/system-architecture.md` (only if it describes the web page layout), `CLAUDE.md` (only if a command changed; none should)
- Create: `docs/superpowers/plans/2026-11-06-phase-7-followups.md` (deferred items: a Claude reply draft for any conversation (D10); Away mode wiring (6b); a custom layout (Phase 11))
- Test: `apps/web/test/page-wiring.test.tsx`, a static test asserting what's listed in Step 1.

- [ ] **Step 1: Write the failing `page-wiring` test.** Read `app/page.tsx` as text and assert:
  - it contains each section id;
  - it imports none of the deleted component files;
  - no file under `apps/web/app/components/` contains a `#` hex colour literal (regex `/#[0-9a-fA-F]{3,8}\b/` in `.tsx` files).
- [ ] **Step 2: Finish the assembly.** Make the test pass.
- [ ] **Step 3: Run** `bun run check` and `bun run --cwd apps/web build`. Expect PASS.
- [ ] **Step 4: Smoke the real app against an empty temp DB.** Start the API with a temp DB path, as the dev smoke scripts do, plus the web dev server. Load `/` and `/?theme` toggled in both themes. Check that every section renders its empty state and that the browser console shows no errors. Use the `run` skill's browser pattern if available, otherwise `curl` the HTML for section ids. Record the result in the follow-ups file. Use no real data; don't point it at the user's DB.
- [ ] **Step 5: Update the docs and commit:** `feat(web): assemble redesigned dashboard; phase 7 docs and follow-ups`.
