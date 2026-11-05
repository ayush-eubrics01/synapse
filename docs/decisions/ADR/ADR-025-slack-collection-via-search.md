# ADR-025: Slack Collection via Search with a Unix-Timestamp Checkpoint
- **Status:** Accepted
- **Date:** 2026-11-05
- **Source:** Phase 0 results (tests A–D)

## Context
Phase 0 compared the connector's read tools. `slack_read_channel` returns time only to the second with no per-message `ts`, so dedup isn't reliable, and an `oldest` cursor on channel history misses new replies to old threads. `response_format: "concise"` drops all IDs and timestamps. `slack_search_public_and_private` returns channel ID, sender user ID and email, `Time`, `Message_ts`, permalink and text for every result, covers all conversation types, includes thread replies, and supports a precise inclusive `after` Unix-timestamp parameter.

## Decision
Collect Slack with `slack_search_public_and_private` only, using:
- `after: "<last checkpoint, Unix ts>"` (inclusive). Not the day-level `after:YYYY-MM-DD` query modifier.
- `sort: "timestamp"`, `sort_dir: "asc"`.
- `limit: 20` (the maximum), following the returned cursor for more pages.
- `include_bots: false`, `include_context: false`, `response_format: "detailed"`.

Dedup key: channel ID + `Message_ts`. Thread parent: the `thread_ts` query parameter in the reply's permalink. Full threads: `slack_read_thread` (returns `Message TS` per reply). Classify conversation type from result labels, not the ID prefix (group DM IDs started with `C` in Phase 0).

## Consequences
- Positive: one call per page covers DMs, group DMs, private and public channels and thread replies.
- Negative: output is markdown inside JSON and must be parsed. Contract tests with anonymized fixtures are required, and the parser fails loudly on format change.
- Negative: search reflects current state only. Edits and deletions after collection are not detected.
- Negative: 20 results per page means many pages for backfill (ADR-017).

## Related
- [ADR-026](ADR-026-raw-tool-results-only.md), [ADR-027](ADR-027-bot-filtering-via-slack.md), [ADR-031](ADR-031-collector-worker-profile.md)
- [slack.md](../../modules/slack.md), [integration-contracts.md](../../architecture/integration-contracts.md), [phase0-results.md](../../../pre-project-concept-document/phase0-results.md)
