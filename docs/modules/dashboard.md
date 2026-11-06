# Dashboard module

Read-only aggregates for the web dashboard. No writes, no AI, no external calls. Code: `apps/api/src/modules/dashboard/`, route `apps/api/src/routes/dashboard.ts`, contract `packages/contracts/src/dashboard.ts`.

## Endpoints

- `GET /api/dashboard/overview` returns `DashboardOverview`: `generatedAt` (the clock), `self` (confirmed Slack id and display name, or nulls), `counts`, `lastSlackSyncAt`, `health`, `pipeline`, and `engineeringLock` (always `null` until Phase 10).
- `GET /api/claude/status` additionally returns `thresholds` (`fiveHour: {soft, hard, stop}`, `sevenDay: {soft, hard}`), in the units the settings store. It is present even when `quota` is `null`.

Every count is computed with the same service method as its list endpoint, so the numbers always match the lists:

| Count | Source |
|---|---|
| urgent | `UrgentInbox.listUrgent({status: "open"})` |
| approvals | `ApprovalEngine.listPending()` |
| outgoingAttention | `outgoing_messages` rows with status `needs_attention` |
| redFlags | sum of `openCount` over `SecurityFlagsService.listGroupedByPerson` (open flags, not groups) |
| commitmentsToReview | `CommitmentLifecycle.listViews("review")` |
| followupDrafts | `FollowupService.listViews("draft")` |
| profileRecommendations | `PeopleViews.listRecommendations("pending")` |
| peopleToEvaluate | `PeopleViews.candidates(50).candidates` (the endpoint's default limit) |
| conversations | distinct `conversation_id` among stored `slack_messages` |

## Pipeline rules (`pipeline.ts`, pure `pipelineStages(input, now)`)

Stages are always `collect`, `screen`, `assess`, `surface`, labelled Collect, Screen, Assess, Surface.

- **collect.** `failing` when the `slack.messages` sync state has an error or has stalled. `waiting` when the last success is older than 25 min, or there is none. `ok` otherwise. Summary: "<n> min ago · <k> searches today" ("not collected yet · <k> searches today" with no success).
- **screen.** `failing` when the `screening-rules` or `security-rules` health check is not ok, otherwise `ok`. Summary: "<n> red flags open".
- **assess.** `failing` when an `urgency.assess` job is FAILED or NEEDS_ATTENTION and finished (or was created) in the last 24 h. `waiting` when one is PENDING with `runAfter` <= now, or RUNNING. `ok` otherwise. Summary: "<n> waiting", or "up to date" (when failing with nothing waiting: "<n> failed in the last 24 h").
- **surface.** `ok` when there are open urgent items or pending approvals, otherwise `idle`. Summary: "<u> urgent · <a> approvals".

## Health hints (`health-hints.ts`)

`HEALTH_LABELS` and `HEALTH_HINTS` are static maps keyed by check name. `health.issues` lists only checks that are not ok, each with its label and hint (`null` when the check has no hint).
