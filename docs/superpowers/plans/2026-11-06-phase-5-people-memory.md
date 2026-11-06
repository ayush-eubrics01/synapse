# Phase 5: People Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The user picks colleagues to evaluate. Claude proposes evidence-backed profiles from their collected history (professional context, communication understanding, response guidelines). A profile is saved, with immutable version history, only after the user approves it. Periodic update proposals, temporary contacts for unknown senders, and suggestions of who is worth profiling keep it current. Approved response guidelines then shape the Phase 4 reply drafts.

**Architecture:**
- **Discovery:** ranks contacts from stored messages, with no AI.
- **Initial and update recommendation jobs:** send a person's message history to the orchestrator as `untrusted` parts, one per message, each tagged with its message id. The jobs validate a Zod schema in which every observation cites message ids from the provided set. Uncited or low-confidence observations are dropped.
- **Approval:** each recommendation becomes an approval (`records.update`, target `people`). A new generic approval-execution path runs a registered executor. It is the outbox consumer on `approval.approved`, which enqueues `approval.execute`. The executor writes the new profile version and its evidence.
- **Temporary contacts and expiry:** temporary contacts come from a `message.received` consumer and expire daily.

**Tech Stack:** Bun 1.4.4, TypeScript strict, Hono, bun:sqlite + Drizzle (generated migrations), Zod 4, Next.js 16, `bun test`.

**Spec:**
- `docs/modules/people-memory.md`, ADR-032
- `docs/superpowers/plans/2026-11-05-phase-4-followups.md` (Phase 5 entry gate G1–G5)
- `docs/architecture/database-design.md` (people tables)

**Out of scope, decided:**
- The §6.5 post-send profile flow (it needs sending, which is Phase 6).
- Group and channel profiles (ADR-020).
- G4, reviewing flag patterns with real data. It needs a deliberate session with the user, so it stays in the follow-ups.

## Global Constraints

- **CLAUDE.md hard rules:**
  - Only `core/orchestrator` runs Claude.
  - Message text is `untrusted`. People runs are the intelligence profile with `allowedTools: ["ToolSearch"]` (ADR-032).
  - Approved profile content counts as `user_approved` provenance.
  - No Slack content or profile text in logs, audit rows, events, notification titles or `lastError`. Profile text lives only in the people tables and in route responses.
- **Priority is user-only.** No AI output schema accepts a priority field. A schema with `.strict()` objects rejects extra keys.
- **No psychological or personality judgments.** The prompt restricts observations to observable professional behaviour and communication preferences.
- **Migrations:** every schema change has a new generated migration (`bunx --bun drizzle-kit generate --name <name>` from `packages/database`). Never edit an applied one. Update `database-design.md`.
- No new runtime dependency.
- **Claude in tests:** tests never run real `claude`. Every new Claude-calling path has one fake-binary e2e test through the real `ClaudeCliProvider` and `ClaudeOrchestrator`, following `apps/api/test/integration/urgency-provider-e2e.test.ts`.
- **Prompt budget:** every Claude request stays under the validator's 100 KiB prompt cap. Use `intelligence/urgency/cap-bytes.ts` (`capBytes`, `perPartBytes`); messages are UTF-8 byte-capped with code points intact.
- **Job priorities** (higher runs first): `people.generate_initial_profile` = 120, `people.recommend_update` = 60, `people.assess_unknown` = 40, `approval.execute` = 180.
- **Concurrency group:** all people Claude jobs use `concurrencyGroup: "people.intelligence"`.
- **Settings** (exact keys and defaults, in `apps/api/src/core/config/settings.ts`):

| Key | Default |
|---|---|
| `people.update.intervalSeconds` | `86400` |
| `people.temporaryContact.ttlDays` | `30` |
| `people.recommendation.minConfidence` | `"medium"` (enum low/medium/high) |
| `people.models.initial` | `"sonnet"` |
| `people.models.update` | `"haiku"` |
| `people.history.days` | `90` |
| `people.history.maxMessages` | `150` |
| `people.unknown.minMessages` | `3` |

## Review Focus

