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
  --permission-mode default \
  --system-prompt "<short worker-specific prompt>" \
  --allowedTools "ToolSearch,<job tools>" \
  --disallowedTools "<explicit denylist>" \
  --model <model> --max-turns <expected calls + 3> \
  --no-session-persistence --output-format stream-json --verbose < /dev/null
```

- `$OVERRIDE` is `{"enabledPlugins":{"<each plugin name from ~/.claude/settings.json>":false},"hooks":{}}`: plugin names only, read once at startup; `{"enabledPlugins":{},"hooks":{}}` if the file can't be read. Since CLI 2.1.318, `--setting-sources ""` loads no claude.ai connectors; `user` loads them, and the override drops the user's plugins and hooks (R34, 2026-11-05).
- `--setting-sources user` also keeps the working directory's project and local sources out: an inspected repository's `CLAUDE.md`, `.claude/settings.json` and `.mcp.json` are never loaded (checked in the CLI bundle, Phase 9 final review).
- `--permission-mode default` is always passed (Phase 9 final review). A CLI flag beats the user's `permissions.defaultMode`, so `auto`, `acceptEdits` or `bypassPermissions` in `~/.claude/settings.json` can't change how a run's tool calls are approved. The user-permission guard below still refuses engineering runs while such a mode is set.
- **Hermetic runs.** The provider adds `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` and `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` to every run's environment, over whatever the caller passed. Synapse's runs never need the user's auto memory or any `CLAUDE.md`, and loading them would be reading the user's interactive context (ADR-036: observed, never read).
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

- Lease `engineering` in `leases`, holder `task:<id>`, acquired at task pickup and held until the PR is merged, or the task is cancelled/rejected/failed and its cleanup has run.
- Waiting for approval does **not** release the lock. Other engineering tasks stay `queued` in priority order.
- Intelligence and collector jobs aren't blocked.
- An existing lease row always means held, even once expired. At boot (after the port is bound) recovery inspects any lease with `GitWorkflow.preflight`, fingerprints and the diff hash: a dirty tree or merge in progress sets `needs_attention` and keeps the lock; safe cases resume or re-drive a step. Details and the full table: [engineering-tasks.md](engineering-tasks.md).
- The user said simultaneous work by the user and Claude in the same checkout is not a concern. No separate clone/worktree is required.

### Git workflow: performed by Synapse, never by the model

**Principle (Phase 10).** An engineering run edits files and runs the user-confirmed test command. It is never *given* `git` or `gh` (no such tool or Bash grant), so it never commits, pushes or creates a branch itself. It can still run arbitrary code through the test command, which is repository code the run may have edited (`docs/architecture/security-model.md` §3.1). Every Git operation is Synapse code (the `GitWorkflow` and `PullRequestProvider` ports, argv, no shell, hardened runner), and each write step waits for its own approval, revalidated before it runs. The only Claude runs in a task are the read-only investigation and the one develop run; they go through this orchestrator like every other run.

The full as-built workflow (steps, approvals, SHA pinning, cleanup, recovery, reason codes) is in [engineering-tasks.md](engineering-tasks.md). Summary:

1. Plan approval confirms the parent branch (ADR-035) and the test command; a protected environment's branch is refused.
2. Preflight, then `branch` (task branch from the parent), `develop` (the one scoped run): both approved by the plan approval.
3. `commit` (approval), `update_parent` (no approval, no remote written), `merge_local` (approval), `push_pr` (approval: push of the parent to `origin`, then PR `origin/<parent>` into `upstream/<parent>`), `merge_pr` (approval, high risk).
4. Cleanup after `completed`, `cancelled` or `failed`; the lock is released at the end.

Conflicts are never auto-resolved: they are aborted and the task is `needs_attention`. Synapse never pushes to `upstream`.

### Requirement 5d: small fixes ready when the user returns

```text
bug/task reported (Slack/Jira) → engineering.task_proposed
 → automatic read-only investigation (allowed): analysis, proposed fix, plan, size estimate
 → if spec unclear: commitments drafts follow-up questions; task stays proposed
 → user approves plan + confirms branch/environment (approval scoped to task + repo + parent branch)
 → lock acquired → preflight, branch, develop on the task branch → tests
 → engineering.task_awaiting_approval: "N small issues from <people> are ready — ship?"
 → user approves commit, merge_local, push_pr and merge_pr one by one (or rejects → cancel, cleanup, lock released)
