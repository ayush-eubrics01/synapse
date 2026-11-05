# ADR-031: Collector Worker Profile
- **Status:** Proposed
- **Date:** 2026-11-05
- **Source:** Phase 0 results

## Context
The concept defines two worker profiles, Intelligence and Engineering. Phase 0 showed that collection runs have distinct needs: read-only connector tools, a cheap model, short runs, and a minimal context. A default `claude -p` run loaded ~134k tokens of plugins, skills and ~387 tools.

## Decision
Add a third profile, **Collector**, alongside Intelligence and Engineering:
- Tools: read-only connector tools for the job only (for example `slack_search_public_and_private`, `slack_read_thread`, `searchJiraIssuesUsingJql`), plus `ToolSearch`. Send and write tools are explicitly denied.
- Model: Haiku (ADR-028).
- Run size: ~5 pages per run, checkpointed per page. Context grows per page within a run, so long runs are disproportionately expensive.
- Invocation flags: `--setting-sources ""`, `--disable-slash-commands`, a short `--system-prompt`, `--allowedTools` / `--disallowedTools`, `--max-turns <calls + 3>`, `--no-session-persistence`, `--output-format stream-json --verbose`, stdin from `/dev/null`.
- Never `--tools` (it hides MCP connector tools). Never `--bare` (API key only; connectors need claude.ai OAuth). Always allow `ToolSearch` (connector tools are deferred).
- Prompts name exact tool names and arguments.

## Consequences
- Positive: per-run context drops to ~36k tokens; predictable cost.
- Positive: collectors can't send or modify anything.
- Negative: one more profile for the orchestrator to configure and test.

## Related
- [ADR-025](ADR-025-slack-collection-via-search.md), [ADR-026](ADR-026-raw-tool-results-only.md), [ADR-028](ADR-028-haiku-default-for-collection.md), [ADR-032](ADR-032-untrusted-content-isolation.md)
- [claude-orchestrator.md](../../modules/claude-orchestrator.md)