1. **Forged or out-of-set evidence.** The model cites message ids not in the provided set, or a message's text contains fake id markers. Every cited id must be in the provided set. Observations with no valid citation are dropped, and a recommendation with zero valid observations is not created. Test in Task 4.
2. **Re-proposal of a rejected recommendation.** A recommendation with the same observation set as a rejected one, and no new evidence, is never stored again. Test in Task 6.
3. **Concurrent approvals.** Approving two recommendations for the same person in quick succession must never lose a version or create duplicate version numbers. Versions are monotonic per profile, and an update based on a stale version is re-based or rejected with a clear status. Test in Task 5.
4. **Expired source messages.** Evidence keeps `source_external_ref`, and the UI shows "original message no longer available locally". Tests in Tasks 5 and 8.
5. **Users with huge histories.** A person with 5,000 messages produces one request under the byte cap, using the newest `maxMessages`. Test in Task 4.

---

### Task 1: Schema, contracts, settings (and G1)

**Files:**
- Modify:
  - `packages/database/src/schema/platform.ts`
  - `apps/api/src/core/config/settings.ts`
  - `packages/contracts/src/{events.ts, index.ts}`
  - `docs/architecture/database-design.md`
  - `apps/api/src/modules/inbox/urgent.ts`, `apps/api/src/modules/security-flags/service.ts`, `apps/web/lib/api.ts` (G1: import the DTO types from contracts)
- Create: `packages/contracts/src/people.ts`, `packages/contracts/src/dashboard.ts` (G1), migration `0008_people_memory`
- Test: `packages/database/test/schema-phase5.test.ts`, `packages/contracts/test/people.test.ts`

**Interfaces:**
- **Columns added to `people`:** `title`, `team` (nullable).
- **Tables:**
  - `temporary_contacts`: `id`, `slack_user_id` unique, `first_seen_at`, `last_seen_at`, `message_count` int default 0, `expires_at`, `profile_assessment` JSON nullable, `assessed_at` nullable.
  - `people_profiles`: `id`, `person_id` FK unique, `current_version` int, `content` JSON, `updated_at`.
  - `people_profile_versions`: `id`, `profile_id` FK, `version` int, `content` JSON, `recommendation_id` FK, `approval_id` nullable, `created_at`; unique(`profile_id`,`version`).
  - `people_profile_recommendations`:
    - `id`, `person_id` FK, `kind` (`initial`/`update`/`suggest_evaluation`), `base_version` int nullable, `content` JSON nullable, `observation_hash` nullable, `status` (`pending`/`approved`/`rejected`/`expired`/`superseded`/`applied`), `approval_id` nullable, `claude_run_id` nullable, `reason` nullable, `created_at`, `decided_at` nullable.
    - Index (`person_id`,`status`).
  - `people_profile_evidence`:
    - `id`, `recommendation_id` FK nullable, `version_id` FK nullable, `observation_key` text, `message_id` FK nullable (ON DELETE SET NULL), `source_external_ref` not null, `confidence` (`low`/`medium`/`high`), `observed_at`.
    - Index (`version_id`), (`recommendation_id`).
- **`packages/contracts/src/people.ts` exports:**
  - `ProfileSection = "professionalContext"|"communication"|"responseGuidelines"`.
  - `observationSchema = z.object({ key: z.string().regex(/^[a-z0-9_.-]{1,64}$/), text: z.string().min(1).max(500), evidence: z.array(z.string()).min(1).max(10), confidence: z.enum(["low","medium","high"]) }).strict()`.
  - `profileContentSchema = z.object({ professionalContext: z.array(observationSchema).max(20), communication: z.array(observationSchema).max(20), responseGuidelines: z.array(observationSchema).max(20) }).strict()`.
  - `initialProfileOutputSchema = z.object({ profile: profileContentSchema, suspectedInjection: suspectedInjectionSchema }).strict()`.
  - `profileUpdateOutputSchema = z.object({ add: z.array(observationSchema.extend({ section: sectionSchema })).max(20), remove: z.array(z.object({ section: sectionSchema, key: z.string(), evidence: z.array(z.string()).min(1).max(10) }).strict()).max(20), suspectedInjection: suspectedInjectionSchema }).strict()`. A modify is a remove plus an add with the same key.
  - `unknownAssessmentOutputSchema = z.object({ assessments: z.array(z.object({ slackUserId: z.string(), worthProfile: z.boolean(), reason: z.string().min(1).max(300) }).strict()).min(1), suspectedInjection: suspectedInjectionSchema }).strict()`.
  - DTO types used by routes: `PersonSummary`, `PersonDetail`, `RecommendationView`, `ContactCandidate`.
