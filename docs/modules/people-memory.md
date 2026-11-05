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
| `people.generate_initial_profile` | user selects a person | intelligence / sonnet | `people.initial:<personId>:<date>` | 3; `incomplete_ai_output` retried |
| `people.recommend_update` | schedule (coalesce, `people.update.intervalSeconds`); each tick enqueues one `people.update_profile` job (priority 60) per profiled person with history newer than the current version's evidence and nothing pending | intelligence / haiku (`people.models.update`) | `people.update:<personId>:<newest sentAt>` | 3 |
| `people.assess_unknown` | the temporary-contact consumer, when a contact's `message_count` first reaches `people.unknown.minMessages`; runs at the end of the hour bucket (priority 40) | intelligence / haiku | `people.assess:<hourBucket>` | 3 |
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
| `people.update.intervalSeconds` | `86400` |
| `people.temporaryContact.ttlDays` | `30` |
| `people.recommendation.minConfidence` | `medium` |
| `people.models.initial` | `sonnet` |
| `people.models.update` | `haiku` |
| `people.history.days` | `90` |
| `people.history.maxMessages` | `150` |
| `people.unknown.minMessages` | `3` |

## Implementation notes (Phase 5)

### Priority and identity

A `people` row is created when first needed (a flag is recorded for the user, the user sets a priority, a profile is requested or suggested), not for every Slack user. `ensurePerson` also refreshes name and email from `slack_users` on every call (G2). `people_priority_settings` holds the priority (`normal`, `high`, `critical`), an optional rationale and the extra-attention flag; screening reads them as signals. `PUT /api/people/:slackUserId/priority` is a patch: omitted fields keep their stored value and `rationale: null` clears it (G3). Priority never comes from AI: every people output schema is `.strict()` and has no priority key. The user's Slack identity (`slack.selfUserId`) is confirmed through `/api/slack/identity`; a suggestion (`suggestSelfUserId`) is offered, never applied automatically. Without an identity there is no ranking, no temporary-contact tracking and no profile request (`identity_required`).

### Discovery scoring

`ContactDiscovery.listContactCandidates` (no AI, one aggregate SQL query, index-backed, about 100 ms on 100k messages) scores each Slack user over the last `people.history.days`: 3 per DM message, 2 per group-DM message, 2 per message mentioning the user (plain, `<@U|name>` and escaped forms, matched with `instr` in SQL, never loaded), 1 per reply in a thread both posted in. Candidates with score 0 are listed last. Each candidate reports whether it already has a profile, a pending recommendation or is a temporary contact. Returns `[]` without an identity.

### Temporary contacts and expiry

The `people.temporary` outbox consumer of `message.received` creates a `temporary_contacts` row for a sender with no `people` row (and emits `person.discovered` on first sight), counts messages, and sets `expires_at` to the newest message time plus `people.temporaryContact.ttlDays` (first insert is `sentAt + ttl`, so a backfill does not give old contacts a fresh lease; a later message only moves it forward). Tracking is off while the identity is unconfirmed and skips the user. The daily `people.expire_temporary` job deletes expired contacts that have no pending recommendation. When a contact's `message_count` first reaches `people.unknown.minMessages` the consumer enqueues `people.assess_unknown`.

### History selection and byte budget

`selectHistory` returns the newest `people.history.maxMessages` unexpired messages of the last `people.history.days`, oldest first: the person's own messages anywhere, the user's messages in a DM with the person, and every message of a thread both posted in. An update passes `after` to see only newer messages. The initial job needs at least 3 items (`insufficient_history` otherwise). Each message is its own `untrusted` part tagged `slack message <id> by them|you|other in <label> at <time>`, UTF-8 byte-capped with code points intact. The whole request stays under the validator's 100 KiB cap: the per-part budget is what is left after the system part, any lead part (the approved profile in updates) and every block's source and marker overhead, split across the parts; when a part would fall under 64 bytes the oldest items are dropped. Only what was actually sent (`used`) can be cited. The person's name is not put in the prompt. The run is the `intelligence` profile with `ToolSearch` only (models `people.models.initial`, `people.models.update`).

### Evidence validation (R2 keys)

`validateEvidence` removes cited ids that were not in the sent set (forged or out-of-set ids, or fake markers inside message text, never count), drops observations left with no valid id, below `people.recommendation.minConfidence`, or repeating a key within a section, and counts what it dropped. No observations left means no recommendation. Evidence rows store `observation_key` as `<section>.<key>` (R2, unambiguous across sections), `source_external_ref` as `<conversation external id>:<ts>` and the message id (set null when the message row is later deleted). When source messages expire the evidence keeps the external ref and the UI shows "original message no longer available locally".

### Observation hash and the same-as-rejected rule

`observation_hash` is the sha256 of the sorted `section:key:text` lines of the content that would result from the proposal (the profile itself for an initial, the applied diff for an update); it identifies the observation set, not its evidence. If a `rejected` recommendation of the person has the same hash, nothing is stored and the job returns `{ skipped: "same_as_rejected" }`. A dismissed suggestion has no hash and is not affected.

### Initial recommendation

`ProfileRecommendations.requestInitialProfile(slackUserId)` (container `profiles`) queues `people.generate_initial_profile` (priority 120, group `people.intelligence`, timeout 420 s, key `people.initial:<personId>:<date>`, so a person can be re-evaluated after a rejection the next day) and returns `{ queued: false, reason: "identity_required" | "pending_recommendation" | "already_run_today" }` instead of throwing. When validated observations remain, one transaction stores the pending recommendation, its evidence rows, a `records.update` approval (target `people`, key `people.rec:<id>`) and `person.profile_recommendation_created`. Profile text lives only in `people_profile_recommendations.content`: never in events, audit rows, notifications, logs or `lastError`. The handler's return value carries counts only.

