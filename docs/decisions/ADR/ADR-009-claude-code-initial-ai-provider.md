# ADR-009: Claude Code as Initial AI Execution Provider
- **Status:** Accepted
- **Date:** 2026-11-05
- **Source:** concept.md §1.1, §10, §21 Phase 0; Phase 0 results

## Context
The user already has Claude Code with claude.ai connectors to Slack and Jira, and wants Claude to analyze messages, draft responses and do engineering work in local repositories. Claude Code must not become the app's database, scheduler or source of truth.

## Decision
Use the Claude Code CLI (`claude -p`) as the first AI provider, behind the `AIProvider` port. Only `core/orchestrator` invokes it. Claude Code is also the initial *collection mechanism* for Slack and Jira, because the connector credentials live on Anthropic's side and no local token exists.

Phase 0 confirmed a `claude -p` process run as a systemd user service can call the claude.ai Slack and Atlassian connectors under the user's claude.ai login.

## Consequences
- Positive: no new Slack app or Jira credentials needed to start.
- Negative: every Slack/Jira poll costs a Claude invocation, even when nothing is new, and draws on the subscription quota (managed by ADR-028, ADR-029).
- Negative: connector output is not a versioned API. Parsers need contract tests and must fail loudly on format changes.
- Negative: depends on the claude.ai OAuth login staying valid; the refresh token had a ~7-day expiry in Phase 0 (open question).

## Related
- [ADR-011](ADR-011-replaceable-ai-provider.md), [ADR-025](ADR-025-slack-collection-via-search.md), [ADR-026](ADR-026-raw-tool-results-only.md), [ADR-031](ADR-031-collector-worker-profile.md)
- [claude-orchestrator.md](../../modules/claude-orchestrator.md), [integration-contracts.md](../../architecture/integration-contracts.md)