- **`packages/contracts/src/dashboard.ts`** (G1): moves the `UrgentItem` and grouped-flag DTO types out of modules and web. Behaviour is unchanged.
- **Events:**
  - `person.discovered: { slackUserId }`
  - `person.profile_recommendation_created: { recommendationId, personId, kind }`
  - `person.profile_approved: { personId, version }`
  - `person.recommendation_decided: { recommendationId, status }`
- **Settings:** per the Global Constraints table.

- [ ] **Step 1: Failing tests.**
  - Uniques: (`profile_id`,`version`); `temporary_contacts.slack_user_id`.
  - `profileContentSchema` rejects an extra `priority` key, at the root and inside an observation.
  - `observationSchema` rejects `evidence: []`.
  - The event payloads parse.
  - Settings defaults.
- [ ] **Step 2: Run** `bun test packages apps/api/test/core` → FAIL.
- [ ] **Step 3: Implement.** Generate the migration. Move the G1 types and update their imports.
- [ ] **Step 4: Run** `bun run check` and `bun run --cwd apps/web build` → PASS.
- [ ] **Step 5: Commit** `feat(db,contracts): people memory schema and contracts`.

### Task 2: Approval execution path

**Files:**
- Create: `apps/api/src/core/approvals/execution.ts`
- Modify: `apps/api/src/core/approvals/approvals.ts` (only if needed), `apps/api/src/container.ts`, `docs/modules/` (approvals section of the relevant core doc, or `docs/architecture/runtime-design.md`)
- Test: `apps/api/test/core/approval-execution.test.ts`

**Interfaces:**
- `registerApprovalExecution(deps: { dispatcher, queue, engine, handlers }): void`:
  - Subscribes consumer `approvals.execute` to `approval.approved`. It enqueues job `approval.execute` with key `approval.execute:<approvalId>`, priority 180 and input `{ approvalId }`.
  - Registers the `approval.execute` handler, which calls `engine.execute(approvalId)`.
  - An outcome of `failed` throws `JobError({kind: "provider_error"})`, so the job retries up to 3 times. Payloads and results never appear in `lastError`.
- **Executor routing by integration:** `registerIntegrationExecutor(action: Operation, targetIntegration: string, ex: Executor)`. It is a thin routing executor registered once per action, which dispatches on `approval.targetIntegration`. An unknown integration → `failed` with the message `"no executor"`.
- `approval.rejected` and `approval.expired` are delivered to modules through ordinary `dispatcher.subscribe`. This task adds no generic consumer for them.

- [ ] **Step 1: Failing tests.**
  - Approve, then the consumer enqueues exactly one job (a replay enqueues none), then the handler runs the registered executor once, then the approval is `executed`.
  - The executor throws on the first attempt → the job retries → it succeeds on the second.
  - Unknown integration → approval `failed` and a content-free job error.
  - A revoked approval is never executed.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun run check` → PASS.
- [ ] **Step 5: Commit** `feat(api): approval execution path with per-integration executors`.

### Task 3: Identity, discovery, temporary contacts (and G2, G3)

**Files:**
- Modify: `apps/api/src/modules/people/service.ts`
- Create: `apps/api/src/modules/people/{discovery.ts, temporary.ts}`, `apps/api/src/workers/people.ts`
- Modify: `apps/api/src/container.ts`
- Test: `apps/api/test/modules/people-discovery.test.ts`, `apps/api/test/workers/people-temporary.test.ts`

**Interfaces:**
- **G2:** `ensurePerson` refreshes `name`/`email` from `slack_users` when they changed. It uses `onConflictDoUpdate` and only overwrites a null or changed value.
- **G3:** `setPriority` becomes a patch. Omitted fields keep their stored value; `rationale: null` clears it explicitly. The PUT route stays as it is; its docs now say patch.
- `listContactCandidates({ limit = 50 }): ContactCandidate[]`. It ranks people (excluding self) over the last `people.history.days` by `score` = 3×(their messages in `im` with self) + 2×(their messages in `mpim`) + 2×(their messages that mention `<@self>`) + 1×(their replies in threads where self also posted).
  - Returns `{ slackUserId, name, score, messageCount, hasProfile, hasPendingRecommendation, isTemporary }`.
  - If `slack.selfUserId` is null it returns `[]`, and the route reports `identityRequired: true`.
- **Temporary contacts:** consumer `people.temporary` on `message.received`. When the sender is not self, not in `people` and has no profile:
  - Upsert `temporary_contacts`: count +1, `last_seen_at`, `expires_at = now + ttlDays`.
  - On the first insert, emit `person.discovered`.
  - Never throw: errors are logged with the id only.
  - Messages older than `people.history.days` are ignored, so a backfill doesn't create stale temporary contacts.
- **Expiry:** job `people.expire_temporary`, scheduled daily (`intervalSeconds` 86400, coalesce). It deletes expired temporary contacts that have no pending recommendation. Key `people.expire:<YYYY-MM-DD>`.

- [ ] **Step 1: Failing tests.**
  - Scoring order, using fixture conversations.
  - Self excluded. Null self → `[]`.
  - A new unknown sender → one temporary contact and one `person.discovered`; a second message → count 2 and no second event.
  - A sender with a profile → no temporary contact.
  - A message older than 90 days → none.
  - Expiry deletes only expired rows without a pending recommendation.
  - G2: a name change in `slack_users` is reflected after `ensurePerson`.
  - G3: `setPriority({priority:"high"})` keeps an existing rationale and extraAttention.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun run check` → PASS.
