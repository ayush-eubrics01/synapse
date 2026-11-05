# ADR-019: People Memory Initial Profiles Are User-Selected
- **Status:** Accepted
- **Date:** 2026-11-05
- **Source:** concept.md §6.1, §20 Step 4

## Context
Building profiles for every Slack sender wastes Claude quota and stores assessments the user doesn't need.

## Decision
During setup, discover individual Slack contacts, show the list, and let the user choose whom to evaluate. Only selected people are analyzed from the 90-day history. Recommendations go through approval (ADR-014).

## Consequences
- Positive: Claude spend is focused on people who matter to the user.
- Negative: important people may be missed at first; unknown-contact recommendations (ADR-021) cover that later.

## Related
- [ADR-014](ADR-014-people-memory-requires-approval.md), [ADR-020](ADR-020-group-people-memory-deferred.md)
- [people-memory.md](../../modules/people-memory.md)
