# Phase 7: Design Revamp — Design

**Source:** the user's design at `~/designs-claude/Dashboard UX redesign/Synapse Dashboard.dc.html`, plus the screenshots in `scraps/`, and the roadmap entry `docs/product/roadmap.md` §Phase 7.

The design folder holds real names and workspace content. Only layout, components, copy patterns and colour tokens are rebuilt here. Tests and fixtures use placeholder people (Ada, Grace, Linus, Barbara) and invented text.

## What changes

The single long debug page in `apps/web/app/page.tsx` becomes the designed dashboard. It stays one scrolling page with anchored sections, as the design does, and is laid out as follows.

- **Sidebar.** Brand, then nav with count badges: Overview, Needs you, Inbox, Commitments, People, System. A Dark/Light theme switch. A footer card with the local endpoints, the engineering lock and the line "Runs locally. Nothing leaves this machine without your approval."
- **Header.** The date line, then a greeting ("Good morning / afternoon / evening / Late night, <name>."). The name is the confirmed Slack identity's display name, and when there is none, the greeting has no name. A one-line briefing follows. Under it: a ⌘K button, the Away mode toggle and a health pill with a popover.
- **Needs you.** A single decision feed of cards, with an all-clear checklist after them.
- **How Synapse is running.** The pipeline, quota bars, Claude login, the last run and the engineering lock.
- **Inbox.** A conversation list with filters, plus a thread view and a composer.
- **Commitments.** The tracked list, restyled; the design has no section for it.
- **People.** Ready to evaluate, Priority, and a profile drawer.
- **System.** Background jobs, Slack collection and Claude runs.
- **Command palette and toasts.**

## Decisions

| # | Decision | Why |
|---|---|---|
| D1 | One page with anchored sections. The sidebar scrolls to a section and highlights the one in view (IntersectionObserver). **Commitments** is added to the nav between Inbox and People | The roadmap requires every existing capability to stay reachable, and the design has no place for the tracked-commitments list |
| D2 | Styling is plain global CSS: `app/styles/*.css`, imported once from `app/layout.tsx`, with `syn-` prefixed class names. No CSS-in-JS, no Tailwind, no CSS modules | Avoids a new dependency (rule 10). CSS modules don't load under `bun test` + `renderToString`; plain class names do |
| D3 | The colour tokens are copied from the design (`--bg`, `--surface`, …, `--avBgL/--avFgL`), dark and light. With nothing stored, the theme follows `prefers-color-scheme`. A choice is stored in `localStorage["synapse.theme"]`. An inline script in `<head>` sets `data-theme` before paint | No flash of the wrong theme |
| D4 | Fonts are IBM Plex Sans (400/500/600/700) and IBM Plex Mono (400/500), loaded via `next/font/google` and exposed as `--font-sans`/`--font-mono` | Self-hosted at build time: no runtime request to Google (roadmap constraint) |
| D5 | Avatars show initials, with a hue from a stable hash of the Slack id (0–359), drawn as `oklch(var(--avBgL) 0.055 h)` / `oklch(var(--avFgL) 0.09 h)`. Channels use a `#` tile | Matches the design without storing colours |
| D6 | New backend aggregates: `GET /api/dashboard/overview` (new `modules/dashboard`), `GET /api/inbox/conversations` and `GET /api/inbox/conversations/:id/thread`. `GET /api/claude/status` gains `thresholds` | Rule 6: aggregates, health explanations, pipeline state and thread annotations are computed in the backend |
| D7 | The briefing sentence and the order of Needs-you cards are pure presentation functions in `apps/web/lib/`, built over backend data and unit-tested. The fixed card order is: urgent (critical, high, then medium); outgoing sends needing attention; pending Slack-send approvals; red flags (high, then warning); follow-up drafts; commitments to review; profile recommendations; then setup cards (identity, people, backfill) | Wording and ordering are presentation. Every count and state comes from the API |
| D8 | **Undo means a deferred commit.** For reversible decisions that change only local state, the API call is held for 5 s behind a toast with Undo, and the item is hidden meanwhile. These are: red-flag review, rejecting a commitment, dismissing a profile suggestion and discarding a follow-up draft. If the page closes within those 5 s, nothing changes. Actions that send, approve, queue a Claude run or start a backfill run on click, with a plain confirmation toast | The design's Undo needs no backend reversal. Anything with an external or quota effect is never delayed or silently dropped |
| D9 | The Away mode toggle is rendered disabled (`aria-disabled`, not focus-trapping). Its tooltip and helper text read: "Away mode isn't available yet. Until it is, every reply waits for you." | Roadmap: wired only in Phase 6b |
| D10 | The thread composer acts only when the conversation has an open urgent item. It then shows the existing reply flow, prefilled with the urgency draft when there is one: Request approval to send → `POST /api/urgent/:id/reply`. Otherwise the composer shows a status note ("They wrote last.", "You replied last. Nothing waiting.", "Reply is waiting for your approval in Needs you."). A Claude draft for an arbitrary conversation is deferred, because it needs a new AI job | No new AI capability in a design phase. Every send still goes through approval |
| D11 | The engineering lock does not exist until Phase 10. The overview returns `engineeringLock: null`, and the UI shows "not in use yet". Nothing displays a made-up "free" | Rule 12: don't invent |
| D12 | The backfill card shows only facts the backend has: state, pages done and resumable. The confirm step shows the live 7-day quota from `/api/claude/status`. No search-count or dollar estimates | No unsourced figures |
| D13 | The person profile opens in a right-side drawer (`role="dialog"`). Esc and the close button dismiss it | Keeps the page layout from the design |
| D14 | Accessibility: every control is a real `<button>`/`<input>`. Toggles are `role="switch"` with `aria-checked`. The priority control is a `role="radiogroup"`. The palette is `role="dialog"` with `aria-modal`, is filtered by a pure function, supports ↑/↓/Enter/Esc, and returns focus to the opener on close | — |
| D15 | Below 900 px the sidebar becomes a horizontal top strip, and grids stack to one column | Usable at narrow widths; no further responsive design |
| D16 | Live updates stay the same: one SSE stream with a debounced refresh of all data (`lib/live-events.ts`, `lib/debounce.ts`) | Existing, tested behaviour |

