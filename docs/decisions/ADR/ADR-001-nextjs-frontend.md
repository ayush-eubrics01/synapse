# ADR-001: Next.js + TypeScript Frontend
- **Status:** Accepted
- **Date:** 2026-11-05
- **Source:** concept.md §2, §3.1, §17

## Context
Synapse needs a local dashboard: Urgent Inbox, Slack Inbox, commitments, People Memory review, Engineering Brain, Jira overview, approval queue, Claude execution monitoring, settings, and customizable widgets. The project is TypeScript-first, to keep language and tooling complexity low.

## Decision
Build the frontend with Next.js and TypeScript in `apps/web`. It is a presentation layer only. It consumes the backend REST API and Server-Sent Events, and never talks to Slack, Jira, Git or Claude Code directly.

## Consequences
- Positive: one language across the stack; shared Zod schemas and DTOs from `packages/contracts`.
- Positive: the frontend can be stopped or restarted without affecting background work (see ADR-006).
- Negative: a second process to run and supervise (a separate systemd unit).
- Rule: no business logic in components or widgets. Anything beyond display and input calls a backend endpoint.

## Related
- [ADR-002](ADR-002-nestjs-backend.md), [ADR-023](ADR-023-customizable-dashboard-widgets.md)
- [system-architecture.md](../../architecture/system-architecture.md), [module-boundaries.md](../../architecture/module-boundaries.md)
