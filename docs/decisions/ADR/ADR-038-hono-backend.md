# ADR-038: Hono + TypeScript Backend (supersedes ADR-002)

- **Status:** Accepted
- **Date:** 2026-11-05
- **Source:** User decision before Phase 1 ("NestJS is heavy; use Hono if it works with everything else")

## Context

ADR-002 chose NestJS. The user prefers a lighter framework. Synapse's backend needs: REST, Server-Sent Events, request validation with Zod, a long-running process that also hosts the scheduler, job processor, event dispatcher and orchestrator, and replaceable adapters behind ports. It runs on Bun (ADR-039).

## Decision

Use **Hono** for the HTTP layer of `apps/api`, served by `Bun.serve`.

| Need | How |
|---|---|
| REST routes | Hono routers per domain module (`modules/<name>/routes.ts`) |
| SSE (live UI updates) | `hono/streaming` `streamSSE` |
| Validation | Zod schemas from `packages/contracts` via `@hono/zod-validator` |
| Localhost binding | `Bun.serve({ hostname: '127.0.0.1' })` |
| Dependency wiring | A plain **composition root** (`apps/api/src/container.ts`) constructs core services and adapters and passes them to modules by constructor/factory injection. No DI framework or decorators. Port interfaces live in `packages/contracts`; tests pass fakes the same way |
| Scheduling ("cron") | Hono has no scheduler. Synapse's scheduler is its own database-backed loop (`scheduled_tasks`, durable across restarts, see `runtime-design.md`). Cron-style expressions, if needed, are parsed with `croner` to compute `next_run_at`. Neither Hono nor an in-memory cron owns schedules |
| Background work | Started from `main.ts` alongside the server: scheduler tick, job workers, outbox dispatcher, health monitor, all with graceful shutdown on `SIGTERM` |

## Consequences

- **Positive:** small, fast, few dependencies; explicit wiring is easy to read and test.
- **Positive:** adapter replacement (ADR-010, ADR-011) is a one-line change in the composition root.
- **Negative:** no framework-enforced module structure. Boundaries are enforced by folder layout, `module-boundaries.md`, and a lint rule restricting imports (for example, `modules/*` may not import `integrations/*` or `infrastructure/*`).
- Unchanged from ADR-002: workers run in-process; splitting them out later needs an ADR.

## Related

- Supersedes [ADR-002](ADR-002-nestjs-backend.md)
- [ADR-039](ADR-039-bun-runtime.md), [ADR-004](ADR-004-modular-monolith.md), [ADR-006](ADR-006-persistent-background-runtime.md), [ADR-008](ADR-008-database-backed-job-processing.md)
- [module-boundaries.md](../../architecture/module-boundaries.md), [runtime-design.md](../../architecture/runtime-design.md)
