# ADR-011: Replaceable AI Provider
- **Status:** Accepted
- **Date:** 2026-11-05
- **Source:** concept.md §1.2, §3.3, §11.3

## Context
Claude Code is the first provider (ADR-009), but business modules should not depend on its CLI flags, output format or session model.

## Decision
All AI execution goes through the `AIProvider` port (`execute`, `getCapabilities`, `getHealth`), used only by `core/orchestrator`. Requests carry a worker profile, model, prompts, allowed/disallowed tools, max turns and timeout. Results carry raw tool results, usage, quota snapshot and a classified error.

## Consequences
- Positive: providers can change without touching business modules.
- Positive: one place for quota, concurrency and audit.
- Negative: provider-specific features (for example `rate_limit_event`) must be mapped into neutral types such as `QuotaSnapshot`.

## Related
- [ADR-009](ADR-009-claude-code-initial-ai-provider.md), [ADR-026](ADR-026-raw-tool-results-only.md)
- [integration-contracts.md](../../architecture/integration-contracts.md), [claude-orchestrator.md](../../modules/claude-orchestrator.md)
