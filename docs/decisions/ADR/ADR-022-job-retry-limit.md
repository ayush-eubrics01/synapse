# ADR-022: Job Retry Limit — 3 Automatic Retries
- **Status:** Accepted
- **Date:** 2026-11-05
- **Source:** concept.md §15.3

## Context
Transient failures (network, connector not ready, rate limits) should recover on their own; permanent ones should not loop.

## Decision
At most 3 automatic retries with exponential backoff. Errors are classified (see `ErrorKind` in integration-contracts). Transient kinds retry. `auth_failed`, `permission_denied`, `invalid_input` and `parse_failed` go to NEEDS_ATTENTION without retry. `quota_exhausted` defers until the reported reset time and doesn't consume a retry. External operations with an uncertain outcome are verified before retrying.

## Consequences
- Positive: predictable failure handling; no blind retry loops.
- Negative: classification must be accurate; misclassified permanent errors waste up to 3 attempts.
- Phase 0: `connector_not_ready` is a real transient case. Connectors are often `pending` at session start.

## Related
- [ADR-008](ADR-008-database-backed-job-processing.md), [ADR-029](ADR-029-quota-gate-on-rate-limit-event.md)
- [integration-contracts.md](../../architecture/integration-contracts.md)
