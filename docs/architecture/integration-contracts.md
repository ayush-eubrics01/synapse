# Integration Contracts

All integrations implement stable ports defined in `packages/contracts`. Domain modules depend on these ports, never on adapters. The TypeScript below is the design contract. The final Zod schemas live in `packages/contracts` and must stay in sync with this document.

Conventions:

- All timestamps are ISO-8601 UTC strings inside the app. Source timestamps (Slack `ts`, Jira `updated`) are also kept verbatim.
- External IDs are always kept separately from internal UUIDs.
- Every adapter method can throw an `IntegrationError` with a classified `kind` (see Error model).

## 1. AI provider (`AIProvider`)

Used **only** by `core/orchestrator`.

```typescript
type WorkerProfile = 'collector' | 'intelligence' | 'engineering';
type PriorityClass = 'urgent' | 'send' | 'collection' | 'engineering' | 'batch' | 'backfill';

// Narrowed in Phase 2: getCapabilities() is deferred until a consumer needs it.
interface AIProvider {
  execute(request: AIExecutionRequest, signal: AbortSignal): Promise<AIExecutionResult>;
  getHealth(): Promise<{ status: HealthStatus; detail?: string; version?: string }>;
}

// What modules submit to the orchestrator; it fills runId, model, timeouts, disallowedTools, etc.
interface ClaudeJobRequest {
  jobId?: string;
  workerProfile: WorkerProfile;
  priorityClass: PriorityClass;
  instructions: string;
  parts?: PromptPart[];
  systemPrompt?: string;
  allowedTools: string[];          // non-empty
  expectedToolNames?: string[];
  maxTurns: number;                // 1..50
  model?: string;
  timeoutMs?: number;
  workingDirectory?: string;
  sendGuard?: SendGuard;           // J2; toolName word characters, sha 64 lowercase hex
}

interface SendGuard {              // J2: per-run PreToolUse hook on toolName
  toolName: string;
  expectedInputSha256: string;     // sha256 of the canonical JSON of the normalised tool_input (drops unfurl_app_links:false, trimEnds message)
}

interface AIExecutionRequest {
  runId: string;                 // internal UUID, one per attempt
  jobId: string | null;
  workerProfile: WorkerProfile;
  model: 'haiku' | 'sonnet' | 'opus' | string;
  systemPrompt: string;
  prompt: string;                // must name exact tool names and arguments
  promptParts: PromptPart[];     // provenance of every input (ADR-032); validated before the run
  allowedTools: string[];        // always includes 'ToolSearch' when MCP tools are needed
  disallowedTools: string[];
  maxTurns: number;
  timeoutMs: number;
  workingDirectory: string;      // registered repo path for engineering; scratch dir otherwise
  expectedToolNames?: string[];  // run fails if none of these produced a real tool_result
  sendGuard?: SendGuard;         // passed through from the job request
}

interface PromptPart {
  provenance: 'untrusted' | 'user_approved' | 'policy_approved' | 'system'; // policy_approved: send runs only (rule K)
  source?: string;               // e.g. slack:<channel>:<ts>, jira:<key>
  content: string;
}

interface AIExecutionResult {
  status: 'succeeded' | 'failed' | 'timed_out' | 'cancelled';
  toolResults: RawToolResult[];  // the ONLY trusted data from a run
  finalText: string;             // model reply; never stored as source data
  numTurns: number;
  durationMs: number;
  usage: AIUsage;
  quota?: QuotaSnapshot;         // from rate_limit_event
  permissionDenials: string[];
  connectors: ConnectorStatus[]; // from the system/init event
  availableTools: string[];      // tool NAMES from the system/init event (default []); never content
  exitCode: number | null;       // null when killed or never started
  error?: ClassifiedError;
}

interface ConnectorStatus {
  name: string;
  status: string;
}

interface RawToolResult {
  toolUseId: string;
  toolName: string;              // e.g. mcp__claude_ai_Slack__slack_search_public_and_private
  input: unknown;
  isError: boolean;
  content: string;               // concatenated text content, unparsed
}

interface AIUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  costUsdEquivalent: number;     // total_cost_usd; API-equivalent, NOT subscription quota
}

interface QuotaSnapshot {
  observedAt: string;
  fiveHour: QuotaWindow;
  sevenDay: QuotaWindow;
}

interface QuotaWindow {
  utilization: number;           // 0..1
  status: 'allowed' | 'allowed_warning' | 'rejected' | string;
  resetsAt: string;
}
```

