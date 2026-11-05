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

interface AIProvider {
  execute(request: AIExecutionRequest, signal: AbortSignal): Promise<AIExecutionResult>;
  getCapabilities(): Promise<AICapability[]>;
  getHealth(): Promise<ProviderHealth>;
}

interface AIExecutionRequest {
  runId: string;                 // internal UUID, one per attempt
  jobId: string;
  workerProfile: WorkerProfile;
  model: 'haiku' | 'sonnet' | 'opus' | string;
  systemPrompt: string;
  prompt: string;                // must name exact tool names and arguments
  allowedTools: string[];        // always includes 'ToolSearch' when MCP tools are needed
  disallowedTools: string[];
  maxTurns: number;
  timeoutMs: number;
  workingDirectory: string;      // registered repo path for engineering; scratch dir otherwise
  expectedToolNames?: string[];  // run fails if none of these produced a real tool_result
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
  error?: ClassifiedError;
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
- If `expectedToolNames` is set and no non-error tool_result came from one of them, the result is `failed` with `kind: 'incomplete_ai_output'`, whatever `finalText` says.
- Kills the process group on timeout or abort.
- Never logs tool result content at info level. Content is stored only by the module that owns it.

## 2. Message source (`MessageSource`)

```typescript
interface MessageSource {
  getCapabilities(): Promise<IntegrationCapability[]>;
  getHealth(): Promise<IntegrationHealth>;

  /** Incremental or backfill page, oldest first. */
  fetchMessages(query: MessageQuery): Promise<MessagePage>;

  /** Full thread: parent + replies. */
  fetchThread(conversationId: string, parentTs: string): Promise<SourceMessage[]>;

  listConversations(query: ConversationQuery): Promise<Conversation[]>;
  getUser(externalUserId: string): Promise<SourceUser>;
}

interface MessageQuery {
  afterTs: string;               // checkpoint: Slack ts, inclusive
  beforeTs?: string;
  conversationTypes?: ConversationType[];  // default: all
  includeBots: false;            // always false (ADR-027)
  cursor?: string;
  maxPages: number;              // pages per collector run (~5)
}

interface MessagePage {
  messages: SourceMessage[];
  nextCursor?: string;
  pagesFetched: number;
  newestTs?: string;             // becomes the next checkpoint once persisted
}

type ConversationType = 'im' | 'mpim' | 'private_channel' | 'public_channel';

interface SourceMessage {
  externalId: string;            // `${conversationId}:${ts}` (dedup key)
  conversationId: string;
  conversationType?: ConversationType;  // from result labels, not ID prefix
  conversationName?: string;
  ts: string;                    // Slack Message_ts
  threadTs?: string;             // parsed from permalink ?thread_ts=
  senderId: string;              // U… user ID
  senderName?: string;
  senderEmail?: string;
  text: string;
  permalink: string;
  replyCount?: number;
  sentAt: string;                // derived from ts, UTC
}
```

### Slack connector adapter rules (`integrations/slack/claude-connector`)

- Collection uses only `slack_search_public_and_private` with: `after` (Unix ts), `sort: "timestamp"`, `sort_dir: "asc"`, `limit: 20`, `include_bots: false`, `include_context: false`, `response_format: "detailed"` (ADR-025).
- `fetchThread` uses `slack_read_thread` (returns `Message TS` per reply).
- Never use `slack_read_channel` for collection (no per-message ts). Never use `response_format: "concise"` (drops IDs).
- Parses the markdown inside the JSON `results` field. The parser has contract tests against recorded, anonymized fixtures. If the format changes, the parser fails loudly; it never guesses.
- Results are validated with Zod. A result missing `Message_ts`, channel ID or sender ID is rejected and counted, not stored.
- Uses the `collector` worker profile and Haiku.

### Message sink (`MessageSink`)

```typescript
interface MessageSink {
  /** Called only by the approval engine after approval and revalidation. */
  sendMessage(cmd: SendMessageCommand): Promise<SendMessageResult>;
  /** Used to verify an uncertain send before any retry. */
  findSentMessage(cmd: SendMessageCommand): Promise<SourceMessage | null>;
}

interface SendMessageCommand {
  approvalId: string;
  idempotencyKey: string;
  conversationId: string;
  threadTs?: string;
  text: string;
}
```

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

Only registered paths are accessible. Write operations (branch, commit, merge, push, PR) aren't on this port. They run inside an approved engineering job through the orchestrator (see `docs/modules/claude-orchestrator.md`).

## 5. Error model

```typescript
type ErrorKind =
  | 'transient_network'      // retry with backoff
  | 'connector_not_ready'    // MCP server pending/not connected: retry
  | 'rate_limited'           // Slack/Jira/Claude rate limit: retry after delay
  | 'quota_exhausted'        // Claude five-hour/seven-day window: defer until resetsAt
  | 'auth_failed'            // NEEDS_ATTENTION, no retry
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
