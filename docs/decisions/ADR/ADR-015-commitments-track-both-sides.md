# ADR-015: Commitments Track Both User and Colleagues
- **Status:** Accepted
- **Date:** 2026-11-05
- **Source:** concept.md §8; requirements.md #5f

## Context
Work stalls both when the user forgets a promise and when a colleague says "I'll check and let you know" and goes quiet.

## Decision
Track commitments made by the user and by others, each with owner, owed-to, sources (several allowed), due date, priority, status (Open, In Progress, Blocked, Completed, Cancelled), next action and completion evidence. Saying "I will" is not completion; closure requires confirmation or an explicit user action. Reminders to the user are automatic. Messages to others need approval.

## Consequences
- Positive: one place to see what's owed by whom.
- Negative: extraction can create duplicates; a `dedup_key` and an approval step are required.
- Open: whether follow-ups to colleagues may be sent without approval while the user is away (open questions).

## Related
- [ADR-013](ADR-013-manual-approval-for-external-writes.md)
- [commitments.md](../../modules/commitments.md)
