# ADR-006: Persistent Background Runtime
- **Status:** Accepted
- **Date:** 2026-11-05
- **Source:** concept.md §1, §16.1, §26

## Context
Collection, reminders, urgency detection and engineering jobs must keep running when the browser is closed.

## Decision
Run two independently managed processes: the Hono/Bun backend (ADR-038) (API, scheduler, job processor, orchestrator) and the Next.js frontend. The backend must work fully without the frontend.

## Consequences
- Positive: closing the UI never interrupts work.
- Positive: the frontend can be restarted or upgraded on its own.
- Negative: crash recovery, health checks and lease expiry must be handled by the backend itself (ADR-008).
- Phase 0: background `claude -p` runs work as a systemd user service. Lingering must be enabled for the service to survive logout.

## Related
- [ADR-007](ADR-007-systemd-user-services.md), [ADR-008](ADR-008-database-backed-job-processing.md)
- [runtime-design.md](../../architecture/runtime-design.md)
