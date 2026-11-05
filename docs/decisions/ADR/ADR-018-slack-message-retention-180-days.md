# ADR-018: Full Slack Message Retention — 180 Days
- **Status:** Accepted
- **Date:** 2026-11-05
- **Source:** concept.md §14

## Context
Storing full Slack content forever grows the database and keeps sensitive text around longer than needed. Derived knowledge must survive the loss of its source.

## Decision
Keep full Slack message content for 180 days (configurable). A scheduled maintenance job clears expired content and local attachments, keeping IDs, `ts` and permalinks, and records the cleanup. Approved People Memory, Engineering Brain records, commitments, follow-up history, technical decisions, approvals and audit history are never deleted because their source expired.

## Consequences
- Positive: bounded storage and exposure of raw content.
- Negative: evidence links may point to content no longer available locally. The UI must show this.
- Rule: before deleting content, make sure derived records have their provenance (`source_external_ref`).

## Related
- [ADR-017](ADR-017-initial-slack-history-90-days.md), [ADR-014](ADR-014-people-memory-requires-approval.md)
- [database-design.md](../../architecture/database-design.md)
