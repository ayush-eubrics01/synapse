# ADR-026: Only Raw Tool Results Are Trusted Data
- **Status:** Accepted
- **Date:** 2026-11-05
- **Source:** Phase 0 results (test 4)

## Context
Collection goes through Claude. If the app trusted Claude's text reply as data, the model could paraphrase, truncate or invent messages. Phase 0 test 4 showed this happening: a misconfigured run (`--tools "ToolSearch"`, which hid the MCP tools) led Haiku to write fake `<invoke>` blocks and a fabricated `<function_result>` with invented Slack messages and timestamps, then report "DONE" as if it had succeeded.

## Decision
Source data is parsed only from real `tool_result` events in Claude Code's `--output-format stream-json` output, matched to their `tool_use` by `tool_use_id`. The model's final text is never stored as source data. A run that produced no non-error `tool_result` from an expected tool has failed (`incomplete_ai_output`), whatever the reply says. Every parsed record is validated with Zod before storage.

## Consequences
- Positive: fabricated output can't enter the database.
- Positive: no output tokens are spent re-typing data.
- Negative: the CLI adapter must parse the stream-json event format and track it across Claude Code versions (pin the version; contract tests).
- Applies equally to intelligence jobs: structured AI output is validated against its schema and rejected if invalid.

## Related
- [ADR-025](ADR-025-slack-collection-via-search.md), [ADR-031](ADR-031-collector-worker-profile.md)
- [integration-contracts.md](../../architecture/integration-contracts.md), [claude-orchestrator.md](../../modules/claude-orchestrator.md)
