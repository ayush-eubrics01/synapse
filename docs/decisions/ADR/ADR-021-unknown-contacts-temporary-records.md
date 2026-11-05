# ADR-021: Unknown Contacts Use Temporary Records
- **Status:** Accepted
- **Date:** 2026-11-05
- **Source:** concept.md §6.4, §6.5

## Context
New senders appear all the time. Most don't need a permanent profile, and none should get an unreviewed one.

## Decision
An unknown sender gets a `temporary_contacts` record with only the context needed for the interaction. Claude may assess whether a permanent profile would help and, if so, create a recommendation for approval. No priority is assigned automatically. When the user notifies someone new after finishing a task, permanent profile registration starts only after the message is sent and verified. A failed or cancelled send creates no profile.

## Consequences
- Positive: no profile sprawl; every permanent profile is deliberate.
- Negative: temporary contacts need their own expiry and cleanup.

## Related
- [ADR-014](ADR-014-people-memory-requires-approval.md)
- [people-memory.md](../../modules/people-memory.md)
