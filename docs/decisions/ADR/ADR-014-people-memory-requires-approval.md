# ADR-014: People Memory Requires Approved Recommendations
- **Status:** Accepted
- **Date:** 2026-11-05
- **Source:** concept.md §6.2, §6.3

## Context
People Memory stores observations about colleagues: responsibilities, communication preferences and response guidelines. Unreviewed AI judgments about people are risky and can be wrong.

## Decision
Claude may only *recommend* profile content or changes. Every recommendation carries evidence (source references, confidence, observed date) and goes to a review queue. Only approved changes are saved, with version history. Priority is set manually and never silently changed by Claude. No psychological or personality judgments; only observable professional behavior.

## Consequences
- Positive: profiles are trustworthy and traceable.
- Negative: review workload for the user; recommendations should be batched.
- Rule: evidence keeps `source_external_ref` even after message content expires (ADR-018).

## Related
- [ADR-019](ADR-019-user-selected-initial-profiles.md), [ADR-021](ADR-021-unknown-contacts-temporary-records.md)
- [people-memory.md](../../modules/people-memory.md)