## Backend contracts (shared in `packages/contracts/src/dashboard.ts`)

```ts
type PipelineStageId = "collect" | "screen" | "assess" | "surface";
type PipelineState = "ok" | "waiting" | "failing" | "idle";

interface DashboardOverview {
  generatedAt: string;
  self: { slackUserId: string | null; name: string | null };
  counts: {
    urgent: number; approvals: number; outgoingAttention: number; redFlags: number;
    commitmentsToReview: number; followupDrafts: number; profileRecommendations: number;
    peopleToEvaluate: number; conversations: number;
  };
  lastSlackSyncAt: string | null;
  health: {
    status: HealthStatus;
    issues: Array<{ check: string; label: string; status: HealthStatus; detail: string | null; hint: string | null }>;
  };
  pipeline: Array<{ id: PipelineStageId; label: string; what: string; state: PipelineState; summary: string }>;
  engineeringLock: null;
}

interface ConversationSummary {
  id: string;               // Slack external id
  type: "im" | "mpim" | "channel";
  name: string | null;
  isSelfDm: boolean;
  partner: { id: string; name: string | null } | null;  // im only
  lastMessageAt: string;
  lastSender: { id: string; name: string | null; isSelf: boolean };
  preview: string | null;   // latest text, first 140 chars; null when expired
  messageCount: number;     // stored messages
  theyWroteLast: boolean;   // im/mpim (not self DM) and last sender is not self
  awaitingApproval: boolean;// a pending slack.send approval targets this conversation
  openUrgent: Array<{ messageId: string; level: string }>; // open/in_progress urgent items here
}

interface ThreadMessage extends InboxMessage {
  isSelf: boolean;
  flag: { severity: "info" | "warning" | "high"; reason: string } | null;    // highest-severity flag on this message
  commitment: { id: string; description: string; direction: "mine" | "theirs"; reviewStatus: string; status: string } | null;
  sentViaSynapse: { status: "sent" | "sent_unverified" } | null;
}

interface ConversationThread { conversation: ConversationSummary; messages: ThreadMessage[] } // oldest first
```

