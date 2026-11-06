# Roadmap

This list amends the phase plan in `pre-project-concept-document/concept.md`. Where they differ, this file wins.

| # | Phase | Status |
|---|---|---|
| 0 | Feasibility (Claude Code + Slack/Jira connectors from a background service) | Done |
| 1 | Core platform: queue, scheduler, approvals, audit, health | Done |
| 2 | Claude orchestrator | Done |
| 3 | Slack collector | Done |
| 4 | Urgency engine and inbox | Done |
| 5 | People Memory | Done (merged, PR #6) |
| 6 | Commitments, follow-ups and approved sending | Done (merged; PR #7/#9) |
| 6b | Away-mode auto-replies (ADR-033) and the return digest | Done (merged; PR #11). Module doc: `docs/modules/auto-reply.md`. Follow-ups: `docs/superpowers/plans/2026-11-06-phase-6b-followups.md` |
| 7 | **Design revamp** | Done (merged; PR #8/#9). Inserted at the user's request (2026-11-06), before the Jira integration. Follow-ups: `docs/superpowers/plans/2026-11-06-phase-7-followups.md` |
| 8 | Jira integration | Done (merged, PR #12). Read-only tracking; module doc: `docs/modules/jira.md`. Follow-ups: `docs/superpowers/plans/2026-11-06-phase-8-followups.md`. Was Phase 7 |
| 9 | Engineering Brain | Done (merged, PR #13). Repository registry with drift check, read-only path-scoped inspection with verified evidence and fact review, projects, milestones and go-live dates, Jira association, Projects UI. Module doc: `docs/modules/engineering-brain.md`. Follow-ups: `docs/superpowers/plans/2026-11-06-phase-9-followups.md`. Was Phase 8 |
| 10 | Engineering automation | Done (merged, PR #14). Tasks from the user, Jira or Slack; read-only investigation; plan approval with branch confirmation; the global lock; a scoped develop run (edit files and run the confirmed test command); approval-gated commit, local merge, push, PR and PR merge, all run by Synapse code, never the model; cleanup; Engineering section in the web. Module doc: `docs/modules/engineering-tasks.md`. Follow-ups: `docs/superpowers/plans/2026-11-06-phase-10-followups.md`. Was Phase 9 |
| 10b | Claude Code activity and code answers | Done (merged, PR #15). Part A: observe interactive Claude Code sessions in registered repositories (metadata only), yield background work while the user is active, work-in-progress reminders (`docs/modules/claude-activity.md`, ADR-036 amendment). Part C: read-only `reader` profile and code answers from Slack questions, user trigger and away trigger with `code_answer_review` (`docs/modules/code-answers.md`). Follow-ups: `docs/superpowers/plans/2026-11-06-phase-10b-followups.md`. Inserted before Phase 11 |
| 11 | Dashboard customisation and runtime hardening | Done (merged, PR #17). Saved dashboard layouts (reorder, hide, collapse, width; Needs you always shown); private data files; verified daily local backups and a CLI restore; operational retention; runtime monitoring and health checks; hardened service units and graceful shutdown. Follow-ups: `docs/superpowers/plans/2026-11-07-phase-11-followups.md` |

## Phase 7: Design revamp

The user's early design for this phase lives outside the repo, at `~/designs-claude/Dashboard UX redesign/`. The main file is `Synapse Dashboard.dc.html`, with screenshots in `scraps/`. That folder contains real names and workspace data, so none of its sample content, screenshots or captures may be copied into this public repository. Only the layout, components and design tokens are rebuilt here, with placeholder data in tests and fixtures.

What the design covers:

- **App shell.** A fixed sidebar with Overview, Needs you, Inbox, People and System, plus count badges, a footer card showing local endpoints and the engineering lock, and the line "Runs locally. Nothing leaves this machine without your approval."
- **Top bar.** A date line, then a greeting with the user's name (from the confirmed Slack identity, never hard-coded) and a one-line briefing. Below it: a ⌘K command palette, the Away mode toggle, and a health pill that explains what is degraded and the most likely fix.
- **Needs you.** One prioritised decision feed: urgent items, Slack-send approvals (exact text and recipient), red flags, possible commitments, People Memory and backfill setup cards, and an all-clear checklist.
- **How Synapse is running.** A live pipeline (Collect → Screen → Assess → Surface), Claude quota bars with pause-threshold markers, Claude login expiry, the last Claude run, and the engineering lock.
- **Inbox.** A conversation list (All, Direct, Channels, They wrote last) and a thread view with day separators, untrusted-instruction markers, inline commitment suggestions, sent-via-Synapse delivery badges, and a draft-reply flow that ends in an approval request.
- **People.** "Ready to evaluate" with score bars and Evaluate top 3, priority as a Low/Normal/High segmented control with extra attention, and self excluded.
- **System.** Background jobs and Slack collection details.
- **Theme and typography.** A light and dark theme with semantic colour tokens, IBM Plex Sans and Mono, toasts with Undo, and keyboard navigation in the palette.

Constraints the plan must respect:

- Business logic stays in the backend (CLAUDE.md rule 6), so new aggregate views get API endpoints.
- Fonts are self-hosted, using `next/font` at build time, so the dashboard makes no runtime requests to Google.
- Every existing capability stays reachable.
- The Away mode toggle is wired by Phase 6b (`docs/modules/auto-reply.md`).
