# ADR-027: Bot Filtering Relies on Slack's `include_bots: false`
- **Status:** Accepted
- **Date:** 2026-11-05
- **Source:** Phase 0 results; user decision after Phase 0

## Context
The user requires app and bot messages to be excluded. The search tool has an `include_bots` flag (default false), but neither search nor read output exposes a bot or subtype field. In Phase 0, `include_bots: true` and `false` returned identical results in every tested window, so the filter could not be proven either way.

## Decision
Rely on Slack's server-side filter: every collection call sets `include_bots: false`. The user accepted this as good enough. No local bot filter is required now.

## Consequences
- Positive: no extra filtering logic or user-maintained lists.
- Negative: the filter is unproven. If bot messages show up, they'll reach the inbox.
- Follow-up (optional): add a local safety net, such as dropping senders without a `U…` user ID or a user-maintained blocklist of integration users. `slack_users.is_bot` is nullable to allow this.

## Related
- [ADR-025](ADR-025-slack-collection-via-search.md)
- [slack.md](../../modules/slack.md)