**Pipeline rules (backend, `modules/dashboard/pipeline.ts`):**

- **collect.** `failing` when the `slack.messages` sync state has an error or a stalled page. `waiting` when the last success is older than 25 min, or there has been none. `ok` otherwise. Summary: "<n> min ago · <k> searches today".
- **screen.** `failing` when the `screening-rules` or `security-rules` health check is not ok, otherwise `ok`. Summary: "<n> red flags open".
- **assess.** `failing` when an `urgency.assess` job is FAILED or NEEDS_ATTENTION and was updated in the last 24 h. `waiting` when one is PENDING with `runAfter` ≤ now, or RUNNING. `ok` otherwise. Summary: "<n> waiting", or "up to date".
- **surface.** `ok` when there are open urgent items or pending approvals, otherwise `idle`. Summary: "<u> urgent · <a> approvals".

**Health hints** live in a static backend map, keyed by check name:

| Check | Hint |
|---|---|
| jobs | "Wait for the next scheduler tick. If jobs are still pending after 15 minutes, check the API logs." |
| heartbeat | "The scheduler isn't ticking. Restart the API service." |
| auth | "Run `claude` once in a terminal to refresh the login." |
| claude | "Check that `claude` is on the service PATH (bun scripts/setup/check-env.ts)." |
| linger | "Run `loginctl enable-linger $USER` so services keep running after logout." |
| events | "An event consumer exhausted its retries. Check the API logs for the event type." |
| desktop-notifier | "Install `notify-send` (libnotify) for desktop alerts." |
| database | "SQLite isn't in WAL mode. Restart the API, which re-applies the pragmas." |
| security-rules, screening-rules | "A rule file failed to load. Check the API logs." |
| bun | "Upgrade Bun to 1.4.4 or newer." |

Any other check gets `hint: null`. Check labels come from a sibling map, for example `jobs` → "Background jobs" and `auth` → "Claude login".

**Sent-via-Synapse matching.** A thread message is marked sent via Synapse when an `outgoing_messages` row meets all of these:

- it has status `sent` or `sent_unverified`;
- it targets the same conversation;
- the message is authored by self;
- its normalised text equals the message's normalised text, using the sender's decode-and-whitespace normalisation (exported, not copied);
- the message's `sentAt` is at or after the row's `sendingAt`, and within 1 hour of it.

## Out of scope

- A Claude-drafted reply for any conversation (D10).
- Wiring Away mode (6b).
- Per-user dashboard customisation (Phase 11).
- Any new AI job.
- Any change to approval, send or verification semantics.

## Deviations during implementation

- **Priority control.** The control offers the API's own values: Normal, High and Critical. There is no Low. A selected Critical uses the red tone, and High uses the amber `--high` tone.
- **Commitments section.** It has no review queue. Possible commitments are reviewed in Needs you. The section shows a quiet line pointing there.
- **Running.** "How Synapse is running" is its own section, `id="running"`. It isn't part of Overview, and it has no sidebar entry. From 1100 px it shares a two-column row with Needs you. It always renders, showing "Waiting for the API." until the overview loads.
- **Job labels.** The System section shows plain-language labels for the job types that are actually registered (`lib/job-labels.ts`), with the raw type beside each one, not the design's sample names.
- **Badges.** The Inbox badge is the number of conversations where they wrote last (`theyWroteLast`). The Needs-you badge is the number of actionable cards in the feed. A running backfill card has nothing to act on, so it isn't counted.
- **Self DM.** `isSelfDm` needs the stored conversation name to equal the self user's stored name (see `docs/modules/slack.md`, Inbox views). The collector stores no names for DMs, so in practice no conversation is labelled "Notes to self" yet. A partner-less DM is titled by its name, or "Direct message".
- **Assess pipeline.** Jobs in RETRY count as waiting, alongside due PENDING jobs and RUNNING jobs.

Deferred items and the smoke result are in `docs/superpowers/plans/2026-11-06-phase-7-followups.md`.