### Claude Code CLI adapter rules (`integrations/claude-code/cli`)

- Builds the command from the invocation profile in `CLAUDE.md` / ADR-026 to ADR-029.
- Reads `stream-json` line by line. Maps `system/init` → connector status, `assistant` tool_use → pending calls, `user` tool_result → `RawToolResult` (matched by `tool_use_id`), `rate_limit_event` → `QuotaSnapshot`, `result` → usage, turns, status.
- If `expectedToolNames` is set and no non-error tool_result came from one of them, the result is `failed` with `kind: 'incomplete_ai_output'`, whatever `finalText` says, and the tool results are dropped. A caller that must see error tool_results (for example a Slack rate-limit error) leaves `expectedToolNames` unset and enforces ADR-026 itself, as `SlackConnectorSource` does (R57).
- Kills the process group on timeout or abort.
- Never logs tool result content at info level. Content is stored only by the module that owns it.

## 2. Message source (`MessageSource`)

```typescript
interface MessageSource {
  /** Search pages, oldest first, up to req.maxPages. */
  collect(req: CollectRequest, signal: AbortSignal): Promise<CollectResult>;
  /** Full threads: parent + replies per request. */
  fetchThreads(
    requests: { conversationId: string; parentTs: string; jobId?: string }[],
    signal: AbortSignal,
  ): Promise<{ conversationId: string; parentTs: string; messages: SourceMessage[]; rejected: number }[]>;
  // rejected = parser rejections + out-of-window (R42) replies; a thread that fails to parse is dropped (R45)
}

interface CollectRequest {
  afterTs: string;               // Slack ts: the stream's checkpoint (incremental checkpoint trails now by indexLagSeconds, R61)
  beforeTs?: string;             // backfill only
  maxPages: number;              // pages per collector run (~5)
  jobId?: string;                // queue job id, recorded as claude_runs.job_id (R60 M3)
}

interface CollectResult {
  pages: MessagePage[];
  searches: number;
  complete: boolean;             // no next cursor after the last accepted page
}

interface MessagePage {
  messages: SourceMessage[];
  rejected: number;              // results dropped by validation, counted
  nextCursor?: string;
}

// Public and private channels cannot be told apart from the result label.
type ConversationType = 'im' | 'mpim' | 'channel';

interface SourceMessage {
  externalId: string;            // `${conversationId}:${ts}` (dedup key); computed by producers, checked by the schema
  conversationId: string;        // /^[CDG][A-Z0-9]+$/
  conversationType: ConversationType;  // from result labels, not ID prefix
  conversationName?: string;
  ts: string;                    // Slack Message_ts, /^\d{10}\.\d{6}$/
  threadTs?: string;             // parsed from permalink ?thread_ts=
  senderId: string;              // /^U[A-Z0-9]+$/
  senderName?: string;
  senderEmail?: string;
  text: string;
  fullNotes?: string;
  permalink?: string;
  replyCount?: number;
  sentAt: string;                // ISO UTC derived from ts
}
```

### Slack connector adapter rules (`integrations/slack/claude-connector`)

