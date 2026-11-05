# ADR-008: Database-Backed Job Processing
- **Status:** Accepted
- **Date:** 2026-11-05
- **Source:** concept.md §15, §12

## Context
Collection runs, AI analysis, reminders and engineering steps must survive crashes and restarts, retry safely, and never run twice by accident. Redis or another broker would add operational weight for a single-user app.

## Decision
Implement a durable job queue in SQLite (`jobs`, `job_attempts`, `job_checkpoints`, `leases`). Jobs have a type, priority, status, idempotency key, attempts, a checkpoint, and a lease with expiry. Lifecycle: PENDING → RUNNING → COMPLETED, or FAILED → RETRY → RUNNING, or NEEDS_ATTENTION. Important domain events use a transactional outbox (`domain_events`, `event_consumptions`).

## Consequences
- Positive: no extra infrastructure; jobs and state changes commit atomically.
- Positive: restart recovery is a query (expired leases, interrupted jobs).
- Negative: polling the queue costs some latency and CPU; acceptable at single-user scale.
- Rule: uncertain external operations (for example a Slack send that timed out) are verified before any retry.

## Related
- [ADR-003](ADR-003-sqlite-drizzle.md), [ADR-022](ADR-022-job-retry-limit.md)
- [database-design.md](../../architecture/database-design.md), [event-system.md](../../architecture/event-system.md)
