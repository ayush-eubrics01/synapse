# ADR-024: External Source Systems Retain Authority Over Original Data
- **Status:** Accepted
- **Date:** 2026-11-05
- **Source:** concept.md §1.1, §19

## Context
Synapse keeps local copies of Slack messages, Jira issues and repository facts, and derives its own records from them.

## Decision
Slack owns messages, Jira owns issue status, Git repositories own source code. The application owns approved People Memory, commitments, Engineering Brain records, approvals, jobs, audit and dashboard settings. The app never overwrites external data based only on AI interpretation. Synchronization is incremental, using checkpoints and external IDs.

## Consequences
- Positive: clear source of truth for every field; no silent drift.
- Negative: local copies can be stale between syncs. The UI shows last-synced times.
- Phase 0: Slack search returns current message state only; edits and deletions after collection aren't reported.

## Related
- [ADR-010](ADR-010-replaceable-integration-adapters.md)
- [system-architecture.md](../../architecture/system-architecture.md)
