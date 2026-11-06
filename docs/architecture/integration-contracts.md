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

## 3. Issue source (`IssueSource`)

```typescript
interface IssueSource {
  getCapabilities(): Promise<IntegrationCapability[]>;
  getHealth(): Promise<IntegrationHealth>;
  searchIssues(query: IssueQuery): Promise<IssuePage>;
  getIssue(issueKey: string): Promise<SourceIssue>;
  getComments(issueKey: string): Promise<SourceIssueComment[]>;
}

interface IssueQuery {
  jql: string;                   // e.g. assignee = currentUser() AND updated >= "<checkpoint>"
  fields: string[];              // must include duedate explicitly
  cursor?: string;               // pageInfo.endCursor
  maxResults: number;
}

interface SourceIssue {
  key: string;                   // e.g. PROJ-123
  id: string;
  projectKey: string;
  summary: string;
  status: string;
  priority?: string;
  assigneeId?: string;
  reporterId?: string;
  dueDate?: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  url: string;
}
```

Jira connector rules: resolve `cloudId` once with `getAccessibleAtlassianResources` and store it in `integrations`. Collect via `searchJiraIssuesUsingJql`. Writes (`IssueSink`: comment, transition, edit) require approval.

## 4. Repository provider (`RepositoryProvider`)

```typescript
interface RepositoryProvider {
  listRegistered(): Promise<Repository[]>;
  inspect(repositoryId: string, request: RepositoryInspectionRequest): Promise<RepositoryInspectionResult>;
  getHistory(repositoryId: string, query: GitHistoryQuery): Promise<GitCommit[]>;
  getStatus(repositoryId: string): Promise<RepositoryStatus>;  // clean tree, current branch, remotes, merge in progress
}
```

```typescript
interface Repository {
  id: string;
  name: string;
  localPath: string;
  originUrl?: string;
  upstreamUrl?: string;
  upstreamPushDisabled: boolean;
  trackedBranch: string;               // user-confirmed default parent branch (ADR-035)
  environments: { name: string; branch: string; notes?: string }[];  // e.g. stage→stage, prod→prod
}
```

Only registered paths are accessible. Write operations (branch, commit, merge, push, PR) aren't on this port. They run inside an approved engineering job through the orchestrator (see `docs/modules/claude-orchestrator.md`).

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
