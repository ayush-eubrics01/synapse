# Dashboard module

Read-only aggregates for the web dashboard, plus (Phase 11) the user's saved dashboard layouts. The aggregates make no writes; the layouts are the only thing this module writes (its own `dashboard_layouts` table). No AI, no external calls. The web page that uses them is described in `web-dashboard.md`. Code: `apps/api/src/modules/dashboard/`, route `apps/api/src/routes/dashboard.ts`, contract `packages/contracts/src/dashboard.ts`.

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

## Layouts (Phase 11, ADR-023)

The page's sections are the widgets. The user's arrangement is stored in `dashboard_layouts` (migration 0021: `id`, `name`, `is_active`, `layout` json, `created_at`, `updated_at`; unique on `lower(name)`; a partial unique index allows one active row). Code: `modules/dashboard/layout.ts` (pure), `modules/dashboard/layouts.ts` (`DashboardLayoutService`), route `routes/dashboard-layouts.ts`, contract `packages/contracts/src/dashboard-layout.ts`.

### Endpoints

| Endpoint | Result |
|---|---|
| `GET /api/dashboard/layouts` | `{ active: DashboardLayoutView, layouts: [{id, name, isActive, updatedAt}] }` |
| `POST /api/dashboard/layouts {name, fromId?}` | 201, the new layout, copied from `fromId` or the active one |
| `PUT /api/dashboard/layouts/:id {name?, layout?}` | the stored (normalised) layout; at least one field is required |
| `POST /api/dashboard/layouts/:id/activate` | the same body as `GET /api/dashboard/layouts` |
| `POST /api/dashboard/layouts/:id/reset` | the layout replaced by the default, name kept |
| `DELETE /api/dashboard/layouts/:id` | 204 |

Error bodies are `{ "error": "<code>" }`, nothing else. 400 `invalid_name` (name not 1-40 characters after trimming, or a malformed create body), 400 `invalid_layout` (a PUT with neither field, or a layout that fails the request schema), 404 `not_found`, 409 `name_taken` (names are unique ignoring case), 409 `limit_reached` (at most 10 layouts), 409 `active_layout` (deleting the active one), 409 `last_layout` (deleting the only one; checked first).

### `normaliseLayout(input)`

Pure, backend only. The shape is `{ version: 1, sections: [{ id, visible, collapsed, width: "full" | "half" }] }`; ids come from `DASHBOARD_SECTION_IDS` (every section except `overview`, which is always first and always shown).

- Input that fails the request schema (corrupt or hand-edited stored rows included) becomes the default layout.
- Unknown ids are dropped; a duplicate keeps its first occurrence.
- Missing ids are appended with their defaults, in registry order, so a section added later appears for a user with an older stored layout.
- `triage` (Needs you) is forced `visible: true` and `collapsed: false`. A request that tries otherwise is normalised, not refused, so a pending approval can never be hidden.

The stored `layout` column is read as raw text, so unparseable JSON cannot throw: it is normalised to the default on read.

### Default seeding and `list()`

The default layout is the Phase 7 order: `triage` and `running` half width, everything else full width. `list()` runs in one immediate transaction. With no rows it creates "Default" and makes it active. With rows but none active (for example the active row was deleted by hand) it re-activates the most recently updated one and audits that. Both audit as actor `system`.

### Audit and events

Every write is audited as `dashboard.layout_created`, `_updated`, `_activated`, `_reset` or `_deleted` (module `dashboard`, details `{ layoutId }` only, never names or layout content), in the same transaction as the change. The same transaction publishes `dashboard.layout_changed {layoutId}` (aggregate `dashboard_layout`). The event has no consumer today; the web refetches on its own SSE refresh.
