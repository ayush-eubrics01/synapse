# Jira Tracking

Covers the `jira-tracking` domain module (`apps/api/src/modules/jira-tracking`), the `jira/claude-connector` adapter (`apps/api/src/integrations/jira`), the workers (`apps/api/src/workers/jira`), the routes (`apps/api/src/routes/jira.ts`) and the web section. Design spec: `docs/superpowers/specs/2026-11-06-phase-8-jira.md` (decisions B1 to B14). Deferred work: `docs/superpowers/plans/2026-11-06-phase-8-followups.md`.

## Purpose

Keep a local, incrementally synced, **read-only** view of the Jira issues assigned to the user in a rolling window, so assigned work doesn't go unmonitored. Detect overdue, blocked, due-soon and neglected issues with deterministic rules, and show which Slack messages mention each issue. Jira stays authoritative; Synapse never changes it (Phase 8 has no Jira write path).

## Scope the user chose

Only issues assigned to the user in their chosen project, never another named project, within a 2-month window. The real project keys live only in the local settings DB (`jira.scope.jql`, `jira.excludedProjects`), never in the repo. The repo default is generic: `assignee = currentUser() AND updated >= -60d`.

## Connector facts (probed 2026-11-06, no content kept)

- `mcp__claude_ai_Atlassian__getAccessibleAtlassianResources` returns `[{ id (cloudId UUID), url, name, scopes[], avatarUrl }]`.
- `mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql({ cloudId, jql, fields[], maxResults, nextPageToken? })` returns `{ issues: { totalCount?, nodes: [{ id, key, webUrl, fields }], pageInfo: { hasNextPage, endCursor } } }`. The next page passes `nextPageToken = pageInfo.endCursor`. `totalCount` appears only with `searchResultMode: "all"|"count"`, which Synapse never requests, so `searchPage().total` is always `null`.
- Fields requested: `summary, status, priority, issuetype, project, labels, duedate, created, updated` (the `JIRA_FIELDS` constant in `packages/contracts/src/jira.ts`). `duedate` is not returned unless asked for. No `description`, no comments.
- `created` / `updated` arrive with a colon-less numeric offset (`+0530`); the parser converts them to UTC ISO instants and rejects a value with no offset (never falls back to local time).
- A page of 50 is about 120 KB of tool_result text; a page of 20 is about 49 KB (measured).
- Claude Code replaces an MCP result over about 25k tokens with an `Error: result (N characters) exceeds maximum allowed tokens... saved to file` notice. Raising `MAX_MCP_OUTPUT_TOKENS` only moves the failure to a second limit of roughly 100 KB, where the result becomes a `<persisted-output>` block. Neither notice holds the data. **That is why pages are 20 issues** (`jira.pageSize` default 20, maximum 30): well under both limits with the fixed field list. The adapter maps either notice to `output_too_large` (see "Failure handling").
- The connector adds `responseContentFormat: "markdown"`, `actionSource: "model_tool_call"` (and for search `searchResultMode: "issues"`) to every call. The adapter tolerates exactly those keys with exactly those values and nothing else (`connector-source.ts`).

## Decisions as implemented

