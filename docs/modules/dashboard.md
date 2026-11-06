# Dashboard module

Read-only aggregates for the web dashboard. No writes, no AI, no external calls. The web page that uses them is described in `web-dashboard.md`. Code: `apps/api/src/modules/dashboard/`, route `apps/api/src/routes/dashboard.ts`, contract `packages/contracts/src/dashboard.ts`.

## Endpoints

- `GET /api/dashboard/overview` returns `DashboardOverview`: `generatedAt` (the clock), `self` (confirmed Slack id and display name, or nulls), `counts`, `lastSlackSyncAt`, `health`, `pipeline`, and `engineeringLock` (`{held, taskId?, taskTitle?, since?}`, Phase 10); `counts.engineeringAwaiting` is the number of engineering tasks in `awaiting_approval` or `needs_attention`.
- `GET /api/claude/status` additionally returns `thresholds` (`fiveHour: {soft, hard, stop}`, `sevenDay: {soft, hard}`), in the units the settings store. It is present even when `quota` is `null`.

Every count starts from the same service method as its list endpoint and applies the Needs-you feed's rules (`apps/web/lib/needs-you.ts`), so each count matches the cards the feed shows. Where the feed drops rows a list returns, the count drops them too:

| Count | Source |
|---|---|
| urgent | `UrgentInbox.listUrgent({status: "open"})` |
| approvals | `ApprovalEngine.listPending()`, minus approvals whose id is the `approvalId` of a pending profile recommendation (those are decided on the recommendation card) |
| outgoingAttention | `outgoing_messages` rows with status `needs_attention` |
| redFlags | sum of `openCount` over `SecurityFlagsService.listGroupedByPerson` (open flags, not groups) |
| commitmentsToReview | `CommitmentLifecycle.listViews("review")` rows with `reviewStatus` `pending_review` (the rows whose actions include `accept`; the review filter also returns rejected rows) |
| followupDrafts | `FollowupService.listViews("draft")` |
| profileRecommendations | `PeopleViews.listRecommendations("pending")` |
| peopleToEvaluate | `PeopleViews.candidates(50).candidates` (the endpoint's default limit) with the `evaluate` action; 0 while `identityRequired` |
| conversations | distinct `conversation_id` among stored `slack_messages` |

## Pipeline rules (`pipeline.ts`, pure `pipelineStages(input, now)`)

Stages are always `collect`, `screen`, `assess`, `surface`, labelled Collect, Screen, Assess, Surface.

- **collect.** `failing` when the `slack.messages` sync state has an error or has stalled. `waiting` when the last success is older than 25 min, or there is none. `ok` otherwise. Summary: "<n> min ago · <k> searches today" ("not collected yet · <k> searches today" with no success).
- **screen.** `failing` when the `screening-rules` or `security-rules` health check is not ok, otherwise `ok`. Summary: "<n> red flags open".
- **assess.** `failing` when an `urgency.assess` job is FAILED or NEEDS_ATTENTION and finished (or was created) in the last 24 h. `waiting` when one is PENDING with `runAfter` <= now, RUNNING, or in RETRY (backing off before its next attempt, whatever its `runAfter`). `ok` otherwise. Summary: "<n> waiting", or "up to date" (when failing with nothing waiting: "<n> failed in the last 24 h").
- **surface.** `ok` when there are open urgent items or pending approvals (the `approvals` count above), otherwise `idle`. Summary: "<u> urgent · <a> approvals".

## Health hints (`health-hints.ts`)

`HEALTH_LABELS` and `HEALTH_HINTS` are static maps keyed by check name. `health.issues` lists only checks that are not ok, each with its label and hint (`null` when the check has no hint).
