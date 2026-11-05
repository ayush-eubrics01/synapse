# ADR-005: Local-First Architecture
- **Status:** Accepted
- **Date:** 2026-11-05
- **Source:** concept.md §1.1, §1.2, §16.3

## Context
Synapse handles private Slack messages, Jira data, source code and personal assessments of colleagues. It runs for one user on that user's Linux machine.

## Decision
All application state, scheduling and processing live on the local machine. Backend and frontend bind to localhost only. No public network exposure or remote access unless explicitly configured later through an ADR. External services remain authoritative for their own data (ADR-024).

## Consequences
- Positive: private data stays local except what Claude processes through its connectors.
- Positive: no hosting or auth infrastructure to build.
- Negative: the machine must be on and awake for background work. A suspended laptop stops collection (runtime-design).
- Negative: approvals and notifications are only available on the machine itself. This conflicts with "answer while I'm away" requirements; see open questions.

## Related
- [ADR-006](ADR-006-persistent-background-runtime.md), [ADR-024](ADR-024-external-systems-retain-authority.md)
- [security-model.md](../../architecture/security-model.md), [open-questions.md](../../product/open-questions.md)