- [ ] **Step 5: Commit** `feat(api): contact discovery, temporary contacts, identity refresh`.

### Task 4: Initial profile recommendation

**Files:**
- Create: `apps/api/src/intelligence/people/{history.ts, initial-prompt.ts, evidence.ts}`, `apps/api/src/modules/people/recommendations.ts`
- Modify: `apps/api/src/workers/people.ts`
- Test: `apps/api/test/workers/people-initial.test.ts`, `apps/api/test/integration/people-provider-e2e.test.ts`, fixtures `apps/api/test/fixtures/streams/people_*.jsonl`

**Interfaces:**
- `selectHistory(db, slackUserId, { days, maxMessages, selfUserId }): HistoryItem[]`
  - Includes, from the last `days`, messages that are not expired and that match any of these:
    - sent by the person in any conversation;
    - sent by self in an `im` with the person;
    - thread messages in threads where both posted.
  - Newest `maxMessages`, returned oldest first.
  - `HistoryItem = { messageId, sentAt, author: "them"|"self"|"other", conversationLabel, text }`.
- `buildInitialRequest(person: { name; title?; team? }, items: HistoryItem[], jobId): ClaudeJobRequest`:
  - Intelligence profile, `priorityClass: "batch"`, `model` = `people.models.initial`, `allowedTools: ["ToolSearch"]`, `maxTurns: 3`.
  - One `system` part: the section definitions, the "observable professional behaviour only — no personality or psychological judgments, no protected characteristics" rule, the output contract, and "cite message ids exactly as given".
  - One `untrusted` part per item. The source is `slack message <messageId> by <them|you|other> in <label> at <sentAt>`, and the content is the text, capped by `perPartBytes(items.length + 1)`.
- `validateEvidence(content, providedIds: Set<string>, minConfidence): { content: ProfileContent; dropped: number }`:
  - Removes every cited id that is not in the set.
  - Drops observations left with zero ids, or with confidence below `minConfidence`.
  - Deduplicates keys per section.
- **Job `people.generate_initial_profile`** (input `{ personId }`, key `people.initial:<personId>:<YYYY-MM-DD>`, timeout 420 s). The handler:
  1. Skips if a pending recommendation already exists for the person, or if fewer than 3 history items exist (completes with `{ skipped }`).
  2. Calls `orchestrator.run`, records runtime flags (reuse `workers/urgency-shared.ts`), then calls `parseStructured(initialProfileOutputSchema)`.
  3. Validates evidence. Zero observations left → completes with no recommendation (`{ empty: true }`).
  4. In one immediate transaction:
     - inserts the recommendation (`kind: "initial"`, `content`, `observation_hash` = sha256 of the sorted `section:key:text` lines, `status: "pending"`);
     - inserts evidence rows (`source_external_ref` = `<conversation external id>:<ts>`);
     - creates an approval (`action: "records.update"`, `targetIntegration: "people"`, `targetRef: personId`, `payload: { recommendationId }`, `riskLevel: "low"`, key `people.rec:<recommendationId>`, `requestedByModule: "people"`);
     - stores `approval_id`;
     - emits `person.profile_recommendation_created`.
  5. Records an AI flag if `suspectedInjection.detected`, using the security-flags service with the first provided message id.
