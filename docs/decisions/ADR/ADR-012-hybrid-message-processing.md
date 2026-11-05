# ADR-012: Hybrid Message Processing
- **Status:** Accepted
- **Date:** 2026-11-05
- **Source:** concept.md §7.1, §7.2; requirements.md #4

## Context
The user's 5-hour Claude allowance is limited. Calling Claude for every message would waste it.

## Decision
Separate collection from analysis. Pipeline: collection → normalization → deduplication → storage → cheap rule-based screening → (a) potentially urgent → contextual urgency assessment by Claude, or (b) normal → batched analysis. If a collection run finds no new messages, no analysis runs.

## Consequences
- Positive: Claude analysis runs only on candidates and batches.
- Negative (Phase 0): collection itself needs a Claude invocation per poll, because the Slack credential lives in the connector. An empty poll still costs about one small Haiku run. Polling frequency is the main steady-state cost lever.
- Follow-up: tune screening rules so false negatives on urgency stay rare.

## Related
- [ADR-025](ADR-025-slack-collection-via-search.md), [ADR-028](ADR-028-haiku-default-for-collection.md)
- [urgency-engine.md](../../modules/urgency-engine.md), [slack.md](../../modules/slack.md)
