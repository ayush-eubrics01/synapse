# Claude Orchestrator

Covers `apps/api/src/core/orchestrator`, its relationship to the `claude-code/cli` adapter (`AIProvider`), and engineering task execution together with the `engineering-tasks` module.

## Purpose

The single path to Claude Code. Every Claude run (collection, intelligence, engineering) goes through the orchestrator, which controls what runs, when, with which tools, within what quota, and records what happened. Claude Code is an execution provider. It is never the database, the scheduler or the source of truth.

## Responsibilities / Non-responsibilities

Responsibilities:

- Accept `ClaudeJob` requests from modules and adapters; queue them by priority.
- Apply the invocation profile and per-profile tool scoping.
- Enforce concurrency limits, the quota gate, budgets, timeouts and cancellation.
- Parse `stream-json` via the `AIProvider` and return only raw tool results as trusted data (ADR-026).
- Log every run (`claude_runs`) and quota observation (`quota_snapshots`).
- Execute engineering tasks under the global engineering lock and Git workflow.
- Report Claude provider health and Claude Code auth expiry.

Non-responsibilities:

- Domain decisions (modules decide what to do with results).
- Persisting domain data (owning modules persist after validation).
- Approvals (the `ApprovalEngine` decides; the orchestrator checks and executes).

## Owned data (tables)

`claude_runs`, `quota_snapshots`, `leases` (row `engineering`), plus the `jobs` rows it executes. The `engineering-tasks` module owns `engineering_tasks` and `engineering_task_steps`. The orchestrator writes `claude_run_id` references into them.

## Worker profiles (ADR-031; isolation rules per ADR-032)