- **Request trigger:** `requestInitialProfile(slackUserId)`. It calls `ensurePerson`, then enqueues the job. Routes call it in Task 8.

- [ ] **Step 1: Failing tests.**
  - The history selection rules: self DM included, unrelated channel messages excluded, expired excluded, newest 150 of 400 kept.
  - Out-of-set and forged ids are removed; uncited observations dropped; low confidence dropped at `medium`.
  - Zero observations → no recommendation, no approval.
  - Happy path → one recommendation, evidence rows, a pending approval, an event.
  - Re-running the job → no duplicate.
  - An output with a `priority` key → `incomplete_ai_output`.
  - The request has only `ToolSearch`, and every message part is `untrusted`.
  - 5,000 long CJK messages → a request under the cap (e2e through the real validator).
  - E2e happy path plus invalid JSON.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun run check` → PASS.
- [ ] **Step 5: Commit** `feat(api): evidence-backed initial profile recommendations`.

### Task 5: Applying, rejecting and versioning profiles

**Files:**
- Create: `apps/api/src/modules/people/profiles.ts`
- Modify: `apps/api/src/workers/people.ts`, `apps/api/src/container.ts`
- Test: `apps/api/test/modules/people-profiles.test.ts`

**Interfaces:**
- The executor is registered via `registerIntegrationExecutor("records.update", "people", executor)`. It loads the recommendation by `payload.recommendationId`, then, in one immediate transaction:
  1. **Initial recommendation:** if no profile exists, it creates version 1. If a profile already exists, it marks the recommendation `superseded` and returns `skipped`.
  2. **Update recommendation:** if `base_version` ≠ `current_version`, it marks the recommendation `superseded` and returns `skipped` (the stale-base rule). Otherwise it applies the remove/add diff to the current content and writes version + 1.
  3. Inserts `people_profile_versions`, upserts `people_profiles` (`current_version`, `content`), and copies the evidence rows to the new `version_id`.
  4. Sets the recommendation to `applied`, with `decided_at`.
  5. Emits `person.profile_approved`.
  6. Writes an audit row `people.profile_applied`, containing ids and the version only.
- **Rejection and expiry:** consumer `people.decisions` on `approval.rejected` and `approval.expired`. For approvals with `targetIntegration` `people`, it sets the recommendation to `rejected` or `expired` and emits `person.recommendation_decided`. Nothing else changes.
- `getProfile(personId): { version, content, evidence: { observationKey, sourceExternalRef, messageAvailable: boolean, confidence }[] } | null`.
- `listVersions(personId)`.
- `getResponseGuidelines(personId): Observation[]`.

- [ ] **Step 1: Failing tests.**
  - Approve an initial recommendation → version 1, profile, evidence linked, event, audit.
  - Reject → recommendation rejected, no profile.
  - Expired → expired.
  - Two update recommendations on base 1, both approved → the first gives version 2, the second is superseded, and there is no duplicate version.
  - An update diff removes key A and adds key B → version content is correct.
  - The history keeps versions 1 and 2 intact.
  - The source message expires → `messageAvailable: false`, and the ref is kept.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun run check` → PASS.
- [ ] **Step 5: Commit** `feat(api): approved profile versions, rejection and stale-base handling`.

### Task 6: Update recommendations and unknown-contact suggestions

**Files:**
- Create: `apps/api/src/intelligence/people/{update-prompt.ts, unknown-prompt.ts}`
- Modify: `apps/api/src/workers/people.ts`, `apps/api/src/modules/people/recommendations.ts`
- Test: `apps/api/test/workers/people-update.test.ts`, `apps/api/test/workers/people-unknown.test.ts`, plus e2e cases

**Interfaces:**
- **`people.recommend_update`** is a schedule (`intervalSeconds` from `people.update.intervalSeconds`, coalesce). Each tick enqueues one job per profiled person whose newest history message is newer than the newest evidence `observed_at` of the current version, and who has no pending recommendation. The key is `people.update:<personId>:<newest ts>`.
  - The handler sends the current profile as one `user_approved` part (approved content), plus the new history items since that evidence date as `untrusted` parts (`maxMessages` applies).
  - It parses `profileUpdateOutputSchema`.
  - It validates evidence on the adds. A remove must cite at least one provided id, or it is dropped.
  - An empty diff → no recommendation.
  - It computes the observation hash of the resulting content. If it equals the hash of any rejected recommendation for that person, nothing is stored (Review Focus 2).
  - Otherwise it stores a `kind: "update"` recommendation with `base_version`, the approval and the event.
