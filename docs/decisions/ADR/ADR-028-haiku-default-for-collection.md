# ADR-028: Haiku Is the Default Model for Collection and Screening
- **Status:** Accepted
- **Date:** 2026-11-05
- **Source:** Phase 0 results

## Context
Collection runs every poll (default 10 minutes) and backfill takes dozens of runs. These runs only call tools and return results; they need no deep reasoning.

## Decision
Collector runs and screening-level AI tasks use Haiku (`--model haiku`). Larger models are reserved for contextual analysis, drafting and engineering work, chosen per job type by the orchestrator.

Phase 0 costs (API-equivalent `total_cost_usd`, not subscription quota):
- Trimmed collector run, one search: ~$0.005–0.008.
- Default (untrimmed) trivial run: ~$0.088 (≈134k context tokens from plugins and skills).
- Steady state at 10-minute polling: ≈ $0.70/day. Empty polls cost about the same as small ones.
- 90-day backfill: ≈ $0.25–0.60.
- All Phase 0 tests together kept five-hour utilization at 0.01.

## Consequences
- Positive: low quota impact for always-on collection.
- Negative: Haiku is more prone to shortcuts (for example wasted ToolSearch turns, fabrication when misconfigured). Prompts must name exact tools, and ADR-026 applies.

## Related
- [ADR-029](ADR-029-quota-gate-on-rate-limit-event.md), [ADR-031](ADR-031-collector-worker-profile.md)
- [claude-orchestrator.md](../../modules/claude-orchestrator.md)
