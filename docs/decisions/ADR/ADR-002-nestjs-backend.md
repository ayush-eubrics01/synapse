# ADR-002: NestJS + TypeScript Backend
- **Status:** Accepted
- **Date:** 2026-11-05
- **Source:** concept.md §2, §3.2, §16.1

## Context
The backend owns orchestration, scheduling, the job queue, permissions, approvals, integrations and all business logic. It must keep running when the browser and frontend are closed.

## Decision
Use NestJS with TypeScript in `apps/api`. The same process hosts the REST/SSE API, the scheduler, the durable job processor and the Claude orchestrator. NestJS modules and dependency injection express the module boundaries, and bind ports to adapters.

## Consequences
- Positive: DI makes adapter replacement (ADR-010, ADR-011) a provider binding change.
- Positive: structured modules map directly to the domain modules in `module-boundaries.md`.
- Negative: framework conventions and decorators add some boilerplate.
- Follow-up: workers run in-process at first. Splitting them into a separate process later needs an ADR.

## Related
- [ADR-004](ADR-004-modular-monolith.md), [ADR-006](ADR-006-persistent-background-runtime.md), [ADR-008](ADR-008-database-backed-job-processing.md)
- [module-boundaries.md](../../architecture/module-boundaries.md)