| Profile | Used for | Tools | Default model | Untrusted input? |
|---|---|---|---|---|
| `collector` | Slack/Jira collection; approved or ADR-033 single sends/writes as separate narrow runs | collection: `ToolSearch` + read-only connector tools; send/write runs: exactly one tool with arguments fixed by code and no untrusted text | haiku | collection yields it (doesn't interpret it); send runs: none |
| `intelligence` | screening follow-up, urgency, commitments, profiles, knowledge, drafting, Jira analysis | `ToolSearch` + read-only connector tools if needed; no write/send tools; no Bash/Edit/Write | haiku (sonnet for heavier analysis) | yes |
| `engineering` | repository investigation, bug analysis, plans, approved code changes, tests, Git steps | read-only by default; Edit/Write/Bash only in an approved step, scoped to the registered repo; **no Slack/Jira/other connector tools** | sonnet/opus (configurable) | no: only approved task descriptions (ADR-032) |

## Invocation profile (concept §10.2.1, validated in Phase 0)

```bash
claude -p "<prompt naming exact tools and arguments>" \
  --setting-sources user --settings "$OVERRIDE" --disable-slash-commands \
  --system-prompt "<short worker-specific prompt>" \
  --allowedTools "ToolSearch,<job tools>" \
  --disallowedTools "<explicit denylist>" \
  --model <model> --max-turns <expected calls + 3> \
  --no-session-persistence --output-format stream-json --verbose < /dev/null
```

- `$OVERRIDE` is `{"enabledPlugins":{"<each plugin name from ~/.claude/settings.json>":false},"hooks":{}}`: plugin names only, read once at startup; `{"enabledPlugins":{},"hooks":{}}` if the file can't be read. Since CLI 2.1.318, `--setting-sources ""` loads no claude.ai connectors; `user` loads them, and the override drops the user's plugins and hooks (R34, 2026-11-05).
- `--bare` can't be used (API key only; connectors need claude.ai OAuth).
- Never `--tools` (it hides MCP tools). Restrict via allow/deny lists.
- `ToolSearch` is always allowed when connector tools are needed (they are deferred).
- The denylist always includes connector write/send tools the job doesn't need, and `Bash, Edit, Write, NotebookEdit, WebFetch, WebSearch, Agent` for non-engineering profiles.
- The process runs in the systemd service environment with an explicit PATH. Engineering runs use the registered repo as working directory; others use a scratch directory.

## Raw tool results are the only trusted data (ADR-026)

- `RawToolResult`s are built only from `user` → `tool_result` events, matched to `tool_use` by `tool_use_id`.
- `finalText` is returned for logging and drafting, never stored as source data.
- If `expectedToolNames` is set and none produced a non-error tool_result, the run is `failed` with `incomplete_ai_output`. Phase 0 showed Haiku fabricating tool calls and data as text when tools were missing. The failed result carries no tool results, so callers that need error results (Slack collection, R57) leave `expectedToolNames` unset and check for real tool results themselves.
- Intelligence output (structured JSON in the final text) is validated against the task's Zod schema. Failing validation → `incomplete_ai_output`.

## Scheduling, priorities, concurrency

Queue priority (highest first): urgent assessment → approved sends/writes → incremental collection → engineering steps → batch intelligence → backfill/discovery.

| Limit | Default |
|---|---|
| Max concurrent Claude processes (total) | 2 |
| Max concurrent collector runs | 1 per integration |
| Engineering runs | 1 (global engineering lock) |
| Default timeout: collector / intelligence / engineering | 3 min / 5 min / 30 min |

Jobs are claimed with a lease (`jobs.lease_owner`, `lease_expires_at`) so two workers can't claim the same job.

## Quota gate (ADR-029)

After every run, the `rate_limit_event` → `QuotaSnapshot` → `quota_snapshots`.

| Five-hour utilization | Behaviour |
|---|---|
| < `soft` (default 0.60) | everything runs |
| ≥ `soft` | pause backfill, discovery and batch intelligence |
| ≥ `hard` (default 0.85) | only urgent assessment, approved sends and incremental collection |
| `status: rejected` or ≥ `stop` (0.95) | nothing starts; jobs deferred to `resetsAt`; `quota.threshold_reached` |

Seven-day utilization has its own thresholds (defaults 0.70 / 0.90). The thresholds exist to keep headroom for the user's interactive Claude Code work. `cost_usd_equivalent` is tracked for relative cost only. It is not the subscription quota.

## Timeouts and cancellation

The process is spawned in its own process group. On timeout or user cancellation, send SIGTERM to the group, then SIGKILL after a grace period. Record status `timed_out` / `cancelled`. For runs that may have caused external side effects (sends, writes, Git push/merge), the owning module verifies the external state before any retry.

## Auth health (concept §16.2.1)

`HealthService` reads only `claudeAiOauth.expiresAt` and `refreshTokenExpiresAt` from `~/.claude/.credentials.json`, never the tokens. It emits `auth.expiry_warning` when the refresh expiry is < 48 h. `auth_failed` errors → `NEEDS_ATTENTION`, not retried. Whether the refresh expiry slides is OQ-4.

## Engineering task execution

Owned jointly: `engineering-tasks` holds the task state machine; the orchestrator runs its steps.

### Global engineering lock (ADR-030)

- Lease `engineering` in `leases`, acquired at task pickup and held until the PR is merged, or the task is cancelled/rejected/failed and the local branch is cleaned up.
- Waiting for approval does **not** release the lock. Other engineering tasks stay `PENDING` in priority order.
- Intelligence and collector jobs aren't blocked.
- On restart with an expired lease: if the repo has uncommitted changes or a merge in progress (`RepositoryProvider.getStatus`), the task becomes `NEEDS_ATTENTION` and the lock isn't auto-released.
- The user said simultaneous work by the user and Claude in the same checkout is not a concern. No separate clone/worktree is required.

### Git workflow (concept §10.6), one `engineering_task_steps` row per step

| # | Step | Approval |
|---|---|---|
| 0a | **Branch confirmation** (ADR-035): show repo, suggested environment, parent branch (from environment, else `tracked_branch`), task branch name, PR `origin/<parent>` → `upstream/<parent>`. The user confirms or changes it, optionally "remember as tracked branch" | part of the plan approval |
| 0b | Preflight: clean tree, `origin` + `upstream` exist, confirmed parent branch exists on both | — (fail → `NEEDS_ATTENTION`) |
| 1 | Create a local task branch from the parent branch | code modification approval (approved plan) |
| 2 | Develop and test on the task branch | covered by the plan approval; commit needs approval |
| 3 | `git pull origin <parent> && git pull upstream <parent>` | — (conflict → `NEEDS_ATTENTION`) |
| 4 | Merge the task branch locally into the parent branch | approval (conflict → `NEEDS_ATTENTION`) |
| 5 | Push the local parent branch to `origin`, then open a PR from `origin/<parent>` into `upstream/<parent>` | approval (push + PR) |
| 6 | Merge the PR | approval |

Conflicts are never auto-resolved without approval. The task records branch names, commits, PR link and final status.

### Requirement 5d: small fixes ready when the user returns

```text
bug/task reported (Slack/Jira) → engineering.task_proposed
 → automatic read-only investigation (allowed): analysis, proposed fix, plan, size estimate
 → if spec unclear: commitments drafts follow-up questions; task stays proposed
 → user approves plan + confirms branch/environment (approval scoped to task + repo + parent branch)
 → lock acquired → steps 0b–2 on the task branch → tests
 → engineering.task_awaiting_approval: "N small issues from <people> are ready — ship?"
 → user approves steps 4–6 one by one (or rejects → cleanup, lock released)
```

Approval to investigate isn't permission to modify code. Approval to modify code isn't permission to deploy.

### Untrusted content isolation (ADR-032, accepted)

Every `ClaudeJob` lists its prompt parts with a provenance: `untrusted` (Slack/Jira text), `user_approved` (texts or plans the user approved) or `system`. The **request validator** runs before any process starts and rejects:

- any request with an `untrusted` part whose `allowedTools` includes a send/write/create/update/delete connector tool, `Bash`, `Edit`, `Write` or `NotebookEdit`
- any `engineering` request with an `untrusted` part
- any request without an explicit `--disallowedTools` denylist covering every claude.ai connector tool it doesn't need (including Gmail, Drive and other non-Slack/Jira connectors)
- any send request with more than one allowed tool, or with arguments not fixed by application code

The engineering worker receives only the user-approved task description and repository context. Untrusted parts are wrapped in delimited blocks with a per-run random boundary and labeled as data. After every run that contained untrusted content, `permission_denials` and unexpected tool calls are passed to `security-flags` (ADR-034). The tool catalog classifies each known tool as read or write; unknown tools are treated as write.

## Interactive session observation (ADR-036)

Owned by the `claude-activity` module; the orchestrator consumes its "user active" signal.

- Every 120 s, parse `~/.claude/projects/*/<sessionId>.jsonl` incrementally (by file offset), only for sessions whose `cwd` is inside a registered repository.
- Read only: `sessionId`, `cwd`, `gitBranch`, timestamps, `ai-title`, `pr-link` (`prUrl`, `prNumber`, `prRepository`), `version`, `entrypoint`. Never message content, tool data, thinking or attachments.
- **Yield:** if any session was active within 10 min, the quota gate behaves as if at the `soft` level: only urgent assessment, incremental collection and approved/auto-reply sends run. Heavy analysis and engineering steps wait.
- **Activity widget:** sessions per repo (title, branch, last active, active now), plus PRs opened from sessions, linked to projects, engineering tasks and Jira where branch or PR matches.
- **Work-in-progress reminders (to the user only):** a branch with session activity but no PR after 3 days; a session PR still open after 3 days.
- Never resumes, writes to, or injects into a user session. The format is undocumented: unknown line types are skipped; if nothing parses, observation is disabled with a health warning.

## Events

Emitted: `claude.job_created`, `claude.job_started`, `claude.job_completed`, `claude.job_failed`, `quota.threshold_reached`, `auth.expiry_warning` (via health), `engineering.task_started`, `engineering.task_awaiting_approval`, `engineering.task_completed`, `engineering.task_failed`.

Consumed: `approval.approved` / `rejected` / `expired` (engineering steps), `settings.changed`.

## Failure handling

| ErrorKind | Behaviour |
|---|---|
| `transient_network`, `provider_error`, `timeout`, `incomplete_ai_output` | retry with exponential backoff, max 3 attempts → `NEEDS_ATTENTION` |
| `connector_not_ready`, `rate_limited` | retry after delay |
| `quota_exhausted` | defer to `resetsAt`; doesn't consume an attempt |
| `auth_failed`, `permission_denied`, `parse_failed` | `NEEDS_ATTENTION`, no retry |
| `invalid_input` | fail, no retry |

Claude process crash → attempt recorded with error, retried per policy. Restart → interrupted `RUNNING` jobs with expired leases are recovered from checkpoints.

## Configuration

| Key | Default |
|---|---|
| `orchestrator.maxConcurrent` | `2` |
| `orchestrator.quota.fiveHour.soft/hard/stop` | `0.60 / 0.85 / 0.95` |
| `orchestrator.quota.sevenDay.soft/hard` | `0.70 / 0.90` |
| `orchestrator.timeouts.collector/intelligence/engineering` | `180s / 300s / 1800s` |
| `orchestrator.models.collector/intelligence/engineering` | `haiku / haiku / sonnet` |
| `orchestrator.claudeBinary` | `~/.local/bin/claude` |
| `orchestrator.pinnedClaudeVersion` | `2.1.318` (contract-tested) |

Threshold and timeout defaults are proposals to tune with real usage.

## Tests

- Claude process crash mid-run → retried, attempt history kept.
- Success text but no tool_result → `incomplete_ai_output`.
- Invalid structured output → retry, then `NEEDS_ATTENTION`.
- Quota above threshold → non-urgent jobs deferred; urgent still run below `stop`.
- Timeout → process group killed, status `timed_out`.
- Two workers claim the same job → one wins (lease).
- Second engineering task while one is active → stays `PENDING`.
- Merge conflict at step 3 or 4 → `NEEDS_ATTENTION`.
- Restart mid-merge with lock held → `NEEDS_ATTENTION`, lock retained.
- Engineering run invoked with Slack text in its prompt → rejected by the request validator.
- Request with an `untrusted` part plus `slack_send_message` (or Bash/Edit/Write) → rejected.
- Request missing the connector denylist → rejected.
- Run with untrusted content and a non-empty `permission_denials` → runtime flag passed to security-flags.
- Branch confirmation: changing the branch updates the plan; "remember" updates `tracked_branch` and audits it; a nonexistent branch fails preflight.
- Push never targets `upstream`.
- Interactive session active within the window → non-urgent jobs deferred; idle → resumed.
- Session file with unknown line types → skipped without error; message content is never stored (assert on synthetic fixtures).
- Session in an unregistered folder → ignored.
- Refresh token < 48 h → `auth.expiry_warning`.
- stream-json parser fixtures: init (pending/connected), tool_use/tool_result pairing, rate_limit_event, result.

## Implementation notes (Phase 2)

- **Per-claim owner token (G1).** A job claim stores a unique owner token (worker id plus a fresh id per claim), so a reaper requeue followed by a re-claim from the same worker id cannot let the stale run complete or release the job.
- **Narrowed `AIProvider`.** The interface is `execute` and `getHealth` only; `getCapabilities()` is deferred until a consumer needs it. `AIExecutionResult` also carries `availableTools` (tool names from the `system/init` event, never content).
- **`knownServers` learning.** The orchestrator learns connector names from the init event's `mcp_servers` and adds them to the known-server set used for the server-level denylist. Names are validated before being learned, so a hostile or malformed name cannot inject a denylist entry or tool pattern.
- **Strict tool-name grammar (R26/R27).** Allowed and expected tool names must match the strict grammar (built-ins, or `mcp__<server>__<tool>` with normalized segments); anything else is rejected before spawning.
- **Per-window quota status (R30).** The quota gate evaluates the five-hour and seven-day windows separately from the `rate_limit_event`; a `rejected` status on either window blocks runs until that window's `resetsAt`.
- **Quota fail-closed (R33/I1).** Each `rate_limit_event` window is kept independently; a missing, non-positive or out-of-range `resetsAt` is treated as absent (never 1970). A `rejected` window whose `resetsAt` is missing or already past still stops work until `observedAt + 1h`; stale `allowed` windows are ignored. Every `quota_exhausted` `retryAfter` is `max(resetsAt, now + 15 min)`. An error result whose text mentions a usage limit, rate limit or quota is classified `quota_exhausted` even without an event.
- **Filesystem readers (R33/I4).** `Read`, `Grep` and `Glob` are engineering-only until Phase 8 adds path scoping; collector and intelligence runs may not allow them and always deny them. Prompts are capped at 100 KiB (UTF-8) and may not start with `-`.
- **Best-effort bookkeeping and uncertain sends (R33/I3).** After the provider returns, the run-row update, quota storage, connector learning, auth record and completion events each run best-effort (one content-free log line on failure) and never change the outcome; a failed run-row update is retried with the status alone. When a run allows a connector write tool and the process spawned, any failure carries `details.uncertain = true` (including the `auth_paused` that replaces an `auth_failed` when the pause was already set, R4), and the worker parks an external-write job with such a failure (or a timeout) in `NEEDS_ATTENTION`.
- **Max turns (Phase 4 R16).** A result with subtype `error_max_turns` is classified as `provider_error` ("claude reached max turns") with `details.maxTurns = true`, whatever `is_error` or the exit code say. Classification keeps that boolean (alongside `uncertain`), and the run row still stores `permission_denials`, so callers can raise runtime security flags for failed runs.
- **Calling from a job (R33/I6).** `run(req, signal)` and `runStructured(req, schema, signal)` require the job's `AbortSignal`. A request waiting for a slot is removed from the queue when the signal aborts and fails with `timeout` ("cancelled while waiting for a Claude slot") without a run row. The quota gate is checked again after the slot is acquired. **Handler timeout rule:** a job handler that calls the orchestrator must register `timeoutMs` ≥ orchestrator timeout for its profile + kill grace (5 s) + 1 s + the expected wait for a Claude slot; otherwise the worker times the job out while the run is still being recorded.
- **Smoke script.** `bun scripts/dev/claude-smoke.ts [--no-tools|--deny-check]` runs one real request on a temp DB and prints only ids, statuses and counts. `--deny-check` prints PASS only if the `claude.ai Gmail` connector is `connected` at init and no `mcp__claude_ai_Gmail` tool is listed (R34); FAIL if any Gmail tool is listed; otherwise INCONCLUSIVE (connector not connected at init). It exits non-zero on FAIL or when the run did not succeed.

### Send runs (Phase 6)

An approved Slack send is one orchestrator run built by `buildSendRequest` (`integrations/slack/sender.ts`). It is the only run allowed to carry a connector write tool.

- **Shape.** Profile `collector`, `priorityClass: "send"`, model haiku, `maxTurns: 3`, `allowedTools: ["mcp__claude_ai_Slack__slack_send_message", "ToolSearch"]`. Parts: one `system` part (call the tool once with exactly the given JSON arguments, call nothing else) and one `user_approved` part (the JSON of `{channel_id, message, thread_ts?}`). No untrusted parts, no `expectedToolNames`: the caller classifies the raw tool results itself, because the provider would otherwise turn a refused or failed send into an opaque failure.
- **Validator.** Rule F: a request that allows a connector write tool may allow only that tool and `ToolSearch`. Rule I: such a request with an `untrusted` part is rejected. The denylist rules apply as for any run, so every other connector tool and the network and filesystem built-ins are denied.
- **Quota.** The `send` class is blocked only at the `stop` level; at `soft` and `hard` an approved send still runs (and a send waiting for a slot is not swept as stranded). It runs inside the `approval.execute` job (priority 180), whose timeout is max(120 s, collector timeout + 90 s). The job's abort signal reaches the orchestrator: an abort before the process spawns throws and is the safe "not started" outcome.
- **Arguments are checked by code.** `RawToolResult.input` (the `tool_use` input paired by `tool_use_id`) must equal the approved arguments; a different channel, thread or text (model error or injection through the approved text) is an `argument_mismatch`: the message is never reported as sent, and a `high` runtime flag and a notification are raised.
- **Uncertain outcomes are never retried.** Because the run allows a connector write tool, any failure after the process spawned (timeout, crash, an auth pause that replaced the failure) carries `details.uncertain = true`, including the replacement `auth_paused` error (R4). `SlackSender` turns that into an `uncertain` result instead of rethrowing, so the queue never retries a send; a failure before spawn (quota, auth, validation) is rethrown and nothing was sent. The tool's own error text only classifies definitive Slack rejections and is never stored.
- **No H1 leakage.** Approved People Memory guidelines are used only by drafting runs (intelligence profile, no send tool). A send run's only `user_approved` content is the exact message the user approved.
- **Tests.** The sender is covered by `apps/api/test/integrations/slack-sender.test.ts`, and through the real provider with the fake binary by `apps/api/test/integration/slack-send-e2e.test.ts`, plus the validator tests; nothing in the suite runs real `claude` or sends.

## Open questions

- OQ-3 resolved: push the parent branch to `origin`; PR from `origin/<parent>` into `upstream/<parent>` (ADR-030).
- **OQ-4:** whether the Claude Code refresh-token expiry slides on refresh.
- OQ-5 resolved by ADR-036: interactive sessions are observed (metadata only), never read or controlled.

See `docs/product/open-questions.md`.