| # | As built |
|---|---|
| B1 | Settings (all in `core/config/settings.ts`): `jira.enabled` false; `jira.cloudId` null (regex `^[0-9a-fA-F-]{8,64}$`); `jira.scope.jql` (`jiraScopeJqlSchema` in `packages/contracts/src/jira.ts`: max 500 chars, no newlines, no `ORDER BY`, balanced parentheses and closed double-quoted strings); `jira.excludedProjects` `[]` (keys `^[A-Z][A-Z0-9_]+$`); `jira.sync.intervalMinutes` 30; `jira.reconcile.hours` 24; `jira.windowDays` 60; `jira.stale.days` 5; `jira.dueSoon.days` 2; `jira.blockedStatuses` `[]`; `jira.pageSize` 20 (1..30, see "Connector facts"); `jira.maxPagesPerRun` 6; `jira.maxPagesPerChain` 50 (1..500) |
| B2 | Fields are a code constant (above). Less untrusted text, smaller pages |
| B3 | One page per collector run: profile `collector`, class `collection`, model haiku, `allowedTools = [<the tool>, "ToolSearch"]`, `maxTurns: 4`. The instructions carry the exact JSON args. The adapter takes the single `tool_result` for that tool and requires: exactly one result, not an error, and `tool_use` input equal to the requested args (`fields` compared as a set; only the tolerated extras may be added). Otherwise `incomplete_ai_output`. The CLI's oversized-output notice (for a call with the right arguments) is `output_too_large`. Output that doesn't parse is `parse_failed` with a fixed message |
| B4 | `jira.resolve_cloud_id` runs while enabled with no cloudId. Exactly one site is stored in the `jira.cloudId` setting and a sync is queued, plus a coalesced reconcile while the incremental checkpoint is still null. Zero or several: the job parks as `needs_attention` with the reason `no_sites` / `multiple_sites`, shown as `lastError` in the status. The user then sets `jira.cloudId` by hand (there is no route for it; see "Doc and code differences" below) |
| B5 | Incremental sync, see "JQL shapes" and "Generations and checkpoint" |
| B6 | Reconcile, see "Reconcile completeness" |
| B7 | Exclusions in two layers, see below |
| B8 | One table `jira_issues` (unique `key`; indexes on `(in_scope, status_category)` and `jira_updated_at`). An upsert writes only when data changed. An issue whose key is unknown but whose `jira_id` is stored (a project move) updates that row's key: no second row. `webUrl` is kept only when it starts with `https://`; otherwise the parser gives `null`, the store writes `''` (the column is NOT NULL and no migration was added) and reads anything that isn't `https://` back as `null`. `jira.issue_updated {key}` is published for a new issue, or a change to status name or category, priority, due date, summary or `in_scope`. An older read (`updatedAt` below the stored value) never overwrites newer data |
| B9 | Attention rules, see below |
| B10 | Slack mentions, see below |
| B11 | Routes, see below |
| B12 | Dashboard: `counts.jiraAttention` (0 while `jira.enabled` is false); web section "Jira" between Commitments and People with Needs attention / In progress / To do / Done recently, each row linking "Open in Jira ↗" only when `webUrl` is present; a Needs-you card tagged "JIRA · ATTENTION" titled "N Jira issues need attention" (first 5, then "+N more" and "See all in Jira →"), fed from `GET /api/jira/issues?view=attention` in the backend's order with no client-side filtering; a setup card tagged "JIRA · SETUP" titled "Track your Jira issues" while disabled, prefilled with the stored scope and exclusions from the status |
| B13 | Summaries are untrusted (ADR-032): rendered as plain text, never logged, never in events, audit rows, notifications or stored errors (errors carry a kind and a fixed message) |
| B14 | `scripts/dev/jira-smoke.ts`, see "Smoke" |

## JQL shapes

Built only in `modules/jira-tracking/jql.ts`. `S` is `(<scope>)`, plus ` AND project not in (A, B)` when projects are excluded.

- Incremental: `S AND updated >= -<m>m ORDER BY updated ASC`, with `m = ceil(minutes since checkpoint) + 5`, floored at 1 and capped at `windowDays * 1440`. With no checkpoint (or an unparseable one) `m` is the full window. Relative minutes avoid JQL time-zone ambiguity; the 5-minute overlap absorbs clock skew and the unique key absorbs the duplicates.
- Reconcile: `S ORDER BY updated ASC`.
- The scope setting may not contain `ORDER BY` (the code appends its own) or a newline, and its parentheses must balance outside double-quoted strings, with every string closed. Otherwise a scope such as `a) OR (b`, or an open quote, could escape the `(<scope>)` wrapping and swallow the project exclusion. The web setup form checks the same rules first.

