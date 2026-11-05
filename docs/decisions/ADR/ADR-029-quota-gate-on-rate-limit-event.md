# ADR-029: Quota Gate on `rate_limit_event` Utilization
- **Status:** Accepted
- **Date:** 2026-11-05
- **Source:** Phase 0 results

## Context
The user's Claude subscription has five-hour and seven-day limits, and background jobs share them with the user's interactive work. The concept assumed exact remaining allowance might not be retrievable. Phase 0 found that every `stream-json` run emits a `rate_limit_event` with `five_hour` and `seven_day` utilization (0–1), status and reset time.

## Decision
The orchestrator records a `QuotaSnapshot` (`quota_snapshots` table) after every run and gates scheduling on it:
- Above a configurable threshold, non-urgent jobs are deferred until the reported reset time (`quota_exhausted`, which doesn't consume a retry), and `quota.threshold_reached` is emitted.
- Headroom is reserved for the user's own interactive Claude Code use.
- `total_cost_usd` and token usage are tracked per run for relative cost, but are not treated as quota.

## Consequences
- Positive: background work can't silently exhaust the user's window.
- Negative: utilization is only observed after a run, so the gate needs a safety margin.
- Negative: depends on an undocumented event shape; the adapter must tolerate missing fields and fall back to conservative limits.

## Related
- [ADR-028](ADR-028-haiku-default-for-collection.md), [ADR-022](ADR-022-job-retry-limit.md)
- [claude-orchestrator.md](../../modules/claude-orchestrator.md), [integration-contracts.md](../../architecture/integration-contracts.md)
