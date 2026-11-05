# ADR-010: Replaceable Integration Adapters
- **Status:** Accepted
- **Date:** 2026-11-05
- **Source:** concept.md §1.2, §3.4, §5.2, §11

## Context
The initial Slack and Jira integrations go through Claude Code connectors. A native Slack app or Jira REST client may replace them later, and repositories are accessed through local Git.

## Decision
Every integration implements a stable port in `packages/contracts`: `MessageSource`/`MessageSink`, `IssueSource`/`IssueSink`, `RepositoryProvider`. Domain modules depend only on the ports. Adapters live in `apps/api/src/integrations/*` and are bound through dependency injection.

## Consequences
- Positive: swapping the Slack connector for a native collector changes one adapter and its binding.
- Positive: contract tests run against every adapter.
- Negative: ports must be designed around the lowest common denominator, and adapters report missing capabilities instead of assuming them.

## Related
- [ADR-004](ADR-004-modular-monolith.md), [ADR-011](ADR-011-replaceable-ai-provider.md)
- [integration-contracts.md](../../architecture/integration-contracts.md)
