# ADR-003: SQLite + Drizzle ORM
- **Status:** Accepted
- **Date:** 2026-11-05
- **Source:** concept.md §2.2, §13

## Context
Synapse is single-user and local. It needs durable, transactional storage for messages, people, commitments, jobs, events, approvals and audit, with no extra services to operate.

## Decision
Use SQLite with Drizzle ORM. Configuration: WAL journal mode, foreign keys enforced, a configured busy timeout, explicit forward-only migrations, indexed query paths, transactional writes, and automated backups. Don't introduce Redis or an external database without a demonstrated need and a new ADR.

## Consequences
- Positive: zero-ops, a single file, easy to back up; type-safe queries.
- Positive: transactions make the outbox (ADR-008, event-system) straightforward.
- Negative: a single writer; long write transactions block others. Keep transactions short.
- Negative: a job queue and leases must be built on SQLite rather than taken from a broker.
- Follow-up: backup/restore is delivered in Phase 10.

## Related
- [ADR-008](ADR-008-database-backed-job-processing.md)
- [database-design.md](../../architecture/database-design.md)
