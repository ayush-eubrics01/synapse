# ADR-023: Customizable Dashboard Widgets
- **Status:** Accepted
- **Date:** 2026-11-05
- **Source:** concept.md §17; requirements.md #5a

## Context
The user wants one place where everything needing attention lands, arranged their way.

## Decision
The dashboard is made of widgets (Urgent Inbox, Slack Inbox, pending responses, open/overdue commitments, follow-ups due, People Memory recommendations, Engineering Brain updates, Jira blockers, upcoming releases, Claude job activity, Claude resource usage, pending approvals). Users can add, remove, reorder, resize and configure widgets and save layouts. Layout and widget settings are stored in the database. Widgets read through backend APIs only.

## Consequences
- Positive: one configurable command center.
- Negative: widget framework work; scheduled late (Phase 10) since correctness comes first.
- Follow-up: support multiple layouts later.

## Related
- [ADR-001](ADR-001-nextjs-frontend.md)
- [system-architecture.md](../../architecture/system-architecture.md)
