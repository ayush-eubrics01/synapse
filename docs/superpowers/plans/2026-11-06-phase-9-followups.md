# Phase 9: Follow-ups

Phase 9 delivered the Engineering Brain (`docs/modules/engineering-brain.md`, spec `docs/superpowers/specs/2026-11-06-phase-9-engineering-brain.md`). This file records what was deliberately deferred and the real-CLI smoke results.

## Deferred

- **`code_answer` for away mode (Phase 10).** Answering a Slack question from the code mixes untrusted Slack text with code read access. It needs its own security design (no write or send tool in the same run, provenance of every part, an output that goes through `AutoReplyPolicy`) before it is built.
- **AI milestone extraction.** Propose milestones and go-live dates from Slack or Jira text ("we go live on the 20th", fix versions, due dates), as recommendations the user accepts. Conflicting dates for one milestone become a conflict recommendation, never a silent overwrite. Needs an intelligence prompt and schema, and the untrusted-content rules.
- **Slack-to-project links.** Associate conversations and messages with projects (rules first, AI only when ambiguous), visible and reversible.
- **CLAUDE.md and memory hints.** Read the user's CLAUDE.md files and Claude Code memory as hints for inspection, never as facts. The method is still an open question.
- **Repository auto-discovery.** An approved scan of a folder such as `~/projects` that proposes repositories. Explicit registration stays the default.
- **A repository remove button in the UI.** `DELETE /api/repos/:id` exists; the Projects section has no button for it.
- **Gate the project Jira summary on `jira.enabled`.** The summary reads in-scope `jira_issues` whatever the setting says.
- **Surface permission denials on inspection runs.** Denials are audited (tool names, in `brain.inspected`) but not shown. A denial means the run tried to step outside its scope, so it should raise a visible warning.
- **Validator rule H2 for engineering.** Rule H2 requires the write and filesystem-read built-ins in the denylist for every profile except engineering. `buildDenylist` now denies every write built-in an engineering run does not allow, but the validator does not require it, so a hand-built engineering request without them would pass. Require the unallowed write built-ins for engineering (Phase 10 will extend it for the write tools it allows).
- **Smaller items.** Project decisions, dependencies, blockers and knowledge-recommendation tables from the original module design. The `docs/architecture/database-design.md` section for the registry still lists `registered_at` and `last_drift_check_at`; the built columns are `created_at`, `updated_at` and `drift`.

## Real-CLI smoke

TBD. The controller runs `bun scripts/dev/scope-smoke.ts` and `bun scripts/dev/inspect-smoke.ts` and records the printed lines here (counts and statuses only).
