# ADR-017: Initial Slack History — 90 Days
- **Status:** Accepted
- **Date:** 2026-11-05
- **Source:** concept.md §5.2, §20 Step 3; Phase 0 results

## Context
People Memory evaluation and the initial inbox need recent history, but backfill costs Claude invocations.

## Decision
The initial backfill collects the last 90 days of human messages from all accessible DMs, group DMs, private channels and public channels, independently of People Memory selection.

Phase 0 sizing: about 25–60 messages/day → ~2,300–5,400 messages → ~115–270 search pages at 20/page → about 25–55 short collector runs of ~5 pages each, ≈ $0.25–0.60 API-equivalent on Haiku. A 5-page burst hit no rate limits.

## Consequences
- Positive: enough history for profiles and commitments.
- Negative: backfill takes many runs. It is checkpointed after every page (`integration_sync_states` stream `slack.backfill`) so it can resume.
- Follow-up: sustained Slack rate limits at backfill volume are unverified.

## Related
- [ADR-018](ADR-018-slack-message-retention-180-days.md), [ADR-025](ADR-025-slack-collection-via-search.md)
- [slack.md](../../modules/slack.md)