- **`people.assess_unknown`:**
  - Trigger: `person.discovered` for temporary contacts reaching `people.unknown.minMessages`. The temporary consumer enqueues it when `message_count` first reaches the threshold.
  - Batching: a bucket key `people.assess:<hourBucket>`, which assesses up to 10 unassessed temporary contacts.
  - Request: one `untrusted` part per contact, with up to 5 of their recent messages each.
  - Output: parses `unknownAssessmentOutputSchema`. Ids outside the batch → `incomplete_ai_output`.
  - Writes `profile_assessment` and `assessed_at`.
  - For `worthProfile: true`, it ensures a `people` row and stores a `kind: "suggest_evaluation"` recommendation (no content, `reason` capped through `renderExcerpt`, no approval). Accepting it from the UI calls `requestInitialProfile`.
  - Priority is never set.

- [ ] **Step 1: Failing tests.**
  - No new messages → no job.
  - New messages → a diff recommendation with `base_version`.
  - A remove without valid evidence is dropped.
  - A rejected-identical result is not stored again.
  - A pending recommendation blocks a new update job.
  - Unknown: a threshold crossing enqueues once; `worthProfile` true → suggestion with no approval; false → only the assessment stored.
  - An out-of-batch id → rejection.
  - E2e for the update path.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun run check` → PASS.
- [ ] **Step 5: Commit** `feat(api): profile update proposals and unknown-contact suggestions`.

### Task 7: Response guidelines in reply drafts

**Files:**
- Modify: `apps/api/src/intelligence/urgency/suggest-prompt.ts`, `apps/api/src/workers/urgency.ts`
- Test: `apps/api/test/workers/urgency-suggest.test.ts`, plus one e2e case

**Interfaces:**
- When the target message's sender has an approved profile, `buildSuggestRequest` gets `guidelines: Observation[]`, from `getResponseGuidelines` for the sender's person.
- They go in one `user_approved` part (`source: "approved response guidelines for <name>"`), placed before the untrusted messages, and they count in the byte budget.
- With no profile, the request is unchanged.

- [ ] **Step 1: Failing tests.**
  - A sender with a profile → the request has exactly one `user_approved` part containing the guideline texts.
  - Without a profile → no such part.
  - The e2e request passes the real validator.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun run check` → PASS.
- [ ] **Step 5: Commit** `feat(api): approved response guidelines shape reply drafts`.

### Task 8: Routes and dashboard

**Files:**
- Modify: `apps/api/src/routes/people.ts`, `apps/web/app/page.tsx`, `apps/web/lib/api.ts`
- Create: `apps/web/app/components/{PeopleCandidates.tsx, PersonProfile.tsx, ProfileRecommendations.tsx}`
- Test: `apps/api/test/routes-phase5.test.ts`, `apps/web/test/components.test.tsx`, `apps/web/test/api.test.ts`

**Interfaces:**
- `GET /api/people/candidates?limit=1..100` → `{ identityRequired: boolean, candidates: ContactCandidate[] }`.
- `POST /api/people/:slackUserId/evaluate` → 202 `{ queued: boolean, reason?: string }`. It calls `requestInitialProfile`. A pending recommendation → `queued: false`, with a reason.
- `GET /api/people/:slackUserId/profile` → `PersonDetail`: identity, priority, profile (version, sections, evidence with `messageAvailable` and the permalink when available), versions list, temporary-contact info, and flag history count.
- `GET /api/people/recommendations?status=pending` → `RecommendationView[]`: person, kind, base version, proposed content or diff, evidence per observation with `messageAvailable`, `approvalId`, and the reason for suggestions.
- `POST /api/people/recommendations/:id/accept-suggestion`: for `suggest_evaluation` only. It calls `requestInitialProfile` and marks the suggestion `applied`.
- Approve and reject use the existing `/api/approvals/:id/approve|reject` routes. The web calls them with the recommendation's `approvalId`.
- **Web:**
  - `PeopleCandidates`: a ranked list with an **Evaluate** button. It shows the identity-required notice when needed.
  - `ProfileRecommendations`:
    - For an initial recommendation, each section's observations with confidence and expandable evidence (permalink, or "original message no longer available locally").
    - For an update recommendation, a diff showing added and removed observations.
    - **Approve** and **Reject** buttons, with a reason field on reject.
    - Suggestions, with **Evaluate**.
  - `PersonProfile`: opened from people lists. It shows the current version, the version list, and priority (reusing the existing controls).
  - Refresh on `person.*` events and `approval.*` events, through the existing debounced refresh.