- Collection uses only `slack_search_public_and_private` with: `after` (Unix ts), `sort: "timestamp"`, `sort_dir: "asc"`, `limit: 20`, `include_bots: false`, `include_context: false`, `response_format: "detailed"` (ADR-025).
- `fetchThreads` uses `slack_read_thread` (returns `Message TS` per reply).
- Never use `slack_read_channel` for collection (no per-message ts). Never use `response_format: "concise"` (drops IDs).
- Parses the markdown inside the JSON `results` field. The parser has contract tests against recorded, anonymized fixtures. If the format changes, the parser fails loudly; it never guesses.
- Results are validated with Zod. A result missing `Message_ts`, channel ID or sender ID is rejected and counted, not stored.
- Uses the `collector` worker profile and Haiku.
- Phase 3 behaviour (page-chain verification, fail-closed parsing, ts window, HTTP routes `GET /api/inbox/messages`, `GET /api/slack/status`, `POST /api/slack/backfill`) is described in `docs/modules/slack.md`, "Implementation notes (Phase 3)".

### Message sink (`MessageSink`)

Implemented in Phase 6 (`packages/contracts/src/outgoing.ts`, `integrations/slack/sender.ts`). The only implementation is `SlackSender`; tests and smoke scripts inject a fake through `createContainer`'s `sink` option. The sink is not on the `Container`: only the `slack.send` executor in `OutgoingService` can reach it.

```typescript
interface SendMessageCommand {
  outgoingId: string;
  approvalId: string;
  conversationExternalId: string;
  threadTs?: string;
  text: string;
  jobId?: string;            // the approval.execute job; used to find the claude_runs row
  authorisedBy?: "user" | "policy"; // default "user"; "policy" gives the send run policy_approved (J1)
}

interface SendResult {
  status: "sent_unverified" | "failed" | "uncertain";
  failure?: string;          // content-free: no_send | argument_mismatch | tool_error | uncertain_outcome
  mismatch?: boolean;        // the tool was called with other than the approved arguments
  runId?: string;
}

interface SendOptions {
  /** false (or a throw) cancels the send before Claude spawns: the sink rethrows cancelled_before_spawn. */
  beforeSpawn?: () => boolean;
}

interface MessageSink {
  send(cmd: SendMessageCommand, signal: AbortSignal, opts?: SendOptions): Promise<SendResult>;
  /** true / false when found / not found after sinceTs; null when it could not be checked.
   *  Throws auth_paused / quota_exhausted / rate_limited (R18). */
  findSent(cmd: SendMessageCommand, sinceTs: string): Promise<boolean | null>;
}
```

**Policy sends (`requestAutoSend`, Phase 6b).** `OutgoingService.requestAutoSend(tx, { autoReplyId, conversationExternalId, threadTs, text, followupId })` runs inside the caller's transaction. It requires `text` to end with `Sent using @claude`, an `auto_replies` row with `decision = 'sent'` and no outgoing yet, and a request that matches that row exactly. It throws `AutoSendBlocked` when away is off or another session is open, and `AutoReplyDisabledByPermission` when the user tightened `slack.auto_reply`. Otherwise it records the outgoing row plus a policy approval and links both to the row. The executor then calls `sink.send` with `authorisedBy: "policy"` and a `beforeSpawn` that re-checks away mode, the session and the gate.

**`sendGuard`.** `ClaudeJobRequest` and `AIExecutionRequest` accept `sendGuard?: { toolName, expectedInputSha256 }`. `SlackSender` sets it on every send. See `docs/modules/claude-orchestrator.md`, "Send runs".

**Send run (`SlackSender.send`).** One orchestrator run: profile `collector`, priority class `send`, model haiku, `maxTurns: 3`, `allowedTools: [slack_send_message, ToolSearch]`. The prompt has a system part (call the tool once with exactly the given arguments) and one approved part, `user_approved` (or `policy_approved` when `SendMessageCommand.authorisedBy` is `"policy"`, ADR-033): the JSON of `{channel_id, message, thread_ts?}`. There are no untrusted parts and no `expectedToolNames`; the adapter classifies the raw tool results itself. The request validator rejects a send request with more than one allowed tool or with untrusted content, a `policy_approved` part anywhere else, and a send request without a `sendGuard` for its write tool (rule K). It cannot check the tool arguments the model will use. Since Phase 6b the request carries a `sendGuard`: a per-run `PreToolUse` hook blocks the send call unless its canonical `tool_input` hashes to the approved arguments' sha256 (J2; see `docs/modules/claude-orchestrator.md`). The after-the-fact check below stays as a second layer.