### Approval execution and retry (R3)

Approval of a people recommendation runs the generic `approval.execute` path (see `runtime-design.md`) into `ProfileService.apply`, one immediate transaction, so a failure leaves no partial version. Executors throw only content-free messages because the engine stores `e.message` in the approval and audit row. A skipped apply (recommendation no longer pending, stale base, profile exists, suggestion) still ends as an executed approval with a skipped result. Rejection and expiry consumers set the recommendation `rejected` or `expired` and emit `person.recommendation_decided`; nothing else changes. A failed approval is terminal (R3), so `retryApply(recommendationId)` is allowed only for a pending recommendation whose current approval is `failed`: it requests a fresh approval (key `people.rec:<id>:<n>`, n at least 2) and points `approval_id` at it. Anything else throws `RetryNotAllowed` (409).

### Versions, stale base and supersede

Applying creates an immutable `people_profile_versions` row (monotonic per profile, unique on profile and version) and updates `people_profiles`. Evidence is copied to the version: all rows for an initial; for an update the touched keys from the recommendation plus untouched keys carried from the previous version. A recommendation that can no longer apply is marked `superseded` with a reason, never lost or duplicated: `stale_base` (an update whose `base_version` is not the current version, for example after another approval landed first), `profile_exists` (an initial when a profile already exists) or `unsupported_kind`. Concurrent approvals are serialised by the immediate transaction.

### Update proposals and their baseline

A daily scheduled tick (`people.update.intervalSeconds`) enqueues one `people.update_profile` job (priority 60, key `people.update:<personId>:<newest sentAt>`, which also bounds a remove-only re-proposal) per profiled person with nothing pending and history newer than the baseline. The baseline is the newest `observed_at` among the current version's evidence, or the version's `created_at` when it has none. The request carries the current approved content as ONE `user_approved` part (sections, keys, texts, confidence; no evidence ids) and the newer history as `untrusted` parts. Output is a diff (`profileUpdateOutputSchema`): every add must cite sent ids; a remove must cite at least one sent id and name a key present in the current content; invalid entries are dropped. A section may not exceed 20 observations after the diff (`section_full` skip). An empty diff or one that changes nothing stores nothing. The stored `update` keeps the diff as `content`, `base_version`, evidence for the adds and the approval.

### Unknown assessment and suggestions (R4)

`people.assess_unknown` (priority 40) assesses up to 10 unassessed contacts that have at least `minMessages` messages and one unexpired message, each as one `untrusted` part holding up to 5 recent messages. A returned id outside the batch or repeated fails the job as `incomplete_ai_output`. The result is stored in `temporary_contacts.profile_assessment` (`{ worthProfile, reason }`, reason through `renderExcerpt(..., 300)`) and `assessed_at`. `worthProfile: true` ensures a person row and creates a pending `suggest_evaluation` recommendation (reason only, no content, no approval) unless the person already has a pending recommendation. More than 10 candidates queue a follow-up in the next hour bucket. The suggestion is only a nudge: accepting it (`POST .../accept-suggestion`) marks it `applied` and requests the initial profile in one transaction (rolled back, suggestion kept, if nothing is queued). Dismissing it (R4, `POST .../dismiss`, pending `suggest_evaluation` only) sets `rejected` with reason `dismissed` and emits `person.recommendation_decided`, so a stuck suggestion can be removed. Priority is never set by the assessment.

### Flag attribution (R1)

People runs attribute security flags narrowly: runtime flags (permission denials, unexpected tools, max turns) are recorded once, against the evaluated person's newest provided message; an AI `suspectedInjection` flag links to the provided message whose text contains the model's quote (first match), else to the newest provided message. Attributing to all up to 150 messages would flood the red-flags list. For unknown assessment the newest message of the first contact in the batch is used.

### Guidelines in drafts

`getResponseGuidelines(personId)` returns the current approved response-guideline observations (or `[]`). `urgency.suggest_response` sends them as one `user_approved` part (at most 20 lines of at most 500 characters, labelled as the user's approved notes; the sender's Slack name is not in the rendered text) between the system part and the messages; they never override system rules. Without a person or guidelines the request is unchanged. See `urgency-engine.md`.

### Routes (localhost)

| Route | Purpose |
|---|---|
| `GET /api/people`, `PUT /api/people/:slackUserId/priority` | list; patch priority |
| `GET /api/people/candidates?limit=` | ranked candidates (limit 1..100, default 50) |
| `POST /api/people/:slackUserId/evaluate` | request the initial profile (202; result carries `queued` and a reason) |
| `GET /api/people/:slackUserId/profile` | person detail: current profile, versions, evidence, flags, pending recommendation |
| `GET /api/people/recommendations?status=` | recommendations (default `pending`) with evidence and approval state |
| `POST /api/people/recommendations/:id/accept-suggestion`, `.../dismiss`, `.../retry-apply` | 404 unknown, 409 not allowed |

Approving or rejecting a recommendation goes through the generic approvals routes. The web page (`apps/web`) shows candidates, a person page and a recommendation review list with server actions; it contains no business logic. A recommendation whose stored content is unreadable is shown but cannot be approved. Rejection reasons are capped at 500 characters for all approvals.

### Out of scope

- The §6.5 post-send flow (profile recommendation for a new recipient after a verified send, `followup.sent`) waits for Phase 6, which owns sending.
- Group and channel profiles (ADR-020).
- Per-person cap on evidence queries, a dedicated needs-attention kind for parked approvals, and contacts omitted by the model staying unassessed are known follow-ups.

### Smoke

`bun scripts/dev/people-smoke.ts [--pages N] [--self Uxxxx]` collects real Slack into a temp database, ranks, runs one haiku initial-profile job for the top candidate and prints counts only.

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
