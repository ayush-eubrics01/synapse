# Phase 7: Follow-ups

Phase 7 (design revamp) rebuilt the dashboard from the user's design. This file records the smoke result, the items that were deliberately deferred and the review cleanups done in the last task, so they survive after the review workspace is deleted. Where the build differs from the spec, see the spec's "Deviations during implementation" section (`docs/superpowers/specs/2026-11-06-phase-7-design-revamp.md`).

## Smoke result (2026-11-06)

The real API and web dev server ran on an empty temp DB in the session scratchpad, which was deleted afterwards. They used ports 7410 (API) and 7411 (web), with `SYNAPSE_WEB_PORT=7411` so the API's local-only guard accepted the proxied requests. Ports 7400 and 7401 were free and the user's services were inactive, so the user's real DB and services weren't touched.

No Claude run was possible:
- `SYNAPSE_CLAUDE_BIN` pointed at a stub that answers `--version` and refuses everything else.
- `slack.collection.enabled` was set to false in the temp DB before start.
- `SYNAPSE_CLAUDE_CREDENTIALS` pointed at a missing file.
- `/api/claude/runs` stayed empty. Every scheduled job (heartbeat, collect_incremental, retention, commitments sweep, reminders, stall check, people jobs) completed without spawning Claude.

Results:
- `GET /` returned 200. The HTML has all seven section ids (`overview`, `triage`, `running`, `inbox`, `commitments`, `people`, `system`), the two-column `syn-top` row, the theme boot script and the empty states ("All clear", "Waiting for the API.", "No Claude runs yet.", "No quota reading yet.", "No messages collected yet.", "No commitments.", "No people.", "No jobs yet.", "No Slack status yet.").
- `GET /api/dashboard/overview` through the web origin returned 200:
  - `self` null, all counts 0, `engineeringLock` null;
  - health `degraded`, with issues `linger`, `auth` and `claude`, as expected with the stub and no credentials;
  - pipeline: collect waiting ("not collected yet · 0 searches today"), screen ok, assess ok ("up to date"), surface idle.
- Every list endpoint the page calls returned 200 through the web origin.
- **Not checked: browser console and the theme toggle in a real browser.** No Chromium is installed for CDP, and Firefox is only a snap stub. The theme rules are covered by unit tests (`test/theme.test.ts`), including the boot script itself. Check this by hand: open `/` in both themes and look at the console.

## Deferred

- **A Claude reply draft for any conversation (D10).** The composer acts only on an open urgent item. Drafting for an arbitrary conversation needs a new AI job and an orchestrator worker profile.
- **Away mode wiring (Phase 6b).** The toggle is rendered disabled with its explanation.
- **Custom layout (Phase 11).** Per-user section order and visibility.
- **Several toasts at once and stacked undo.** One toast shows at a time. A new deferred action replaces the toast, but the earlier action still commits after its delay. Its Undo is only reachable while its own toast is shown.
- **Autoscroll in threads on SSE updates.** A live refresh updates the open thread in place, without scrolling to the newest message.
- **A reliable self-DM signal.** The collector stores no name for DMs, so `isSelfDm` (which needs the stored name to equal the self user's stored name) is false in practice. The self DM shows as "Direct message". A future signal could be the connector's channel metadata, or the DM channel the user's own sends resolve to.
- **Focus-return tests in a DOM.** The profile drawer's opener is captured at click time and handed to the drawer. That's covered by a static wiring assertion only, because the web tests have no DOM.

## Review cleanups done in Task 9

- The assess stage counts RETRY jobs as waiting. Tests cover the 25-minute collect boundary, NEEDS_ATTENTION, failures older than 24 h and the failure summary.
- `isSelfDm` needs a matching stored name (see Deferred). A partner-less DM that isn't the self DM has no partner and `theyWroteLast: false`, and the web titles it by its name or "Direct message". Thread limit bounds (0 and 501 give 400) are tested.
- The theme switch and the boot script share one rule (`systemPrefersDark`): missing or throwing `matchMedia` means light.
- Slack card rows have dividers between rows only (adjacent sibling, not `:first-of-type`).
- A failed thread refetch surfaces in the load error like every other fetch.
- People: the drawer's opener is captured at click time, Critical gets a red selected tone, Evaluate top 3 shows every refusal once after the batch, and stalled appears once on a commitment card.
- Needs you: a deferred commit's failure has its own error channel, which immediate actions don't clear. The outgoing card labels channels `#name`.
