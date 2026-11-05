# ADR-007: systemd User Services on Linux
- **Status:** Accepted
- **Date:** 2026-11-05
- **Source:** concept.md §16.2; Phase 0 results

## Context
The backend and frontend need to start on login, restart on failure, shut down gracefully and keep persistent logs. Building a custom supervisor is unnecessary.

## Decision
Run both processes as systemd **user** services. Use `Restart=on-failure`, graceful stop handling, journald logs, and explicit manual start/stop.

Phase 0 requirements:
- Enable lingering (`loginctl enable-linger <user>`). Otherwise user services stop at logout.
- Set `PATH` and the required environment explicitly in the unit file. The service environment doesn't inherit the interactive shell's PATH (`node` was missing in Phase 0).
- Run Claude Code with stdin redirected from `/dev/null`.

## Consequences
- Positive: standard, well-understood supervision; no custom code.
- Negative: Linux-only; other platforms would need a different runtime adapter.
- Negative: services run under the user's account and share `~/.claude` credentials with interactive sessions.

## Related
- [ADR-006](ADR-006-persistent-background-runtime.md)
- [runtime-design.md](../../architecture/runtime-design.md), [phase0-results.md](../../../pre-project-concept-document/phase0-results.md)