## Generations and checkpoint

Stream state lives in `integration_sync_states` (streams `jira.issues` and `jira.reconcile`: checkpoint, generation, status, last success, last error).

- A fresh sync run opens a new `generation` (status `running`), computes the JQL once and runs pages sequentially, up to `maxPagesPerRun`. If more pages remain it enqueues a continuation job (idempotency key `<type>:<generation>:<pagesSoFar>`) whose input carries the exact JQL, cloudId, `nextPageToken`, `pagesSoFar`, max `updated` seen and totals. A continuation whose generation is no longer current is skipped as `superseded`.
- Before storing each page, `runPages` checks the generation. Once it is superseded it stops: that page and later ones are not stored and nothing is committed.
- **Bounded chains.** A page whose `nextPageToken` equals the token that produced it fails as `parse_failed` (that page isn't stored). A chain that would need more than `jira.maxPagesPerChain` pages (default 50, so 1,000 issues at 20 a page) fails as `parse_failed` after its last allowed page. Both record `lastError`, change no checkpoint or scope flag, and aren't resumed, so a connector that never ends its pages can't run Claude without bound.
- **Resume from the last good page.** If a page fails after at least one page of the same run was stored, and the failure is retryable or a pause, the run records the failure (`lastError`, status `error`, `collection.failed`; pauses record nothing) and enqueues a continuation from the last good token in the same generation, with `runAfter = retryAfter` when the error has one. The job itself completes with `{resumed: true, kind}`. A first-page failure, or a needs-attention failure (`parse_failed`, `output_too_large`, auth), is rethrown to the queue as before.
- Status: `running` while a fresh chain is open, `error` after a recorded failure, `idle` after a complete chain. (The fix brief said "ok"; the shared `SyncStatus` enum has no `ok`, and `idle` is the value the Slack streams already use for a healthy stream.)
- The **checkpoint is the max `updated` seen, stored as an ISO instant, and is committed only after the last page, and only if the generation is still current.** It never moves back (`maxIso` with the stored value). A failed page commits nothing; pages already stored stay (upserts are idempotent).
- Changing the scope JQL or the excluded projects in settings sets the checkpoint to null and starts new generations for both streams, so a running chain is superseded and the next sync takes the full window. The forced reconcile it queues first cancels any fresh reconcile still waiting (PENDING or RETRY with null input; it hasn't started), so repeated edits leave one waiting run. Continuations are left alone: their generation check supersedes them.
- Intervals and the page budget are read at startup; a change applies after an API restart. Schedules are coalesced.

## Reconcile completeness

`jira.reconcile` (every `reconcile.hours`) runs the full scope JQL across all pages as a continuation chain that carries the keys seen. Pages are stored with `setScope: false`, so they change no existing flag. **Only when the last page completes under the current generation** does `markScope` run: seen keys go `in_scope = true`; unseen keys go `in_scope = false`. A failed or superseded reconcile changes no flag. One guard beyond the spec: an unseen issue whose `last_seen_at` is at or after the reconcile's start (an incremental sync saw it meanwhile) keeps its flag. It catches reassignment away and window expiry without false removals.

## Exclusions in both layers

1. JQL: `withExclusions` appends `AND project not in (...)` to every query. It throws on a key that doesn't match `^[A-Z][A-Z0-9_]+$`.
2. Store: `upsertPage` drops any parsed issue whose project key is excluded (counted as `rejected`, never stored). When the user adds an exclusion, `dropExcluded` takes stored issues of that project out of scope in the same transaction as the settings write.

So "never track that project" holds even if the scope JQL is edited carelessly.

## Attention rules

Pure `attentionOf(issue, now, settings)` in `attention.ts`. Only in-scope issues that aren't done (`statusCategory != done`) get a value; the first match wins:

1. `overdue`: due date is before today (local calendar date, in the API's zone).
2. `blocked`: status name equals one of `jira.blockedStatuses` (case-insensitive), or matches `/block/i`, or a label matches `/^blocked$/i`.
3. `due_soon`: due date is on or before today plus `dueSoon.days`.
4. `stale`: not updated for `stale.days` or more (instants).
5. otherwise `null`.

`attention_since` records when it became non-null. Attention is recomputed on upsert, on scope changes, by `refreshAttention` at the end of every complete sync and reconcile, and by the hourly `jira.refresh_attention` job (no Claude, coalesced, skipped while disabled), so time-driven changes (due soon, overdue, stale) land within the hour even between syncs. `jira.issue_attention {key, attention}` is published when attention changes to a non-null value.

## Slack mentions

Computed at read time, no table. An issue's mentions are stored Slack messages whose text contains the key as a whole, case-sensitive token (`\bKEY\b`; a SQL `LIKE` prefilters, the regex decides). The view carries `slackMentions: { count, latest[20] }`, each entry `{ messageId, conversationLabel, sentAt, permalink }`: no message text. Labels use the shared participant label; permalinks pass `safePermalink`.

## Routes

- `GET /api/jira/status` returns `{ enabled, cloudIdSet, lastSyncAt, lastReconcileAt, issueCount, lastError, scopeJql, excludedProjects }`. `lastError` is a kind, or the fixed reason `multiple_sites` / `no_sites`. The web shows fixed hints for three values: `multiple_sites` "Several Jira sites are available — set jira.cloudId in settings", `no_sites` "No Jira site is available to this Claude account", `output_too_large` "Jira page too large — lower jira.pageSize". Any other kind is shown as it is. `scopeJql` and `excludedProjects` are the stored settings, used to prefill the setup card.
- `GET /api/jira/issues?view=attention|open|done|all` (default `all`): in-scope only. `done` is done within the window (`jira.windowDays`). Sorted by `updated` descending; the `attention` view by severity (overdue, blocked, due_soon, stale), then due date.
- `GET /api/jira/issues/:key`: 404 `{error}` when unknown.
- `POST /api/jira/sync`: queues a sync (or the cloudId lookup when none is set); returns an already-live job instead of a second one; 409 when disabled.
- `PUT /api/jira/settings` accepts a strict partial of `{ enabled, scopeJql, excludedProjects }` (`scopeJql` uses the same `jiraScopeJqlSchema` as the setting). Turning Jira on queues the cloudId lookup, or a sync plus a coalesced reconcile while the checkpoint is null. Scope/exclusion changes: see "Generations and checkpoint", plus a fresh reconcile is queued.
- The overview gains `counts.jiraAttention`: 0 while Jira is disabled.

## Events

Emitted: `jira.issue_updated {key}` (for a project move, under the new key), `jira.issue_attention {key, attention}` (also from `jira.refresh_attention`), `collection.completed` / `collection.failed` (aggregate `integration`, id `jira.issues` or `jira.reconcile`; payload has counts and kinds only). Consumed: none by the module itself; the web's live-event hook refreshes the Jira views.

## Failure handling

| Situation | Handling |
|---|---|
| No matching tool_result, error result, wrong arguments, several results | `incomplete_ai_output`, retried; checkpoint unchanged |
| Output shape drift or bad timestamp | `parse_failed`, recorded on the stream with a fixed message |
| The CLI replaced the result with an oversized-output notice (content starts with `Error: result (` and contains `exceeds maximum allowed tokens`, or starts with `<persisted-output>`; checked after the argument match) | `output_too_large` (retry decision `needs_attention`: parked, never retried into a loop), fixed message "jira tool output too large". The web says "Jira page too large — lower jira.pageSize" |
| A page repeats its own `nextPageToken`, or the chain passes `jira.maxPagesPerChain` | `parse_failed`, recorded; nothing committed; not resumed |
| Rate limit (error result matching `ratelimit`, `rate limit` or `429`) | `rate_limited` via the shared `integrations/rate-limit.ts` helper (also used by Slack): `retryAfter` is the next UTC midnight for a "daily" limit, else the `retry-after` seconds (capped at a day), else 60 s. `rate_limited` is a **retry**, not a pause: it is recorded as `lastError` (`collection.failed` too) and the job retries at `retryAfter`, counting toward its attempts, so repeated limits end in `NEEDS_ATTENTION`. After a stored page in the same run it resumes from the last good token instead (the continuation waits until `retryAfter`) |
| Auth failure, quota | Pauses (`defer` decisions): not recorded as failures (R53) |
| Any recorded failure | `lastError = {kind, "jira sync failed" or "jira reconcile failed"}`, status `error`, plus `collection.failed`; the checkpoint and scope flags are untouched; the job retries per the queue's rules, or resumes (see "Generations and checkpoint"). A complete chain clears `lastError` and sets status `idle` |
| Zero or several sites | `needs_attention` with `no_sites` / `multiple_sites` |
| Jira disabled / no cloudId | The handlers return `skipped`; a schedule never runs Claude for a disabled integration |
| Invalid continuation input | `invalid_input` |

## Smoke

`bun scripts/dev/jira-smoke.ts [--cloud-id ID] [--jql JQL]` uses a temp DB: it resolves the sites (errors unless there is exactly one, or `--cloud-id` is given), reads one page of up to 20 issues for `--jql` or the default scope, and prints counts only: `sites`, `issues`, `hasNextPage`, `statusCategory: new= indeterminate= done=`, `projects` (distinct count). Never keys, summaries, site names, cloudIds or JQL. The pure `summarize` helper is unit-tested. Real result: see the follow-ups file.

## Deferred

Writes through approval, Jira-sourced commitments, `jira.analyze` (AI), comments and descriptions, multi-site, inbox chips for issue keys, a count-only list view, Engineering Brain links, offering issues as engineering-task candidates. See `docs/superpowers/plans/2026-11-06-phase-8-followups.md`.

## Doc and code differences

Written down so the next reader doesn't hunt for them:

- The pre-Phase-8 draft of this file named tables `jira_projects`, `jira_issue_comments`, `jira_issue_links`, `jira_sync_history`, a `jira.backfill` job, `jira.analyze`, `jira.write`, `slack_message_references` links and `jira.issue_blocked`. None exist. There is one table (`jira_issues`), four jobs (`jira.resolve_cloud_id`, `jira.sync_incremental`, `jira.reconcile`, `jira.refresh_attention`), and `jira.issue_attention` replaces `jira.issue_blocked`. The cloudId is the `jira.cloudId` setting, not `integrations.config`.
- No route sets `jira.cloudId`; the spec's "set by hand" means the settings store.
- `PUT /api/jira/settings` also rejects an `ORDER BY` in the scope, unbalanced parentheses and an unclosed double-quoted string (the spec lists only length and newlines). The same rules are in the settings schema (one shared `jiraScopeJqlSchema`).
- The spec's settings (B1) say `jira.pageSize` 50, `jira.maxPagesPerRun` 4 and `jira.sync.intervalMinutes` 15. As built: 20 (max 30, because of the CLI's ~100 KB replacement limit), 6, and 30. `jira.maxPagesPerChain` (50) and the hourly `jira.refresh_attention` job aren't in the spec.
- The spec says `webUrl` is a string. As built it is `string | null` (https only).
- The spec's B12 card names ("JIRA · NEEDS ATTENTION", "Connect Jira") differ from what shipped ("JIRA · ATTENTION", "JIRA · SETUP" / "Track your Jira issues").
- `markScope` keeps the flag of an unseen issue that an incremental sync saw after the reconcile began (not in the spec).
- The spec's smoke output list (issues, pages, statusCategory) differs from the task's (sites, issues, hasNextPage, statusCategory, projects). The task's list is what is built; a single page means `pages` would always be 1.
- `searchPage().total` exists in the port but is always `null`.
