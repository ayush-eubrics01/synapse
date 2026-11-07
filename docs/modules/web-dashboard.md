# Web dashboard

The single page in `apps/web` (Next.js). Phase 7 rebuilt it from the user's design. The spec is `docs/superpowers/specs/2026-11-06-phase-7-design-revamp.md`, and its "Deviations during implementation" section lists where the build differs from it.

## Presentation versus backend

The page holds no business logic (CLAUDE.md rule 6). Every count, state, health explanation, pipeline stage, thread annotation and allowed action comes from the API (`GET /api/dashboard/overview`, `/api/inbox/conversations`, `/api/inbox/conversations/:id/thread` and the existing list endpoints). `apps/web/lib/` holds only pure presentation functions, each unit-tested: the briefing sentence, Needs-you card order, conversation titles and chips, job labels, palette filtering, and the theme rules. Live updates use one SSE stream with a debounced refresh of everything.

## Layout

One scrolling page with anchored sections. The sidebar scrolls to a section and highlights the one in view.

| Section id | Content |
|---|---|
| `overview` | Header: date, greeting with the confirmed identity's name, a one-line briefing, ⌘K, the Away mode toggle (Phase 6b: starts and ends an away session), and the health pill with its fix hints |
| `triage` | Needs you: one decision feed in a fixed order, then the all-clear checklist |
| `running` | How Synapse is running: the pipeline, quota bars with threshold markers, Claude login, the last run, and the engineering lock ("not in use yet") |
| `inbox` | Conversation list (All, Direct, Channels, They wrote last), the annotated thread, and a composer that acts only on an open urgent item |
| `commitments` | The tracked list. Review happens in Needs you |
| `people` | Ready to evaluate, the Priority list, and the profile drawer |
| `system` | Background jobs, Slack collection, and the Claude runs table |

From 1100 px wide, Needs you and Running share a two-column row. Below that they stack. Below 900 px the sidebar becomes a top strip. Sidebar badges: Needs you shows the number of actionable cards (a running backfill card doesn't count), Inbox shows conversations where they wrote last, and Commitments and People show counts from the overview.

## Theme and styling

- Plain global CSS in `app/styles/*.css`, with `syn-` class names. Colours come only from CSS variables in `tokens.css`, dark and light. No component holds a hex literal, and `test/page-wiring.test.tsx` enforces this.
- The theme follows `prefers-color-scheme` until the user picks one, which is stored in `localStorage["synapse.theme"]`. A boot script in `<head>` applies it before first paint. The switch and the boot script share one rule: missing storage or `matchMedia` means light.
- IBM Plex Sans and Mono are self-hosted with `next/font` at build time.
- The command palette (⌘K) covers go-to, conversations, people, starting the backfill, system health and the theme toggle. It filters with a pure function and returns focus to the control that opened it.

## Actions

- **Deferred undo (D8).** Four decisions change only local state: red-flag review, rejecting a commitment, dismissing a profile suggestion and discarding a follow-up draft. Each is held for 5 s behind a toast with Undo. The toast shows for 4.5 s, so Undo is never offered once the commit may have started; an Undo that arrives too late shows "Too late to undo". If the page closes in that time, nothing changes. A failed deferred commit is reported on its own error channel, which later actions never clear (only Dismiss does).
- Anything that sends, approves, queues a Claude run or starts a backfill calls the API at once, with a plain confirmation toast. Every send still goes through an approval.
- **Queued evaluations.** The candidates API has no "queued" flag, so the page keeps the ids evaluated this session (`useQueuedEvaluations`) and shares them between People, the profile drawer and the Needs-you people setup card, which shows them as "Queued". An id drops out once it leaves the candidate list.
- **Overview failures.** A network failure (fetch throws) shows the pill "Unreachable" and "Can't reach the Synapse API.". An HTTP error from the overview (an `ApiError` with its status) shows "Overview unavailable", a popover with "The API answered with an error (<status>). Check the API logs.", and the briefing "Couldn't load the overview." (or "Couldn't refresh the overview. Showing the last data loaded." when an earlier overview is kept).
- **Needs you.** The identity setup card shows whenever no Slack identity is confirmed, matching the briefing's setup count; with no suggestion and no known users it says so. The card list renders whenever there are cards, so a running-backfill card is visible even though it isn't counted.

## Customise mode and layouts (Phase 11, D5)

The page renders its sections (all but the literal Overview) from the active layout returned by `GET /api/dashboard/layouts`; the web never normalises. `lib/layout.ts` holds the pure helpers (`moveSection`, `moveVisible`, `setVisible`, `setCollapsed`, `setWidth`, `layoutRows`, labels, error texts) and `lib/layout-saver.ts` the 500 ms debounced PUT. Needs you can be neither hidden nor collapsed. Two consecutive visible `half` sections form a `.syn-pair` (side by side from 1100 px). The header "Customise" / "Done" toggle (also ⌘K "Customise dashboard") shows a per-section button toolbar, the "Hidden sections" tray and the layout picker. A collapsed section shows its header and count badge and expands locally on click. Picker calls (switch, save as new, rename, delete, reset) are serialised: while one runs the picker, the tray and the section toolbars are disabled and a second call is refused. A pending edit is flushed (awaited) before a switch, save as new or reset, and a failed flush cancels the call. A switch applies the layout list the server answers with (no refetch race), and a failed activate toasts "Couldn't switch the layout". A failed save toasts "Couldn't save the layout" and reloads the stored layout. A live refresh that lands while a save is pending (`saver.isBusy()`) leaves the local layout alone, so an unsaved edit is never undone. Hidden sections leave the sidebar and the "go to" palette items; the profile drawer lives at page level so it still opens when People is hidden.

Behaviours worth knowing:

- **Needs you is always visible.** It has no Hide or Collapse control, and the backend forces it back if a request tries.
- **Navigation reveals.** Using the sidebar or the palette on a section that is hidden or collapsed shows or expands it temporarily, locally, without saving. The next layout load puts it back.
- **Drafts survive customise actions.** Reply, code-answer and follow-up drafts survive customise actions and layout switches because they live in an in-memory store (`lib/drafts.ts`), lost on reload; other form fields do not survive a remount. The layout itself is never affected.
- **Save and switch.** Edits are debounced 500 ms into one PUT. Switching, saving as new and resetting flush a pending save first; renaming and deleting do not. Two minor races are parked in the follow-ups file.

## System Runtime panel (Phase 11, R5)

`RuntimePanel` sits in the System section beside the Claude Code settings. It renders `GET /api/system/runtime` (uptime, version or "unknown", memory, database plus WAL, free space, queue counts, last backup, retention last-run counts or "Retention has not run yet") and `GET /api/system/backups` (names and sizes only; the backup directory path never reaches the web). "Back up now" posts `/api/system/backups` and toasts "Backup started" (409: "A backup is already running"; other errors: "Couldn't start the backup"). A started backup can still fail, so the panel shows a failure line from `runtime.lastBackupAttempt` (read from the audit log, not from the `ops.backup` job) when the latest attempt failed. When `ops.backup.enabled` is off the panel adds "Automatic backups are off; Back up now still makes one" under the Backups heading. The R7 settings (`ops.backup.enabled` switch and eight number inputs with the API's bounds) save through `PUT /api/settings`.