- [ ] **Step 1: Failing tests.**
  - Routes:
    - candidates when identity is null;
    - evaluate enqueues once, then `queued:false`;
    - the profile shape with an expired evidence message;
    - recommendations list;
    - accept-suggestion only for `suggest_evaluation` (otherwise 409);
    - id validation.
  - Components:
    - the recommendation diff renders the added and removed observations;
    - the expired evidence text;
    - the Approve button calls the approval endpoint.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, `bun run check` and `bun run --cwd apps/web build` → PASS.
- [ ] **Step 5: Commit** `feat(api,web): people candidates, profile review and person page`.

### Task 9: G5, smoke script and docs

**Files:**
- Modify:
  - `apps/api/src/modules/security-flags/{rules.ts, service.ts}`
  - `docs/modules/{people-memory.md, security-flags.md, urgency-engine.md}`, `CLAUDE.md`
  - `docs/superpowers/plans/2026-11-05-phase-4-followups.md`
- Create: `scripts/dev/people-smoke.ts`, `scripts/dev/test/people-smoke.test.ts`
- Test: `apps/api/test/modules/security-flags.test.ts`

**Interfaces:**
- **G5:** `rules.ts` exports `STARTER_RULES_VERSION` (currently 1). `init()` inserts the starter set as that version if it is absent, and makes it active when it is higher than the active version. A user-created custom version higher than the starter version stays active. Add a doc note: bump `STARTER_RULES_VERSION` with every `STARTER_RULES` change.
- **`scripts/dev/people-smoke.ts [--pages N]`** (1..3, default 1). It reuses the `urgency-smoke.ts` setup: temp DB, Noop desktop notifier, signal cleanup, counts only. It:
  1. collects pages;
  2. drains the outbox;
  3. requires `--self <Uxxxx>` or uses the identity suggestion (if neither, prints `identity: none` and exits 0 after the collection counts);
  4. ranks candidates;
  5. runs `people.generate_initial_profile` once, for the top candidate, with model `haiku` to save quota.
  
  It prints:
  - messages and candidates;
  - history items;
  - observations per section;
  - observations dropped;
  - evidence rows;
  - recommendation created (yes/no);
  - run status.
  
  It never prints names, ids, text or observation text. Its test covers argument parsing and that `summarize` drops content.
- **Docs:**
  - Add "Implementation notes (Phase 5)" to `people-memory.md`.
  - Update the starter-version note in `security-flags.md`.
  - Add the guidelines note to `urgency-engine.md`.
  - Add the commands to CLAUDE.md.
  - Mark G1, G2, G3 and G5 done in the Phase 4 follow-ups, and leave G4 open.

- [ ] **Step 1: Failing tests.**
  - G5: an existing v1 active plus a starter bumped to 2 → `init()` inserts v2 active. A custom v5 active stays active.
  - Smoke `summarize` and argument parsing.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test` and `bun run check` → PASS.
- [ ] **Step 5: Commit** `feat: starter rule versioning, people smoke script, phase 5 docs`.
- [ ] **Step 6 (controller only, after the final review):** run `bun scripts/dev/people-smoke.ts --pages 1` once and record the counts in the PR.

---

## Phase 5 Definition of Done

- `bun run check` passes, and no test runs real `claude`.
- The user can rank contacts, pick one to evaluate, and review an evidence-backed profile recommendation.
- On approval, version 1 is created with evidence. Rejection changes nothing, and identical rejected proposals never return.
- Daily update proposals are diffs on a base version. Stale-base approvals are superseded, never lost or duplicated.
- Unknown senders become temporary contacts that expire. Worthwhile ones are suggested for evaluation, and priority is never set by AI.
- Evidence survives message expiry as an external reference.
- Approved response guidelines shape reply drafts.
- G1, G2, G3 and G5 are closed.
- A real smoke run succeeds and prints counts only.
