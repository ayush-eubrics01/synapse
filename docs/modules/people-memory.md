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
| `people.generate_initial_profile` | user selects a person | intelligence / sonnet | `people.initial:<personId>:<date>` | 3; `incomplete_ai_output` retried |
| `people.recommend_update` | schedule (coalesce, `people.update.intervalSeconds`); each tick enqueues one `people.update_profile` job (priority 60) per profiled person with history newer than the current version's evidence and nothing pending | intelligence / haiku (`people.models.update`) | `people.update:<personId>:<newest sentAt>` | 3 |
| `people.assess_unknown` | the temporary-contact consumer, when a contact's `message_count` first reaches `people.unknown.minMessages`; runs at the end of the hour bucket (priority 40) | intelligence / haiku | `people.assess:<hourBucket>` | 3 |
| `people.expire_temporary` | daily schedule (coalesce) | none | none (an idempotent delete by predicate) | 3 |

Contact discovery is not a job: `GET /api/people/candidates` runs one ranking query over the collected messages (see Discovery scoring).

The intelligence worker receives message text as untrusted content and has no write or send tools (ADR-032).

## Events

Emitted: `person.discovered`, `person.profile_recommendation_created`, `person.profile_approved`, `person.recommendation_decided`.

Consumed: `message.received` (temporary contacts for unknown senders who interact with the user), `approval.rejected` / `approval.revoked` / `approval.expired` (the `people.decisions` consumer). Approved recommendations are applied by the generic `approval.execute` path, not by a people consumer of `approval.approved`. `followup.sent` (the `people.post_send` consumer, see "Post-send suggestion").

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

Unknown people: a message from an unknown sender who interacts with the user (a DM or group DM, a mention of the user, or a reply in a thread the user posted in) creates a `temporary_contacts` row with just enough to handle the interaction. `people.assess_unknown` decides whether a permanent profile is useful. If so, it creates a pending `suggest_evaluation` (no content, no approval); accepting it requests the initial profile, which then goes through approval. Priority is never assigned automatically.

New recipient when completing a task (§6.5):

```text
identify recipient → load identity + conversation context
→ temporary communication context → contextual draft
→ approval → send → verify send succeeded (followup.sent)
→ only then start permanent profile recommendation (still needs approval)
```

A failed or cancelled send never creates a permanent profile. As built (H2), a sent follow-up to someone without a profile or pending recommendation only produces a `suggest_evaluation` nudge (see "Post-send suggestion"); the profile itself still needs the user's accept and approval.

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

The `people.temporary` outbox consumer of `message.received` creates a `temporary_contacts` row for a sender with no `people` row (and emits `person.discovered` on first sight), counts messages, and sets `expires_at` to the newest message time plus `people.temporaryContact.ttlDays` (first insert is `sentAt + ttl`, so a backfill does not give old contacts a fresh lease; a later message only moves it forward). Tracking is off while the identity is unconfirmed and skips the user. Tracking scope (R7): only a message that interacts with the user counts, using discovery's signals (`INTERACTIVE_CONVERSATION_TYPES` and `selfMentionNeedles` in `discovery.ts`): a DM or group DM, a mention of the user, or a reply in a thread the user posted in (as root or reply). The check reads the message itself and, for a thread reply only, runs one query with two index probes (`(conversation_id, ts)` for the root, `(conversation_id, thread_ts)` for replies). A message older than `people.temporaryContact.ttlDays` is ignored (it would expire on arrival). The daily `people.expire_temporary` job deletes expired contacts that have no pending recommendation. When a contact's `message_count` first reaches `people.unknown.minMessages` the consumer enqueues `people.assess_unknown`.

### History selection and byte budget

`selectHistory` returns the newest `people.history.maxMessages` unexpired messages of the last `people.history.days`, oldest first: the person's own messages anywhere, the user's messages in a DM with the person, and every message of a thread both posted in. An update passes `after` to see only newer messages. The initial job needs at least 3 items (`insufficient_history` otherwise). Each message is its own `untrusted` part tagged `slack message <id> by them|you|other in <label> at <time>`, UTF-8 byte-capped with code points intact. The whole request stays under the validator's 100 KiB cap: the per-part budget is what is left after the system part, any lead part (the approved profile in updates) and every block's source and marker overhead, split across the parts; when a part would fall under 64 bytes the oldest items are dropped. Only what was actually sent (`used`) can be cited. The person's name is not put in the prompt. The run is the `intelligence` profile with `ToolSearch` only (models `people.models.initial`, `people.models.update`).

### Evidence validation (R2 keys)

`validateEvidence` removes cited ids that were not in the sent set (forged or out-of-set ids, or fake markers inside message text, never count), drops observations left with no valid id, below `people.recommendation.minConfidence`, or repeating a key within a section, and counts what it dropped. No observations left means no recommendation. Evidence rows store `observation_key` as `<section>.<key>` (R2, unambiguous across sections), `source_external_ref` as `<conversation external id>:<ts>` and the message id (set null when the message row is later deleted). When source messages expire the evidence keeps the external ref and the UI shows "original message no longer available locally".

