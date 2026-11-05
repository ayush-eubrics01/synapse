# ADR-016: Central Engineering Brain with Project Profiles
- **Status:** Accepted
- **Date:** 2026-11-05
- **Source:** concept.md §9; requirements.md #6

## Context
The user wants one place that knows what's being built, its status, decisions, blockers and go-live dates, across products and personal projects.

## Decision
Keep one Engineering Brain with a profile per project (purpose, status, repositories, architecture, modules, features, bugs, tech debt, dependencies, blockers, decisions, milestones, go-live dates, related Jira issues and Slack discussions). Project names are not hardcoded. Claude recommends updates with evidence; important updates are reviewed and approved. Unknown information is marked unknown, never invented.

## Consequences
- Positive: a single source for release and project status.
- Negative: knowledge can go stale; maintenance jobs must flag outdated or conflicting facts.
- Rule: the application database owns approved Engineering Brain records.

## Related
- [ADR-024](ADR-024-external-systems-retain-authority.md)
- [engineering-brain.md](../../modules/engineering-brain.md)