**Argument verification.** The check runs on the run's recorded tool calls, after the send tool ran: on its own a mismatch is detected after the fact, not prevented (R20); the J2 send guard is the layer that prevents it. The tool's result text is never read as success (its format is unknown). From the `tool_use` input recorded with each tool result, code checks that `channel_id` and `thread_ts` equal the approved values exactly (both absent matches) and that `message` equals the approved text after trimming trailing whitespace. The only tolerated extra key is `unfurl_app_links: false`; any other key (for example `reply_broadcast`) is a mismatch. The J2 send guard normalises both sides the same way before hashing (drops `unfurl_app_links: false`, `trimEnd`s `message`), so it accepts exactly the inputs this check accepts.

**Outcomes** (classified from the run's raw tool results):

| Situation | Result |
|---|---|
| Exactly one send result, not an error, arguments match | `sent_unverified` |
| Send result with changed arguments | `failed` / `argument_mismatch` with `mismatch: true` (with two sends, or other tools, `uncertain` plus `mismatch`) |
| No send call at all | `failed` / `no_send` |
| Send error naming a definitive Slack rejection (`channel_not_found`, `not_in_channel`, `is_archived`, `channel_is_archived`, `msg_too_long`, `no_text`, `invalid_auth`, `not_authed`, `restricted_action`, `cant_post`, `cannot_post`, `user_not_found`) | `failed` / `tool_error` (the content only classifies; it is never stored) |
| Any other send error, two or more sends, any other tool's result | `uncertain` / `uncertain_outcome` |
| Run failed after spawn with `details.uncertain` (timeout, crash, an auth pause that replaced the failure) | `uncertain` / `uncertain_outcome` |
| Run failed before spawn (quota, auth, validation, abort while waiting for a Claude slot) | the error is rethrown: nothing was sent |

**`findSent`.** One incremental search through the verified `SlackConnectorSource.collect` (`afterTs = floor(sinceTs) - 1`, at most 2 pages, `queryTerms: ["from:<@self>"]`, R19). Extra query terms are single tokens (no whitespace or quotes) appended to the query, so they are part of the exact first-page input and of every cursor page's input, and R35 page-chain verification is unchanged. A message matches when it is in the command's conversation, from `slack.selfUserId`, at or after `sinceTs`, in exactly the command's thread (top-level when the command has none) and its text equals the command's after both are decoded (`&amp;` `&lt;` `&gt;`; URL link markup `<url|label>` → label and `<url>` → url; mentions and channel references are left as they are), with `http://`/`https://` prefixes removed (J3: Slack autolinks a typed URL as `<https://host/path|host/path>`, a label without the scheme) and whitespace-normalised. Returns `null` (cannot tell) when the self id is unset, the search fails, or nothing matched in an incomplete search. An `auth_paused`, `quota_exhausted` or `rate_limited` search failure is rethrown instead, so the verify job is deferred (or retried at Slack's time) without spending a verify attempt (R18). It never sends.

**The executor (`OutgoingService`).** Registered as the `slack.send` executor with the approval engine. The engine runs it only after approval, inside the `approval.execute` job (timeout = max(120 s, collector timeout + 90 s)), and passes the job's abort signal to the sink. Sequence: (1) claim `pending` to `sending` in one transaction, requiring an approved approval that the engine has claimed; (2) call `sink.send`; (3) record the outcome in a new transaction. A throw from the sink means nothing was sent: the message becomes `failed` / `not_started` and the draft returns for a new request. Errors thrown to the engine carry fixed reasons only, never text.

**Verify and no automatic resend.** `sent_unverified` and an uncertain `needs_attention` queue `outgoing.verify` (default after 120 s, up to `outgoing.verify.maxAttempts` = 5 attempts). A found message becomes `sent`. When attempts run out the row gets failure `unverified` and a notification, and waits for the user: `mark_sent`, `discard`, or (only from `needs_attention`) `resend`, which supersedes the old row and needs a new approval. Nothing ever moves a message back to `pending`, and nothing re-sends without the user. A message whose arguments changed is never verified and never re-sent automatically: it goes to `needs_attention` / `argument_mismatch` with a `high` runtime flag and the notification "Send went out with changed arguments — check Slack for a stray message"; the user checks Slack and resolves it. `outgoing.verify` passes `lastJobAttempt` on the job's final attempt, where a rate-limited search counts as "cannot tell" so a rate limit cannot park the job. A verify job can still park on other failures (for example repeated handler timeouts); such a row then waits for the user.

**In-flight guard.** `OutgoingService` keeps an in-process set of message ids whose executor is running. The recovery sweep (startup and every reaper pass) never touches those, and `resolve` refuses them, so a send that outlived its job timeout cannot be handed to the user for a resend while it may still post. The sweep moves a `sending` row older than 10 minutes with no live executor to `needs_attention` / `uncertain_outcome` and queues a verify, and returns stranded `pending` rows (the approval is terminal, or was claimed by an executor that is gone) to a draft. The guard is single-process: Synapse runs one API process. A partial unique index on `outgoing_messages(followup_id)` for live statuses backs the rule that one follow-up has at most one live send.

Text lives only in `outgoing_messages.text` and the route responses. Audit rows, events, notifications, follow-up history, logs and thrown messages carry ids and fixed reasons.

## 3. Issue source (`JiraIssueSource`)

As built in Phase 8 (read-only), in `packages/contracts/src/jira.ts`. The earlier draft (`IssueSource` with capabilities, health, `getIssue`, `getComments` and a rich `SourceIssue`) was not built; those return with the deferred items (comments, writes).

```typescript
interface JiraIssueSource {
  resolveCloudId(signal: AbortSignal): Promise<{ id: string; url: string; name: string }[]>;
  searchPage(
    args: { cloudId: string; jql: string; maxResults: number; nextPageToken?: string },
    signal: AbortSignal,
  ): Promise<{ issues: SourceIssue[]; nextPageToken: string | null; total: number | null }>;
}

// Zod: sourceIssueSchema. Timestamps are UTC ISO instants.
interface SourceIssue {
  key: string;            // e.g. PROJ-123
  jiraId: string;
  projectKey: string;
  summary: string;        // untrusted text (ADR-032)
  statusName: string;
  statusCategory: 'new' | 'indeterminate' | 'done';
  priority: string | null;
  issueType: string;
  labels: string[];
  dueDate: string | null; // YYYY-MM-DD
  createdAt: string;
  updatedAt: string;
  webUrl: string | null;  // https:// links only; null otherwise
}
```

Rules:

- One call is one collector run: `resolveCloudId` runs `mcp__claude_ai_Atlassian__getAccessibleAtlassianResources`; `searchPage` runs `mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql` with the fields in `JIRA_FIELDS` (`summary, status, priority, issuetype, project, labels, duedate, created, updated`), one page per run (haiku, `maxTurns: 4`, allowed tools `[tool, ToolSearch]`).
- Only the raw `tool_result` is parsed (ADR-026). It must be the single result for that tool, not an error, and its `tool_use` input must equal the requested arguments (`fields` as a set; only `responseContentFormat: "markdown"`, `actionSource: "model_tool_call"` and, for search, `searchResultMode: "issues"` may be added by the connector). A mismatch or missing result is `incomplete_ai_output`; a shape mismatch is `parse_failed`. When the CLI has replaced the result with its oversized-output notice (`Error: result (... exceeds maximum allowed tokens`, or `<persisted-output>`), the error is `output_too_large` (retry decision `needs_attention`: lower `jira.pageSize`, default 20).
- A tool error that looks like a rate limit is `rate_limited` through `integrations/rate-limit.ts` (`throwIfRateLimited`, shared with Slack).
- The next page passes `nextPageToken = pageInfo.endCursor`. `total` is always `null` (the adapter never requests a count).
- The cloudId is stored in the `jira.cloudId` setting after exactly one site is found.
- Read models: `JiraIssueView` (a `SourceIssue` plus `attention`, `inScope`, `slackMentions`), `JiraStatusDto` (`enabled, cloudIdSet, lastSyncAt, lastReconcileAt, issueCount, lastError, scopeJql, excludedProjects`), `JiraIssueViewKind` (`attention|open|done|all`). The scope JQL is validated by `jiraScopeJqlSchema` (no newline, no `ORDER BY`, balanced parentheses and closed double-quoted strings).
- Events: `jira.issue_updated {key}`, `jira.issue_attention {key, attention}`.
- Writes (`IssueSink`: comment, transition, edit) are deferred; they will require approval.

## 4. Repository provider (`RepositoryProvider`)

```typescript
interface RepositoryProvider {
  checkPath(path: string, registeredPaths: readonly string[]): Promise<PathCheckResult>; // C2 path rules
  inspect(path: string): Promise<RepositoryInspectResult>;  // C3, read-only: top level, branch, remotes, branches
}
```

Read-only. Only registered paths are inspected; remote URLs are credential-stripped. (This replaces an earlier sketch with `listRegistered`, `getHistory` and `getStatus`, which was never built; the registry is `RepositoryRegistry`, and clean-tree and merge-in-progress checks are `GitWorkflow.preflight`.) The registry stores `Repository` rows (`originUrl`, `upstreamUrl`, `upstreamPushDisabled`, `trackedBranch`, environments with `protected` and `autoDeploysOnMerge`, `test_command`). Module doc: `docs/modules/engineering-brain.md`.

## 4.1 Git workflow (`GitWorkflow`, Phase 10)

Port in `packages/contracts/src/repository.ts`; adapter `LocalGitWorkflow` in `apps/api/src/integrations/repository/git-workflow.ts`. **All write operations of an engineering task are on this port**, never in a Claude run. Every call goes through the hardened runner: argv only, `-C <registered realpath>`, `-c core.fsmonitor=false -c core.hooksPath=/dev/null -c credential.interactive=never`, an environment allowlist, `GIT_TERMINAL_PROMPT=0`, 60 s timeout (120 s for push, fetch, pull and ls-remote). Errors are `GitWorkflowError(code)` with `message === code`; a message never carries a path, URL, branch name or stderr.

```typescript
interface GitWorkflow {
  preflight(repo, parent, opts?: { allowUpstreamPush?: boolean }): Promise<GitPreflightResult>;
  localState(repo): Promise<GitLocalStateResult>;  // preflight's local checks only; no remote
  currentBranch(repo): Promise<string | null>;
  createTaskBranch(repo, parent, taskBranch): Promise<{ baseSha: string }>;
  gitDirFingerprint(repo): Promise<string>;   // filesystem reads only; includes configFingerprint
  configFingerprint(repo): Promise<string>;   // .git/config, hooks, info/attributes, global config; filesystem reads only
  diffSummary(repo, opts?: { gitDirBaseline?: string }): Promise<GitDiffSummary>;
  commitAll(repo, message, expectedHash, opts?: GitCommitOptions): Promise<{ sha: string }>;
  updateParent(repo, parent, opts?: GitConfigGuard): Promise<{ ok: true } | { ok: false; conflict: true }>;
  mergeLocal(repo, parent, taskBranch, opts?: GitMergeOptions): Promise<{ ok: true; sha: string } | { ok: false; conflict: true }>;
  pushParent(repo, parent, opts: GitPushOptions): Promise<{ ok: true }>;
  discardChanges(repo, expectedHash, opts?: GitConfigGuard): Promise<{ ok: true }>;
  branchExists(repo, name): Promise<boolean>;
  branchTip(repo, name): Promise<string | null>;
  commitsAhead(repo, parent): Promise<GitCommitSummary[]>;  // newest first
  cleanup(repo, taskBranch, returnTo: string | null, opts: { force: boolean }): Promise<{ ok: true; deleted: boolean } | { ok: false; dirty: true }>;
}
```

- **Options.** `GitConfigGuard.expectedConfigFingerprint`: when given and different, the call fails `config_changed` before any git command. `GitDiffOptions.gitDirBaseline` is compared before any git command (`unsafe`, reason `git_dir_changed`). `GitMergeOptions.commit` pins the task-branch tip (`branch_moved`; exactly that commit is merged). `GitPushOptions.expectedSha` pins the parent tip (`branch_moved`; `<sha>:refs/heads/<parent>` is pushed), plus `protectedBranches`, the registered `upstreamUrl` and (final review) the registered `expectedOriginUrl`.
- **`GitDiffSummary`**: `files` (path, added, removed), `hash` (sha256 over HEAD and the kind, mode and on-disk content of every changed path; staging does not change it), `unsafe` and sorted `unsafeReasons` (`GIT_UNSAFE_REASONS`), `diffText` (at most `GIT_DIFF_TEXT_MAX_BYTES` = 200 KiB, cut on a UTF-8 boundary) and `truncated`.
- **`commitAll`**: checks the hash, `git add -A`, checks again (resetting and `diff_changed` on a mismatch), then commits. `nothing_to_commit` and `unsafe_change` are refusals.
- **`updateParent`** fetches `origin` and `upstream` with explicit refspecs and merges (`--ff-only`, else a merge commit); it is not `git pull`. **`createTaskBranch`** fast-forwards the local parent to `origin/<parent>` only, then `switch -c` with no tracking. A conflict is aborted (`merge --abort`) and reported as `{ ok: false, conflict: true }`; every merge carries `-c branch.<parent>.mergeOptions= -c rerere.enabled=false -c rerere.autoUpdate=false -c submodule.recurse=false`.
- **`pushParent`** pushes only to `origin`, never forces, and refuses a protected parent (`protected_branch`), an origin push URL equal to the upstream repository (`push_target_is_upstream`; same normalised URL or same `owner/repo`) and a missing comparison reference (`no_upstream_reference`). With `expectedOriginUrl` it also refuses (`origin_changed`) when any effective origin push URL (`git remote get-url --push --all origin`, insteadOf rules expanded) is not that URL by normalised key or `owner/repo`; null always refuses.
- **`localState`** (final review): realpath equals git's top level, no merge/rebase/cherry-pick/revert in progress, clean status; `{ ok: false, reason: "not_a_repository" | "merge_in_progress" | "dirty_tree" }` otherwise. No remote is contacted (startup recovery uses it). `preflight` runs it first.
- **`discardChanges`** (`reset --hard HEAD` plus `clean` of exactly the diff's untracked paths) runs only when the tree still hashes to `expectedHash` and the diff is safe; otherwise `diff_changed`, `unsafe_change`, `dirty_tree` or `config_changed`.
- **`cleanup`** switches to `returnTo` (null: stays on the current branch) and deletes the task branch only when another local branch contains it, unless `force`; it never deletes the task branch while it is checked out (`deleted: false`); a dirty tree or merge in progress is untouched (`{ ok: false, dirty: true }`).
- **Preflight reasons** (`GIT_PREFLIGHT_REASONS`): `not_a_repository`, `merge_in_progress`, `dirty_tree`, `missing_remote`, `upstream_push_enabled`, `parent_missing_origin`, `parent_missing_upstream`. **Error codes** (`GIT_WORKFLOW_ERROR_CODES`): `git_failed`, `git_timeout`, `fetch_failed`, `push_failed`, `invalid_ref`, `branch_exists`, `branch_missing`, `missing_remote`, `dirty_tree`, `diff_changed`, `unsafe_change`, `nothing_to_commit`, `protected_branch`, `push_target_is_upstream`, `no_upstream_reference`, `config_changed`, `branch_moved`, `origin_changed`.

## 4.2 Pull request provider (`PullRequestProvider`, Phase 10)

Port in `packages/contracts/src/pull-requests.ts`; adapter `GitHubCliProvider` (`integrations/github/gh-cli.ts`) runs `gh` with argv, a restricted environment (`PATH`, `HOME`) and never reads or logs a token. github.com only.

```typescript
interface PullRequestProvider {
  /** Owner and repo of a stored, credential-stripped remote URL on a supported host, else null. */
  repoRef(url: string): PrRef | null;
  createPr(input: { upstream: PrRef; headOwner: string; branch: string; title: string; body: string }): Promise<{ url: string; number: number }>;
  prStatus(input: { upstream: PrRef; number: number }): Promise<PrStatus>;   // state, mergeable, checks, headSha
  /** Merges only while the PR head is still `headSha` (the commit the user approved pushing). */
  mergePr(input: { upstream: PrRef; number: number; headSha: string }): Promise<{ merged: boolean; sha?: string }>;
}
```

- **`repoRef(url)`** is the one place a remote URL becomes `{owner, repo}`. It is on the port so modules (which may not import an adapter) can resolve the fork and the upstream before pushing: an unsupported host is `unsupported_remote` before anything is pushed.
- `createPr` runs `gh pr create --repo <upstream> --head <fork owner>:<branch> --base <branch> --title … --body …`; `prStatus` runs `gh pr view --json …` and returns `headSha` from `headRefOid` (null unless a full hex sha); `mergePr` runs `gh pr merge <n> --repo <upstream> --merge --match-head-commit <headSha>` and refuses a `headSha` that is not a full hex sha (`pr_merge_failed`, without running gh).
- Errors are `PullRequestError(code)`: `gh_not_found`, `gh_auth` (classified from stderr, never kept), `pr_create_failed`, `pr_status_failed`, `pr_merge_failed`, `unsupported_remote`. The title, body and gh output are never in an error.

## 5. Error model

```typescript
type ErrorKind =
  | 'transient_network'      // retry with backoff
  | 'connector_not_ready'    // MCP server pending/not connected: retry
  | 'rate_limited'           // Slack/Jira/Claude rate limit: retry after delay
  | 'quota_exhausted'        // Claude five-hour/seven-day window: defer until resetsAt
  | 'auth_failed'            // NEEDS_ATTENTION, no retry
  | 'auth_paused'            // Claude auth paused after auth_failed (ADR-037 §4): defer, no attempt consumed
  | 'permission_denied'      // NEEDS_ATTENTION, no retry
  | 'invalid_input'          // fail, no retry
  | 'incomplete_ai_output'   // retry (counts toward max attempts)
  | 'parse_failed'           // connector format changed: NEEDS_ATTENTION
  | 'provider_error'         // retry
  | 'timeout'                // retry; verify external side effects first
  | 'unknown';

interface ClassifiedError {
  kind: ErrorKind;
  message: string;           // no secrets, no message content
  retryAfter?: string;
  details?: Record<string, unknown>;
}
```

## 6. Capabilities and health

```typescript
interface IntegrationCapability {
  name: string;              // e.g. 'messages.search', 'messages.thread', 'messages.send'
  available: boolean;
  notes?: string;
}

interface IntegrationHealth {
  status: 'healthy' | 'degraded' | 'unavailable';
  checkedAt: string;
  lastSuccessAt?: string;
  lastError?: ClassifiedError;
}
```

Adapters must handle missing capabilities gracefully: report them and let the calling module degrade, rather than throwing on startup.
