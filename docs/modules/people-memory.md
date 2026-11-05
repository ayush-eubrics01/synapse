# People Memory

Covers the `people` domain module (`apps/api/src/modules/people`).

## Purpose

Store structured, user-approved knowledge about selected colleagues, so Synapse knows whose messages matter most and how to respond to each person. Priority is set only by the user. Profiles change only through approved recommendations.

## Responsibilities / Non-responsibilities

Responsibilities:

- Discover individual Slack contacts and let the user pick who to evaluate.
- Generate profile recommendations from the 90-day history of selected people.
- Approval workflow, profile version history, evidence and provenance.
- Temporary contacts for unknown people; recommend permanent profiles when useful.
- The post-send profile flow for new recipients (§6.5 of the concept).
- Manual people priority, used as one of the urgency signals.

Non-responsibilities:

- Profiles for groups or channels (deferred, ADR-020).
- Psychological or personality judgments. Only observable professional behaviour and communication preferences.
- Changing priority automatically. Claude may never set or change priority.

## Owned data (tables)

`people` (identity), `temporary_contacts`, `people_profiles` (current approved), `people_profile_versions` (immutable history), `people_profile_recommendations`, `people_profile_evidence`, `people_priority_settings`.

Identity is kept separate from approved knowledge. A person may exist as a temporary contact without a profile.

## Profile structure

| Section | Contents |
|---|---|
| Identity | Slack user ID, full name, email, job title, team/department, project associations |
| Professional context | Responsibilities, areas of ownership, technical knowledge, working relationship, expectations involving the user |
| Communication understanding | Observed preferences, preferred detail, patterns, recurring interactions |
| Response guidelines | Tone, technical detail level, conciseness, common clarifications, do's and don'ts |
| Priority | Manual priority, rationale, extra-attention flag (`people_priority_settings`) |
| Evidence | Per observation: source refs, confidence, date observed, last reviewed |

## Ports used / provided

- Uses the `ClaudeOrchestrator` (intelligence profile) for recommendations. Prompt builders and Zod output schemas live in `intelligence/`.
- Reads messages through the `inbox` module's public read service, never the Slack adapter.
- Provides a public read service: `getPriority(personId)`, `getResponseGuidelines(personId)`, `findBySlackUserId()`.

## Jobs

| Job type | Trigger | Profile / model | Idempotency key | Retry |
|---|---|---|---|---|
| `people.discover_contacts` | setup step 4 | none (from collected messages) | `people.discover:<date>` | 3 |
| `people.generate_initial_profile` | user selects a person | intelligence / sonnet | `people.initial:<personId>` | 3; `incomplete_ai_output` retried |
| `people.recommend_update` | periodic batch (default daily) for profiled people with new messages | intelligence / haiku or sonnet | `people.update:<personId>:<newest ts>` | 3 |
| `people.assess_unknown` | `person.discovered`, batched | intelligence / haiku | `people.assess:<slackUserId>` | 3 |
| `people.expire_temporary` | daily | none | `people.expire:<date>` | 3 |

The intelligence worker receives message text as untrusted content and has no write or send tools (ADR-032).

## Events

Emitted: `person.discovered`, `person.profile_recommendation_created`, `person.profile_approved`.

Consumed: `message.received` (unknown senders, new activity), `followup.sent` (post-send profile flow), `approval.approved` / `rejected` / `expired`.

## Workflows

Initial collection (setup):

```text
1. Discover individual contacts from collected DMs/messages
2. Present list → user selects who to evaluate
3. For each selected person: analyze available 90-day history
4. Generate profile recommendation with evidence
5. Present for approval
6. Save approved profile (version 1) + evidence
```

Profile update: analyze new context → compare with current profile → propose a diff with evidence → review queue → user approves/rejects → on approval write a new `people_profile_versions` row and update `people_profiles`. Rejection is recorded and nothing changes.

Unknown people: a message from an unknown sender creates a `temporary_contacts` row with just enough to handle the interaction. `people.assess_unknown` decides whether a permanent profile is useful. If so, it creates a recommendation for approval. Priority is never assigned automatically.

New recipient when completing a task (§6.5):

```text
identify recipient → load identity + conversation context
→ temporary communication context → contextual draft
→ approval → send → verify send succeeded (followup.sent)
→ only then start permanent profile recommendation (still needs approval)
```

A failed or cancelled send never creates a permanent profile.

## Permissions and approvals

Analyze conversations and generate recommendations: allowed. Create or update a permanent profile: approval required. Change priority: user only, through the UI. There is no AI path to it.

## Failure handling

- Invalid AI output (fails Zod) → `incomplete_ai_output`, retried; after max attempts `NEEDS_ATTENTION`.
- Unsupported observation (no evidence refs) → dropped from the recommendation, not stored.
- Retention: when source messages expire, evidence keeps `source_external_ref`. The UI shows "original message no longer available locally."
- A rejected recommendation is never re-proposed unchanged. The next recommendation must include new evidence.

## Configuration

| Key | Default |
|---|---|
| `people.update.schedule` | daily |
| `people.temporaryContact.ttlDays` | `30` |
| `people.recommendation.minConfidence` | `medium` |
| `people.models.initial` | `sonnet` |
| `people.models.update` | `haiku` |

## Phase 4 note (priority only)

Phase 4 implements only the priority part of this module: a `people` row is created for a Slack user when it is first needed (a red flag is recorded for them, or the user sets their priority), not on first sight of every Slack user (`GET /api/people` lists every stored Slack user, with priority `normal` where no setting exists), and `people_priority_settings` holds the priority (`normal`, `high`, `critical`), an optional rationale and the extra-attention flag. Screening reads them as signals (+1 each, and a lower candidate threshold). The user sets them from the dashboard (`GET /api/people`, `PUT /api/people/:slackUserId/priority`, which replaces the whole setting). Priority never comes from AI: no schema accepts it. The user's own Slack identity (`slack.selfUserId`) is confirmed through `/api/slack/identity`; a suggestion is offered but never applied automatically, and without a suggestion the dashboard offers a manual pick from `GET /api/people`. While no identity is confirmed, urgent notifications and suggested replies are paused (see `urgency-engine.md`). Profiles, recommendations and temporary contacts are not built yet.

## Tests

- Profile recommendation rejected → no profile change, rejection recorded.
- Approval creates a version; history preserved.
- Observation without evidence → not stored.
- Claude output attempting to set priority → ignored/rejected by the schema.
- Unknown sender → temporary contact, no profile, no priority.
- §6.5: failed/cancelled send → no profile; successful send → recommendation only.
- Source message expired → evidence still shows the external ref.

## Open questions

- Temporary contact TTL (30 days) is a proposal, not from the concept.
- OQ-1 resolved by ADR-033: manual priority also decides who may receive away-mode auto-replies. Response guidelines feed both drafts and auto-replies.

See `docs/product/open-questions.md`.
