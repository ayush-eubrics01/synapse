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

## Amendment (2026-11-07, Phase 11)

Built as specified in `docs/superpowers/specs/2026-11-07-phase-11-dashboard-runtime.md`, with one reading of the decision: the widgets are the page's sections (`triage`, `running`, `inbox`, `commitments`, `jira`, `projects`, `engineering`, `people`, `system`), not a separate widget catalogue.

- **Built:** reorder, hide, collapse, half or full width, and named layouts (up to 10, one active), stored in the `dashboard_layouts` table and served by `/api/dashboard/layouts`. Needs you can never be hidden or collapsed. A new section appears automatically in an older stored layout.
- **Not built (out of scope):** adding new widget types, per-widget configuration or data filters, drag and drop, and multiple dashboard pages. The planned `dashboard_widgets` and `dashboard_widget_settings` tables do not exist; `docs/architecture/database-design.md` says so.

## Related
- [ADR-001](ADR-001-nextjs-frontend.md)
- [system-architecture.md](../../architecture/system-architecture.md)