### Observation hash and the same-as-rejected rule

`observation_hash` is the sha256 of the sorted `section:key:text` lines of the content that would result from the proposal (the profile itself for an initial, the applied diff for an update); it identifies the observation set, not its evidence. If a recommendation of the person that the user rejected has the same hash, nothing is stored and the job returns `{ skipped: "same_as_rejected" }`. Rows rejected with reason `discarded` or `revoked` were never judged on their content, so they do not block a re-proposal. A dismissed suggestion has no hash and is not affected.

### Initial recommendation

`ProfileRecommendations.requestInitialProfile(slackUserId)` (container `profiles`) queues `people.generate_initial_profile` (priority 120, group `people.intelligence`, timeout 420 s, key `people.initial:<personId>:<date>`, so a person can be re-evaluated after a rejection the next day) and returns `{ queued: false, reason: "identity_required" | "profile_exists" | "pending_recommendation" | "already_run_today" }` instead of throwing. An initial cannot apply over an existing profile, so a person with a profile gets `profile_exists` (R7; later changes come from the update schedule), and a job queued before a profile was approved returns `{ skipped: "profile_exists" }` without a Claude run. When validated observations remain, one transaction stores the pending recommendation, its evidence rows, a `records.update` approval (target `people`, key `people.rec:<id>`) and `person.profile_recommendation_created`. Profile text lives only in `people_profile_recommendations.content`: never in events, audit rows, notifications, logs or `lastError`. The handler's return value carries counts only.

### Approval execution and retry (R3)

Approval of a people recommendation runs the generic `approval.execute` path (see `runtime-design.md`) into `ProfileService.apply`, one immediate transaction, so a failure leaves no partial version. Executors throw only content-free messages because the engine stores `e.message` in the approval and audit row. A skipped apply (recommendation no longer pending, stale base, profile exists, suggestion) still ends as an executed approval with a skipped result. Rejection and expiry consumers set the recommendation `rejected` or `expired` and emit `person.recommendation_decided`; nothing else changes. A revoked approval can never apply either, so `approval.revoked` sets `rejected` with reason `revoked` (R6). Each decision runs in a savepoint inside the dispatcher's delivery: a failure rolls back that decision only, is logged with the approval id and the error class (never content), and leaves the recommendation pending for the user to discard. The executor acts only through the recommendation's current approval: an approval whose id is not `approval_id` (a stale or stray approval with the same payload) ends executed with `{ status: "skipped", reason: "approval_mismatch" }` and changes nothing (R7). A failed approval is terminal (R3), so `retryApply(recommendationId)` is allowed only for a pending recommendation whose current approval is `failed`: it requests a fresh approval (key `people.rec:<id>:<n>`, n at least 2) and points `approval_id` at it. Anything else throws `RetryNotAllowed` (409).

### Discarding a stuck recommendation (R6)

A pending recommendation blocks the person (no new initial or update while one is pending), so one whose approval can no longer apply it must be removable. `discard(recommendationId)` (`POST /api/people/recommendations/:id/discard`) is allowed for a pending `initial` or `update` whose current approval is `revoked`, `rejected`, `expired` or `failed` (the decision consumer did not land, or the user prefers not to retry), or `approved` but not executed for more than an hour (`STUCK_APPROVED_MS`: an execution skipped, for example after the permission was tightened, or a crash after the claim). It sets `rejected` with reason `discarded`, sets `decided_at` and emits `person.recommendation_decided`; anything else throws `DiscardNotAllowed` (409), an unknown id `RecommendationNotFound` (404). The approval itself is left as it is; the executor skips a recommendation that is no longer pending. The rule is `isDiscardable` in `recommendations.ts`, and the review list computes its actions from it server-side: a failed apply offers `retry` and `discard`, other stuck states `discard`. A discarded recommendation was not judged on its content, so the same observation set may be proposed again. Suggestions use `dismiss` instead.

### Versions, stale base and supersede

Applying creates an immutable `people_profile_versions` row (monotonic per profile, unique on profile and version) and updates `people_profiles`. Evidence is copied to the version: all rows for an initial; for an update the touched keys from the recommendation plus untouched keys carried from the previous version. A recommendation that can no longer apply is marked `superseded` with a reason, never lost or duplicated: `stale_base` (an update whose `base_version` is not the current version, for example after another approval landed first), `profile_exists` (an initial when a profile already exists) or `unsupported_kind`. Concurrent approvals are serialised by the immediate transaction.

### Update proposals and their baseline

A daily scheduled tick (`people.update.intervalSeconds`) enqueues one `people.update_profile` job (priority 60, key `people.update:<personId>:<newest sentAt>`, which also bounds a remove-only re-proposal) per profiled person with nothing pending and history newer than the baseline. The baseline is the newest `observed_at` among the current version's evidence, or the version's `created_at` when it has none. The request carries the current approved content as ONE `user_approved` part (sections, keys, texts, confidence; no evidence ids) and the newer history as `untrusted` parts. Output is a diff (`profileUpdateOutputSchema`): every add must cite sent ids; a remove must cite at least one sent id and name a key present in the current content; invalid entries are dropped. A section may not exceed 20 observations after the diff (`section_full` skip). An empty diff or one that changes nothing stores nothing. The stored `update` keeps the diff as `content`, `base_version`, evidence for the adds and the approval. The removes' citations are stored as evidence of the recommendation too, under `observation_key` `remove:<section>.<key>` (R7; distinct from the add of a modified key, confidence of the observation removed), so the review shows them on each removed observation; they are never copied to a version.

