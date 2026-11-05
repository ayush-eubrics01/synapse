# ADR-004: Modular Monolith
- **Status:** Accepted
- **Date:** 2026-11-05
- **Source:** concept.md §1.2, §4, §23 rule 17; requirements.md ("hexagonal architecture")

## Context
The system has many domains (inbox, people, commitments, Jira, Engineering Brain, engineering tasks, dashboard) but one user and one machine. Microservices would add deployment, networking and consistency costs with no benefit.

## Decision
Build a modular monolith using ports and adapters (hexagonal). Domain modules depend on ports in `packages/contracts`; adapters in `integrations/` and `infrastructure/` implement them. Modules talk through domain events or exported public services, never each other's internals. No microservices without an explicit ADR.

## Consequences
- Positive: one deployable, one database, simple transactions.
- Positive: clear seams for replacing integrations and AI providers.
- Negative: boundaries are enforced by convention and review, not by process isolation. Lint rules on import paths are recommended.

## Related
- [ADR-010](ADR-010-replaceable-integration-adapters.md), [ADR-011](ADR-011-replaceable-ai-provider.md)
- [module-boundaries.md](../../architecture/module-boundaries.md), [system-architecture.md](../../architecture/system-architecture.md)