```

Approval to investigate isn't permission to modify code. Approval to modify code isn't permission to deploy.

### Untrusted content isolation (ADR-032, accepted)

Every `ClaudeJob` lists its prompt parts with a provenance:

| Provenance | Meaning | Where it may appear |
|---|---|---|
| `untrusted` | Text written by other people (Slack, Jira) | Collector and intelligence runs without write tools; wrapped in boundary markers |
| `user_approved` | Texts or plans the user approved | Any run; rendered verbatim |
| `policy_approved` | A text a deterministic policy authorised instead of the user (ADR-033 away-mode auto-replies, Phase 6b J1) | **Only** a send run (validator rule K); rendered verbatim, like `user_approved` |
| `system` | Synapse's own instructions | Any run; rendered verbatim |

Provenance is never mislabelled: a send authorised by the auto-reply policy carries `policy_approved`, never `user_approved`. The **request validator** runs before any process starts and rejects:

- any request with an `untrusted` part whose `allowedTools` includes a send/write/create/update/delete connector tool, `Bash`, `Edit`, `Write` or `NotebookEdit`
- any `engineering` request with an `untrusted` part
- any request without an explicit `--disallowedTools` denylist covering every claude.ai connector tool it doesn't need (including Gmail, Drive and other non-Slack/Jira connectors)
- any send request with more than one allowed tool (the arguments the model actually uses are checked after the run against the tool_use input; see integration-contracts.md)
- any `policy_approved` part outside a send run (rule K, `policy_approved content outside a send run`); with an `untrusted` part in a send run it already fails rule D
- any send run without a `sendGuard` whose `toolName` is its write tool (rule K, `send run without a matching send guard`; J2)

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
- **Filesystem readers (R33/I4).** `Read`, `Grep` and `Glob` are engineering-only, and since Phase 9 engineering must path-scope them (rule L, below); collector and intelligence runs may not allow them and always deny them. Prompts are capped at 100 KiB (UTF-8) and may not start with `-`.
- **Best-effort bookkeeping and uncertain sends (R33/I3).** After the provider returns, the run-row update, quota storage, connector learning, auth record and completion events each run best-effort (one content-free log line on failure) and never change the outcome; a failed run-row update is retried with the status alone. When a run allows a connector write tool and the process spawned, any failure carries `details.uncertain = true` (including the `auth_paused` that replaces an `auth_failed` when the pause was already set, R4), and the worker parks an external-write job with such a failure (or a timeout) in `NEEDS_ATTENTION`.
- **Max turns (Phase 4 R16).** A result with subtype `error_max_turns` is classified as `provider_error` ("claude reached max turns") with `details.maxTurns = true`, whatever `is_error` or the exit code say. Classification keeps that boolean (alongside `uncertain`), and the run row still stores `permission_denials`, so callers can raise runtime security flags for failed runs.
- **Calling from a job (R33/I6).** `run(req, signal)` and `runStructured(req, schema, signal)` require the job's `AbortSignal`. A request waiting for a slot is removed from the queue when the signal aborts and fails with `timeout` ("cancelled while waiting for a Claude slot") without a run row. The quota gate is checked again after the slot is acquired. **Handler timeout rule:** a job handler that calls the orchestrator must register `timeoutMs` ≥ orchestrator timeout for its profile + kill grace (5 s) + 1 s + the expected wait for a Claude slot; otherwise the worker times the job out while the run is still being recorded.
- **Smoke script.** `bun scripts/dev/claude-smoke.ts [--no-tools|--deny-check]` runs one real request on a temp DB and prints only ids, statuses and counts. `--deny-check` prints PASS only if the `claude.ai Gmail` connector is `connected` at init and no `mcp__claude_ai_Gmail` tool is listed (R34); FAIL if any Gmail tool is listed; otherwise INCONCLUSIVE (connector not connected at init). It exits non-zero on FAIL or when the run did not succeed.

### Path-scoped engineering reads and the user-permission guard (Phase 9)

- **Rule L (path scoping).** Every `engineering` run's `workingDirectory` must pass `isSafeAbsolutePath` (absolute, characters from `[A-Za-z0-9._/-]`, no empty, `.` or `..` segment, at least two segments), whether or not it allows a filesystem read. Every allowed `Read`, `Grep` or `Glob` must carry a specifier and equal `Tool(/<workingDirectory>/**)` exactly, that is the CLI's double-slash absolute form, for example `Read(//home/u/app/**)`. A bare `Read`, a different directory, the single-slash form `Read(/home/u/app/**)`, a dot segment or a shallow path such as `/tmp` fails the request with a fixed reason (`fs read tools must be scoped to the working directory`, or `working directory must be an absolute path of safe characters`). This retires I4 for engineering: the repository inspection (`brain.inspect_repository`) is the first user. Phase 10 extends the rule to the write tools (below). The collector and intelligence profiles still may not allow these tools at all.
  - **Amendment (final review).** The rule first required the single-slash form `Tool(<workingDirectory>/**)`. In Claude Code permission rules a single leading `/` is not an absolute path (for `--allowedTools` it resolved against the cwd); only `//` names an absolute path. The controller verified this on the real CLI with the cwd in a third temp dir: `Read(/abs/inside/**)` denied the inside read (it granted nothing), and `Read(//abs/inside/**)` allowed the inside read and denied the outside one. The earlier pre-check and smoke had passed only because the cwd was the scoped directory, and the CLI allows reads under the cwd by default.
- **Engineering denylist.** `buildDenylist` denies every write built-in (`Bash`, `Edit`, `Write`, `NotebookEdit`, `MultiEdit`, `Monitor`) and every filesystem read built-in (`Read`, `Grep`, `Glob`) that a run does not allow, for every profile (the allowed ones are filtered out). Before Phase 9 an engineering run denied none of them, which meant a user-level `permissions.allow` entry could widen a read-only run. Validator rule H2 requires the same of engineering requests: each write and filesystem-read built-in it does not allow must be in the denylist (final review).
- **User-permission guard.** The CLI merges the user's `permissions.allow` and `additionalDirectories` into every run (`--setting-sources user`), and the `--settings` override cannot remove them, so a user-level `Read`, `Bash` or `Edit` allow would defeat rule L's scope. At startup `readUserSettings` derives one boolean, `userPermissionsWidenScope`: true when `permissions.allow` has an entry for `Read`, `Grep`, `Glob`, `Bash`, `Edit`, `Write`, `NotebookEdit` or `MultiEdit` (bare or with a specifier), when `additionalDirectories` is non-empty, or when `defaultMode` is `bypassPermissions`, `acceptEdits` or `auto`. No entry is kept, returned or logged, and an unreadable or malformed file means false. It also keeps the connector server names (`mcp__<server>`, nothing else) of `permissions.allow` entries that start with `mcp__`. When the flag is true the orchestrator refuses every `engineering` and `reader` run after validation and **before spawning**, and it refuses a `reader` run in the same way while any of those servers is not in `orchestrator.knownServers` (a reader denies every known server and ToolSearch, but an unknown server would stay allowed): it audits `claude.request_rejected` with reason `unsafe_user_settings` and throws a `needs_attention` `JobError` with the fixed message "Claude Code user settings widen file or shell permissions; engineering and code-answer runs are refused until they are removed and the API is restarted" and `details.notSpawned`. As with the plugin override, the settings are read once at startup, so the user edits `~/.claude/settings.json` and restarts the API. Collector and intelligence runs are unaffected.
- **Proof on the real CLI.** `scripts/dev/scope-smoke.ts` runs at provider level (`ClaudeCliProvider.execute`, the one script the provider-boundary test excepts, by its exact path) with the cwd in a third temp dir, so the CLI's default "reads under the cwd are allowed" can't help. Case `double` allows `Read(//<tmp>/inside/**)` and reads a file inside, then one outside: it passes with `inside=ok outside=blocked`. Case `single(control)` allows the single-slash `Read(/<tmp>/inside/**)` and reads the same inside file: it passes with `inside=denied`, which proves the rule, not the cwd, granted the first read. Output is `double: inside=… outside=…`, `single(control): inside=…` and `scope-smoke: blocked|LEAKED|inconclusive`; content returned by either case it must not see is `LEAKED` (exit 1). Results are recorded in the Phase 9 follow-ups.

### Rule L for writes and the single Bash grant, and the engineering denylist (Phase 10)

- **Write tools.** In an `engineering` run each allowed `Edit`, `Write` or `MultiEdit` must equal `Tool(/<workingDirectory>/**)` exactly, the same double-slash absolute form as the reads (`Edit(//home/u/app/**)`). A bare tool, another directory or another specifier fails with `write tools must be scoped to the working directory`. `NotebookEdit` and `Monitor` are never allowed in an engineering run.
- **Bash.** Only as exactly `Bash(<cmd>:*)` where `<cmd>` passes `isSafeTestCommand` (E5: safe characters, a runner from the allowlist in its test form only, as amended at the final review: `bun|npm|pnpm|yarn test` or `run test[:…]`, `npx vitest|jest|mocha|playwright|ava`, `pytest`, `python -m pytest|unittest`, `uv run pytest`, `make test*|check*`, `go|cargo|deno test`; `-c`, `-e`, `--eval`, `exec`, `x`, `dlx`, `pip`, `install`, `add` refused). At most one Bash grant per run (`only one Bash grant is allowed`). Request-validator rule 0 admits spaces in a specifier only inside this one form (`BASH_PREFIX_RE`); chained commands (`;`, `&`, `|`, `$(`) cannot even be written into the grant. A bare `Bash`, or a specifier without the `:*` prefix form such as `Bash(git status)`, fails. The CLI's prefix match was verified on the real CLI (2026-11-06): with `Bash(bun test:*)`, `bun test` ran and `ls`, `bun test && …`, `bun test; …` and `bun test $(…)` were denied.
- **Denylist.** Every run's `--disallowedTools` is built by `buildDenylist`: the network built-ins (`WebFetch`, `WebSearch`, `Agent`, `Task`) always; every write built-in (`Bash`, `Edit`, `Write`, `NotebookEdit`, `MultiEdit`, `Monitor`) and every filesystem-read built-in (`Read`, `Grep`, `Glob`) the run does not allow; every known connector server not used. Validator rule H2 requires it, so the develop run, which allows `Edit`, `Write`, `MultiEdit`, `Read`, `Grep`, `Glob` and one `Bash`, still denies `NotebookEdit`, `Monitor` and everything networked, and an investigation run denies every write tool.
- **Provenance.** The develop run carries only `system` and `user_approved` parts (rule E rejects any untrusted part in an engineering run).
- **Git by Synapse.** There is no `git` or `gh` grant anywhere in a run: `Bash(git status:*)` and the like fail rule L because `git` is not in the test-runner allowlist, and a bare `Bash` fails too.
- Request builders: `buildInvestigateRequest` (`intelligence/engineering/investigate-prompt.ts`) and `buildDevelopRequest` (`develop-prompt.ts`). Both pass `workingDirectory` = the registered realpath and `expectedToolNames` (ADR-026). The step worker (`workers/engineering/steps.ts`) is the only caller for develop; it makes one attempt.

### Send runs (Phase 6)

An approved Slack send is one orchestrator run built by `buildSendRequest` (`integrations/slack/sender.ts`). It is the only run allowed to carry a connector write tool.

- **Shape.** Profile `collector`, `priorityClass: "send"`, model haiku, `maxTurns: 3`, `allowedTools: ["mcp__claude_ai_Slack__slack_send_message", "ToolSearch"]`. Parts: one `system` part (call the tool once with exactly the given JSON arguments, call nothing else) and one approved part (the JSON of `{channel_id, message, thread_ts?}`): `user_approved` by default, `policy_approved` when `SendMessageCommand.authorisedBy` is `"policy"` (Phase 6b J1). No untrusted parts, no `expectedToolNames`: the caller classifies the raw tool results itself, because the provider would otherwise turn a refused or failed send into an opaque failure.
- **Validator.** Rule F: a request that allows a connector write tool may allow only that tool and `ToolSearch`. Rule I: such a request with an `untrusted` part is rejected. Rule K: a `policy_approved` part is allowed only in such a request, and such a request must carry a `sendGuard` for its write tool. The denylist rules apply as for any run, so every other connector tool and the network and filesystem built-ins are denied.
- **Quota.** The `send` class is blocked only at the `stop` level; at `soft` and `hard` an approved send still runs (and a send waiting for a slot is not swept as stranded). It runs inside the `approval.execute` job (priority 180), whose timeout is max(120 s, collector timeout + 90 s). The job's abort signal reaches the orchestrator: an abort before the process spawns throws and is the safe "not started" outcome.
- **Send guard (Phase 6b J2, prevention).** Every send request carries `sendGuard: { toolName, expectedInputSha256 }`, the sha256 of the canonical JSON of the exact arguments (`integrations/claude-code/send-guard-canonical.ts`: object keys sorted at every depth, undefined keys dropped, arrays in order). The orchestrator passes it to `AIExecutionRequest` (the request schema accepts only a word-character tool name and 64 lowercase hex). `ClaudeCliProvider` then builds a **per-run** `--settings` override: the base override (plugins disabled, R34) with `hooks` replaced by one `PreToolUse` hook, matcher = the tool name, command `'<bun>' '<abs>/send-guard-hook.ts' '<sha>' '<toolName>' || exit 2` (every element single-quoted, timeout 10 s). Claude Code runs the hook with the tool-call JSON on stdin. The hook checks that `tool_name` is `<toolName>`, canonicalises `tool_input` and exits 0 on a match. Otherwise it exits 2 with `send arguments differ from the approved message` on stderr, which blocks the call before anything is posted. Malformed stdin or a bad sha also exits 2, and `|| exit 2` turns a hook that cannot start (exit 127) or crashes into a block rather than Claude Code's non-blocking error. **Parity with the argument check:** before hashing, both the expected arguments and the observed `tool_input` go through `normaliseSendInput`: `unfurl_app_links` is dropped when it is exactly `false`, and `message` is `trimEnd`ed. Everything else is kept. The guard therefore accepts exactly what `matchesCommand` accepts: an unknown key, `unfurl_app_links: true`, leading whitespace or a changed channel or thread is blocked. A table-driven test in `slack-sender.test.ts` keeps the two in step. The hook script is standalone (it imports only the canonicaliser, which imports only `node:crypto`), because Claude Code runs it directly. If the guarded override cannot be built, the provider returns a `provider_error` marked `notSpawned` without starting `claude`. Runs without a guard keep the unchanged override.
- **Cancel before spawn (Phase 6b).** `run(req, signal, opts)` accepts `opts.beforeSpawn`, called after the Claude slot is acquired and the quota is re-checked, just before the process starts. If it returns anything but `true`, or throws, the run fails with `JobError` kind `cancelled_before_spawn` and `details.notSpawned`; no process starts and no run row is written for a spawn. `OutgoingService` uses it for policy sends so that ending away mode cancels everything not yet spawned; see `docs/modules/auto-reply.md`. `SlackSender.send` takes it through `SendOptions` and rethrows the cancel (nothing was sent).
- **Rule K and the guard requirement.** Rule K has two parts: a `policy_approved` part is allowed only in a send run, and any run that allows a connector write tool must carry a `sendGuard` whose `toolName` is that tool (`send run without a matching send guard`). A guard that cannot be built (bad sha or tool name) returns `provider_error` with `notSpawned`. The per-run override also forces `disableAllHooks: false`. Real-CLI proof: `scripts/dev/hook-smoke.ts`, 2026-11-06 (wrong hash blocked, `--allow` allowed).
- **Arguments are checked by code (second layer).** `RawToolResult.input` (the `tool_use` input paired by `tool_use_id`) must equal the approved arguments; a different channel, thread or text (model error or injection through the approved text) is an `argument_mismatch`: the message is never reported as sent, and a `high` runtime flag and a notification are raised.
- **Uncertain outcomes are never retried.** Because the run allows a connector write tool, any failure after the process spawned (timeout, crash, an auth pause that replaced the failure) carries `details.uncertain = true`, including the replacement `auth_paused` error (R4). `SlackSender` turns that into an `uncertain` result instead of rethrowing, so the queue never retries a send; a failure before spawn (quota, auth, validation) is rethrown and nothing was sent. The tool's own error text only classifies definitive Slack rejections and is never stored.
- **No H1 leakage.** Approved People Memory guidelines are used only by drafting runs (intelligence profile, no send tool). A send run's only approved content (`user_approved` or `policy_approved`) is the exact message that was approved.
- **Tests.** The send guard is covered by `apps/api/test/integrations/send-guard.test.ts` (canonical form, override shape, and the hook script spawned directly and through `sh -c`). The sender is covered by `apps/api/test/integrations/slack-sender.test.ts`, and through the real provider with the fake binary by `apps/api/test/integration/slack-send-e2e.test.ts`, plus the validator tests; nothing in the suite runs real `claude` or sends.

## Open questions

- OQ-3 resolved: push the parent branch to `origin`; PR from `origin/<parent>` into `upstream/<parent>` (ADR-030).
- **OQ-4:** whether the Claude Code refresh-token expiry slides on refresh.
- OQ-5 resolved by ADR-036: interactive sessions are observed (metadata only), never read or controlled.

See `docs/product/open-questions.md`.