### Unknown assessment and suggestions (R4)

`people.assess_unknown` (priority 40) assesses up to 10 unassessed contacts that have at least `minMessages` messages, one unexpired message and no `people` row (R7: someone with a priority, a profile or a request is already known), each as one `untrusted` part holding up to 5 recent messages. A returned id outside the batch or repeated fails the job as `incomplete_ai_output`. The result is stored in `temporary_contacts.profile_assessment` (`{ worthProfile, reason }`, reason through `renderExcerpt(..., 300)`) and `assessed_at`. A contact of the batch the model left out gets `{ omitted: true }` and `assessed_at` (R7), so it leaves the batch instead of being re-sent every run. `worthProfile: true` ensures a person row and creates a pending `suggest_evaluation` recommendation (reason only, no content, no approval) unless the person already has a pending recommendation. More than 10 candidates queue a follow-up in the next hour bucket. The suggestion is only a nudge: accepting it (`POST .../accept-suggestion`) marks it `applied` and requests the initial profile in one transaction (rolled back, suggestion kept, if nothing is queued). Dismissing it (R4, `POST .../dismiss`, pending `suggest_evaluation` only) sets `rejected` with reason `dismissed` and emits `person.recommendation_decided`, so a stuck suggestion can be removed. Priority is never set by the assessment.

### Flag attribution (R1, R5)

People runs attribute security flags narrowly: runtime flags (permission denials, unexpected tools, max turns) are recorded once, against one target message; an AI `suspectedInjection` flag links to the provided message whose text contains the model's quote (first match), else to the same target. Attributing to all up to 150 messages would flood the red-flags list. The target (`flagTarget`, R5) is the newest provided item written by the person, else the newest non-self item (a bystander in a shared thread). A flag is never attributed to `slack.selfUserId`: quote matching skips the user's messages, and a run that was given only the user's messages (possible for an update) records no flag. A flag on the user's own message would otherwise create a `people` row for the user and a "Red flag: message from <me>" popup. For unknown assessment the newest message of the first contact in the batch is used (every batch message is a contact's own).

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
| `POST /api/people/recommendations/:id/accept-suggestion`, `.../dismiss`, `.../retry-apply`, `.../discard` | 404 unknown, 409 not allowed |

Approving or rejecting a recommendation goes through the generic approvals routes. The web page (`apps/web`) shows candidates, a person page and a recommendation review list with server actions; it contains no business logic. A recommendation whose stored content is unreadable is shown but cannot be approved. Rejection reasons are capped at 500 characters for all approvals.

### Post-send suggestion (H2, §6.5)

`PostSendSuggestions` (`modules/people/post-send.ts`) is the outbox consumer `people.post_send` of `followup.sent`. The event is emitted once when a follow-up's outgoing message is `sent` (verified or marked sent) or `sent_unverified` (the send tool ran); a failed, cancelled or discarded send never emits it. The recipient is the follow-up's `recipient_slack_user_id`. The consumer skips the recipient when there is none, when it is `slack.selfUserId`, when `slack_users.is_bot` is true, when the person already has a profile, or when the person already has a pending recommendation of any kind. Otherwise it ensures the person row and stores a pending `suggest_evaluation` recommendation with the reason "You messaged this person" (no content, no approval; the user accepts or dismisses it like any suggestion, and accepting requests the initial profile). It runs in a savepoint and never throws: a failure rolls back its own writes and logs one line with the follow-up id and the error name only.

### Out of scope

- Evaluating a recipient automatically: the post-send flow only suggests; the user decides.
- Group and channel profiles (ADR-020).
- Per-person cap on evidence queries and a dedicated needs-attention kind for parked approvals are known follow-ups.

### Smoke

`bun scripts/dev/people-smoke.ts [--pages N] [--self Uxxxx]` collects real Slack into a temp database, ranks, runs one haiku initial-profile job for the top candidate and prints counts only.

## Tests

- Profile recommendation rejected → no profile change, rejection recorded.
- Approval creates a version; history preserved.
- Observation without evidence → not stored.
- Claude output attempting to set priority → ignored/rejected by the schema.
- Unknown sender → temporary contact, no profile, no priority.
- §6.5: failed/cancelled send → no profile; successful send → recommendation only (H2: `apps/api/test/modules/people-post-send.test.ts` covers unprofiled, profiled, self, bot and pending recipients, and a failing consumer).
- Source message expired → evidence still shows the external ref.

## Open questions

- Temporary contact TTL (30 days) is a proposal, not from the concept.
- OQ-1 resolved by ADR-033: manual priority also decides who may receive away-mode auto-replies. Response guidelines feed both drafts and auto-replies.

See `docs/product/open-questions.md`.
