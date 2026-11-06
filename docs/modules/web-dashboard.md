# Web dashboard

The single page in `apps/web` (Next.js). Phase 7 rebuilt it from the user's design. The spec is `docs/superpowers/specs/2026-11-06-phase-7-design-revamp.md`, and its "Deviations during implementation" section lists where the build differs from it.

## Presentation versus backend

The page holds no business logic (CLAUDE.md rule 6). Every count, state, health explanation, pipeline stage, thread annotation and allowed action comes from the API (`GET /api/dashboard/overview`, `/api/inbox/conversations`, `/api/inbox/conversations/:id/thread` and the existing list endpoints). `apps/web/lib/` holds only pure presentation functions, each unit-tested: the briefing sentence, Needs-you card order, conversation titles and chips, job labels, palette filtering, and the theme rules. Live updates use one SSE stream with a debounced refresh of everything.

## Layout

One scrolling page with anchored sections. The sidebar scrolls to a section and highlights the one in view.

| Section id | Content |
|---|---|
| `overview` | Header: date, greeting with the confirmed identity's name, a one-line briefing, ⌘K, the Away mode toggle (disabled until Phase 6b), and the health pill with its fix hints |
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

- **Deferred undo (D8).** Four decisions change only local state: red-flag review, rejecting a commitment, dismissing a profile suggestion and discarding a follow-up draft. Each is held for 5 s behind a toast with Undo. If the page closes in that time, nothing changes. A failed deferred commit is reported on its own error channel, which later actions never clear (only Dismiss does).
- Anything that sends, approves, queues a Claude run or starts a backfill calls the API at once, with a plain confirmation toast. Every send still goes through an approval.
