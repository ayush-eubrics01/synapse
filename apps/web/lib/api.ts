import type {
  Approval,
  ApprovalTextEdit,
  ApprovalView,
  AwayDigest,
  BackupEntry,
  CandidatesResponse,
  ClaudeActivityView,
  CodeAnswerView,
  CommitmentFilter,
  CommitmentStatus,
  CommitmentView,
  ConversationSummary,
  ConversationThread,
  DashboardLayout,
  DashboardLayoutsResponse,
  DashboardLayoutView,
  DashboardOverview,
  EngineeringTaskCreateInput,
  EngineeringTaskDetail,
  EngineeringTaskStatus,
  EngineeringTaskView,
  EvaluateResult,
  FlagStatus,
  FollowupView,
  GroupedFlags,
  HealthReport,
  JiraIssueView,
  JiraIssueViewKind,
  JiraStatusDto as JiraStatusDtoContract,
  Job,
  MilestoneInput,
  MilestoneUpdateInput,
  MilestoneView,
  OutgoingResolveAction,
  PersonDetail,
  PersonFlag,
  ProjectDetail,
  ProjectFactView,
  ProjectView,
  RecommendationView,
  RepositoryProposal,
  RepositoryRegisterInput,
  RepositoryUpdateInput,
  RepositoryView,
  RuntimeView,
  UpcomingMilestone,
  UrgencyStatus,
  UrgentItem,
} from "@synapse/contracts";

/** A non-2xx answer from the API. The message keeps the "<METHOD> <url> failed with <status>" form. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The API's fixed `error` code, when the body had one. */
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Why the overview failed: the API could not be reached, or it answered with an HTTP error. */
export type OverviewFailure = { kind: "network" } | { kind: "http"; status: number };

/** An ApiError is an HTTP error; anything else (fetch throws a TypeError) means unreachable. */
export function classifyOverviewFailure(reason: unknown): OverviewFailure {
  return reason instanceof ApiError ? { kind: "http", status: reason.status } : { kind: "network" };
}

async function request<T>(
  url: string,
  init: RequestInit | undefined,
  fetchImpl: typeof fetch,
  okStatuses: number[] = [],
): Promise<T> {
  const res = await fetchImpl(url, init);
  if (!res.ok && !okStatuses.includes(res.status)) {
    let detail = "";
    let code: string | undefined;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === "string") {
        detail = `: ${body.error}`;
        code = body.error;
      }
    } catch {
      // body was not JSON; the status alone is reported
    }
    throw new ApiError(
      `${init?.method ?? "GET"} ${url} failed with ${res.status}${detail}`,
      res.status,
      code,
    );
  }
  // No Content has no body to parse.
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// A 503 still carries a HealthReport (status "down"), so it is returned, not thrown.
export function getHealth(fetchImpl: typeof fetch = fetch): Promise<HealthReport> {
  return request("/health/ready", undefined, fetchImpl, [503]);
}

export function getApprovals(fetchImpl: typeof fetch = fetch): Promise<ApprovalView[]> {
  return request("/api/approvals?status=pending", undefined, fetchImpl);
}

export function decideApproval(
  id: string,
  decision: "approve" | "reject",
  reason?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Approval> {
  return request(
    `/api/approvals/${encodeURIComponent(id)}/${decision}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason }),
    },
    fetchImpl,
  );
}

export function getJobs(limit = 20, fetchImpl: typeof fetch = fetch): Promise<Job[]> {
  return request(`/api/jobs?limit=${limit}`, undefined, fetchImpl);
}

export interface ClaudeRun {
  id: string;
  jobId: string | null;
  workerProfile: string;
  model: string | null;
  status: string;
  numTurns: number | null;
  durationMs: number | null;
  tokens: {
    input: number | null;
    output: number | null;
    cacheRead: number | null;
    cacheCreation: number | null;
  };
  costUsdEquivalent: number | null;
  /** null once the run was compacted by retention. */
  permissionDenialCount: number | null;
  errorKind: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface ClaudeQuotaWindow {
  utilization: number;
  status: string;
  resetsAt?: string;
}

/** Utilization fractions (0–1, like `utilization`) at which the orchestrator gates jobs (ADR-029). */
export interface ClaudeQuotaThresholds {
  fiveHour: { soft: number; hard: number; stop: number };
  sevenDay: { soft: number; hard: number };
}

export interface ClaudeStatus {
  quota: {
    level: "ok" | "soft" | "hard" | "stop";
    window: "five_hour" | "seven_day" | null;
    resetsAt: string | null;
    fiveHour?: ClaudeQuotaWindow;
    sevenDay?: ClaudeQuotaWindow;
  } | null;
  thresholds: ClaudeQuotaThresholds;
  auth: { refreshExpiresAt: string | null; slides: boolean | null };
}

export function getClaudeRuns(limit = 10, fetchImpl: typeof fetch = fetch): Promise<ClaudeRun[]> {
  return request(`/api/claude/runs?limit=${limit}`, undefined, fetchImpl);
}

export function getClaudeActivity(fetchImpl: typeof fetch = fetch): Promise<ClaudeActivityView> {
  return request("/api/claude/activity", undefined, fetchImpl);
}

/** The keys `GET/PUT /api/settings` expose (Phase 10b). */
export interface ClaudeSettingsDto {
  "claudeActivity.enabled": boolean;
  "claudeActivity.activeWindowMinutes": number;
  "claudeActivity.yieldWhenActive": boolean;
  "claudeActivity.yieldEngineering": boolean;
  "claudeActivity.staleBranchDays": number;
  "claudeActivity.openPrReminderDays": number;
  "codeAnswer.model": "haiku" | "sonnet" | "opus";
  "codeAnswer.maxTurns": number;
  "codeAnswer.timeoutMinutes": number;
  "codeAnswer.away.enabled": boolean;
  "codeAnswer.away.autoSend": boolean;
  "codeAnswer.away.maxRunsPerDay": number;
  "engineering.sandbox.enabled": boolean;
}
export type ClaudeSettingsKey = keyof ClaudeSettingsDto;

/** Phase 11 operations keys exposed by `GET/PUT /api/settings`. */
export interface OpsSettingsDto {
  "ops.backup.enabled": boolean;
  "ops.backup.hour": number;
  "ops.backup.keep": number;
  "ops.disk.warnFreeGiB": number;
  "retention.jobsDays": number;
  "retention.notificationsDays": number;
  "retention.claudeRunsDays": number;
  "retention.auditDays": number;
  "retention.snapshotsDays": number;
}
export type AutoReplyKind =
  | "code_answer"
  | "stalled_reminder"
  | "followup_question"
  | "acknowledgement";

/** ADR-033 away-reply limits; the API only accepts values at least as strict as ADR-033. */
export interface AwayReplySettingsDto {
  "autoReply.allowedKinds": AutoReplyKind[];
  "autoReply.maxPerPersonPerDay": number;
  "autoReply.minMinutesBetweenInThread": number;
  "autoReply.minConfidence": number;
  "autoReply.maxSendDelayMinutes": number;
}
export type SettingsDto = ClaudeSettingsDto & OpsSettingsDto & AwayReplySettingsDto;

export function getSettings(fetchImpl: typeof fetch = fetch): Promise<SettingsDto> {
  return request("/api/settings", undefined, fetchImpl);
}

export function putSettings(
  changes: Partial<SettingsDto>,
  fetchImpl: typeof fetch = fetch,
): Promise<SettingsDto> {
  return request(
    "/api/settings",
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(changes),
    },
    fetchImpl,
  );
}

export function getClaudeStatus(fetchImpl: typeof fetch = fetch): Promise<ClaudeStatus> {
  return request("/api/claude/status", undefined, fetchImpl);
}

export interface SlackSyncState {
  stream: string;
  checkpoint: string | null;
  upperBound: string | null;
  status: "idle" | "running" | "paused" | "complete" | "error";
  pagesDone: number;
  lastSuccessAt: string | null;
  lastError: { kind: string; message: string } | null;
  nextRunAfter: string | null;
}

export interface SlackStatusDto {
  incremental: SlackSyncState;
  /** `resumable`: running with no live backfill job, so only a resume continues it (R60 M4). */
  backfill: SlackSyncState & { resumable: boolean };
  searchesToday: number;
}

export interface InboxMessageDto {
  id: string;
  conversation: { id: string; name: string | null; type: string };
  sender: { id: string; name: string | null };
  sentAt: string;
  text: string | null;
  permalink: string | null;
  threadTs: string | null;
  replyCount: number;
}

export function getInboxMessages(
  limit = 50,
  fetchImpl: typeof fetch = fetch,
): Promise<InboxMessageDto[]> {
  return request(`/api/inbox/messages?limit=${limit}`, undefined, fetchImpl);
}

export function getOverview(fetchImpl: typeof fetch = fetch): Promise<DashboardOverview> {
  return request("/api/dashboard/overview", undefined, fetchImpl);
}

export function getConversations(
  limit = 50,
  fetchImpl: typeof fetch = fetch,
): Promise<ConversationSummary[]> {
  return request(`/api/inbox/conversations?limit=${limit}`, undefined, fetchImpl);
}

/** Messages oldest first; 404 (thrown) when the conversation is unknown. */
export function getThread(
  id: string,
  limit = 200,
  fetchImpl: typeof fetch = fetch,
): Promise<ConversationThread> {
  return request(
    `/api/inbox/conversations/${encodeURIComponent(id)}/thread?limit=${limit}`,
    undefined,
    fetchImpl,
  );
}

export function getSlackStatus(fetchImpl: typeof fetch = fetch): Promise<SlackStatusDto> {
  return request("/api/slack/status", undefined, fetchImpl);
}

export function startBackfill(
  fetchImpl: typeof fetch = fetch,
): Promise<{ started: boolean; state: SlackSyncState }> {
  return request("/api/slack/backfill", { method: "POST" }, fetchImpl);
}

export function skipUnreadablePage(
  fetchImpl: typeof fetch = fetch,
): Promise<{ checkpoint: string }> {
  return request("/api/slack/incremental/skip", { method: "POST" }, fetchImpl);
}

export type UrgencyStatusDto = UrgencyStatus;

export type UrgentItemDto = UrgentItem;

export function getUrgent(
  status: "open" | "all" = "open",
  fetchImpl: typeof fetch = fetch,
): Promise<UrgentItemDto[]> {
  return request(`/api/urgent?status=${status}`, undefined, fetchImpl);
}

export function setUrgentStatus(
  messageId: string,
  status: UrgencyStatusDto,
  fetchImpl: typeof fetch = fetch,
): Promise<{ messageId: string; status: UrgencyStatusDto }> {
  return request(
    `/api/urgent/${encodeURIComponent(messageId)}/status`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    },
    fetchImpl,
  );
}

export type ResolveDecisionDto = OutgoingResolveAction;

/** Requests approval to send the (edited) reply in the message's thread. */
export function requestUrgentReply(
  messageId: string,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ followupId: string; approvalId: string }> {
  return request(
    `/api/urgent/${encodeURIComponent(messageId)}/reply`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    },
    fetchImpl,
  );
}

export function resolveOutgoing(
  outgoingId: string,
  decision: ResolveDecisionDto,
  fetchImpl: typeof fetch = fetch,
): Promise<{ outgoingId: string; status: string }> {
  return request(
    `/api/outgoing/${encodeURIComponent(outgoingId)}/resolve`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision }),
    },
    fetchImpl,
  );
}

export type GroupedFlagsDto = GroupedFlags;

export type SecurityFlagDto = PersonFlag;

export type FlagReviewStatus = Exclude<FlagStatus, "open">;

export function getSecurityFlags(
  includeReviewed = false,
  fetchImpl: typeof fetch = fetch,
): Promise<GroupedFlagsDto[]> {
  return request(`/api/security/flags?includeReviewed=${includeReviewed}`, undefined, fetchImpl);
}

export function getPersonFlags(
  slackUserId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SecurityFlagDto[]> {
  return request(
    `/api/security/flags/person/${encodeURIComponent(slackUserId)}`,
    undefined,
    fetchImpl,
  );
}

export function reviewFlag(
  id: string,
  status: FlagReviewStatus,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string; status: FlagReviewStatus }> {
  return request(
    `/api/security/flags/${encodeURIComponent(id)}/review`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    },
    fetchImpl,
  );
}

export type PersonPriorityDto = "normal" | "high" | "critical";

export interface PersonDto {
  slackUserId: string;
  name: string | null;
  rationale: string | null;
  priority: PersonPriorityDto;
  extraAttention: boolean;
}

export function getPeople(fetchImpl: typeof fetch = fetch): Promise<PersonDto[]> {
  return request("/api/people", undefined, fetchImpl);
}

/** Replace semantics on the server: always send all three fields. */
export function setPersonPriority(
  slackUserId: string,
  input: { priority: PersonPriorityDto; rationale: string; extraAttention: boolean },
  fetchImpl: typeof fetch = fetch,
): Promise<{ slackUserId: string; priority: PersonPriorityDto; extraAttention: boolean }> {
  return request(
    `/api/people/${encodeURIComponent(slackUserId)}/priority`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
    fetchImpl,
  );
}

export interface SlackIdentityDto {
  selfUserId: string | null;
  suggestion: string | null;
  suggestionName: string | null;
}

export function getSlackIdentity(fetchImpl: typeof fetch = fetch): Promise<SlackIdentityDto> {
  return request("/api/slack/identity", undefined, fetchImpl);
}

export function confirmSlackIdentity(
  selfUserId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ selfUserId: string }> {
  return request(
    "/api/slack/identity",
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selfUserId }),
    },
    fetchImpl,
  );
}

export function getCandidates(
  limit = 50,
  fetchImpl: typeof fetch = fetch,
): Promise<CandidatesResponse> {
  return request(`/api/people/candidates?limit=${limit}`, undefined, fetchImpl);
}

export function getRecommendations(fetchImpl: typeof fetch = fetch): Promise<RecommendationView[]> {
  return request("/api/people/recommendations?status=pending", undefined, fetchImpl);
}

export function getPersonProfile(
  slackUserId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PersonDetail> {
  return request(`/api/people/${encodeURIComponent(slackUserId)}/profile`, undefined, fetchImpl);
}

/** 202 with `{queued, reason?}`: a refusal (identity, pending, already run) is data, not an error. */
export function evaluatePerson(
  slackUserId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<EvaluateResult> {
  return request(
    `/api/people/${encodeURIComponent(slackUserId)}/evaluate`,
    { method: "POST" },
    fetchImpl,
  );
}

export function acceptSuggestion(
  recommendationId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<EvaluateResult> {
  return request(
    `/api/people/recommendations/${encodeURIComponent(recommendationId)}/accept-suggestion`,
    { method: "POST" },
    fetchImpl,
  );
}

export function dismissSuggestion(
  recommendationId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ dismissed: boolean }> {
  return request(
    `/api/people/recommendations/${encodeURIComponent(recommendationId)}/dismiss`,
    { method: "POST" },
    fetchImpl,
  );
}

/** R6: removes a stuck recommendation; 409 when it is not stuck. */
export function discardRecommendation(
  recommendationId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ discarded: boolean }> {
  return request(
    `/api/people/recommendations/${encodeURIComponent(recommendationId)}/discard`,
    { method: "POST" },
    fetchImpl,
  );
}

export function retryApply(
  recommendationId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ approvalId: string }> {
  return request(
    `/api/people/recommendations/${encodeURIComponent(recommendationId)}/retry-apply`,
    { method: "POST" },
    fetchImpl,
  );
}

export type CommitmentViewDto = CommitmentView;
export type CommitmentFilterDto = CommitmentFilter;
export type CommitmentStatusDto = CommitmentStatus;
export type FollowupViewDto = FollowupView;

export interface CommitmentEditsDto {
  description?: string;
  dueAt?: string | null;
}

function postJson<T>(url: string, body: unknown, fetchImpl: typeof fetch): Promise<T> {
  return request(
    url,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    fetchImpl,
  );
}

export function getCommitments(
  filter: CommitmentFilterDto = "all",
  fetchImpl: typeof fetch = fetch,
): Promise<CommitmentViewDto[]> {
  return request(`/api/commitments?filter=${filter}`, undefined, fetchImpl);
}

export function reviewCommitment(
  id: string,
  decision: "accept" | "reject",
  edits?: CommitmentEditsDto,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true }> {
  return postJson(
    `/api/commitments/${encodeURIComponent(id)}/review`,
    edits ? { decision, edits } : { decision },
    fetchImpl,
  );
}

export function setCommitmentStatus(
  id: string,
  status: CommitmentStatusDto,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true }> {
  return postJson(`/api/commitments/${encodeURIComponent(id)}/status`, { status }, fetchImpl);
}

export function decideProposal(
  updateId: string,
  accept: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true }> {
  return postJson(
    `/api/commitments/proposals/${encodeURIComponent(updateId)}`,
    { accept },
    fetchImpl,
  );
}

export function draftFollowup(
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ queued: boolean }> {
  return request(
    `/api/commitments/${encodeURIComponent(id)}/draft-followup`,
    { method: "POST" },
    fetchImpl,
  );
}

export function getFollowups(fetchImpl: typeof fetch = fetch): Promise<FollowupViewDto[]> {
  return request("/api/followups", undefined, fetchImpl);
}

/** Requests approval to send the (edited) draft; nothing is sent until the user approves. */
export function sendFollowup(
  id: string,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ followupId: string; approvalId: string }> {
  return postJson(`/api/followups/${encodeURIComponent(id)}/send`, { text }, fetchImpl);
}

export function discardFollowup(
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true }> {
  return request(`/api/followups/${encodeURIComponent(id)}/discard`, { method: "POST" }, fetchImpl);
}

/** Phase 6b away mode (A17, A18). */
export interface AwayStatusDto {
  on: boolean;
  sessionId: string | null;
  startedAt: string | null;
}

export function getAway(fetchImpl: typeof fetch = fetch): Promise<AwayStatusDto> {
  return request("/api/away", undefined, fetchImpl);
}

export function setAway(on: boolean, fetchImpl: typeof fetch = fetch): Promise<AwayStatusDto> {
  return request(
    "/api/away",
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ on }),
    },
    fetchImpl,
  );
}

/** The most recently ended, undismissed away session, or null. */
export function getAwayDigest(fetchImpl: typeof fetch = fetch): Promise<AwayDigest | null> {
  return request("/api/away/digest", undefined, fetchImpl);
}

export function dismissAwayDigest(
  sessionId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  // The route answers 204 (no body).
  return request<void>(
    `/api/away/digest/${encodeURIComponent(sessionId)}/dismiss`,
    { method: "POST" },
    fetchImpl,
  );
}

export type JiraIssueViewDto = JiraIssueView;
export type JiraStatusDto = JiraStatusDtoContract;
export interface JiraSettingsDto {
  enabled?: boolean;
  scopeJql?: string;
  excludedProjects?: string[];
  cloudId?: string;
}

export function getJiraStatus(fetchImpl: typeof fetch = fetch): Promise<JiraStatusDto> {
  return request("/api/jira/status", undefined, fetchImpl);
}

export function getJiraIssues(
  view: JiraIssueViewKind = "all",
  fetchImpl: typeof fetch = fetch,
): Promise<JiraIssueViewDto[]> {
  return request(`/api/jira/issues?view=${view}`, undefined, fetchImpl);
}

export function getJiraIssue(
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<JiraIssueViewDto> {
  return request(`/api/jira/issues/${encodeURIComponent(key)}`, undefined, fetchImpl);
}

/** A 409 means Jira is disabled. */
export function requestJiraSync(
  fetchImpl: typeof fetch = fetch,
): Promise<{ jobId: string; type: string; created: boolean }> {
  return postJson("/api/jira/sync", {}, fetchImpl);
}

export function updateJiraSettings(
  patch: JiraSettingsDto,
  fetchImpl: typeof fetch = fetch,
): Promise<JiraStatusDto> {
  return request(
    "/api/jira/settings",
    { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) },
    fetchImpl,
  );
}

// ---- Engineering Brain (Phase 9, C12) ----

const JSON_HEADERS = { "content-type": "application/json" };

function send<T>(
  method: "POST" | "PUT",
  url: string,
  body: unknown,
  fetchImpl: typeof fetch,
): Promise<T> {
  return request(url, { method, headers: JSON_HEADERS, body: JSON.stringify(body) }, fetchImpl);
}

export function getRepositories(fetchImpl: typeof fetch = fetch): Promise<RepositoryView[]> {
  return request("/api/repos", undefined, fetchImpl);
}

/** Saves nothing; a refused path is an ApiError whose `code` is the reason. */
export function inspectRepositoryPath(
  path: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RepositoryProposal> {
  return send("POST", "/api/repos/inspect", { path }, fetchImpl);
}

export function registerRepository(
  input: RepositoryRegisterInput,
  fetchImpl: typeof fetch = fetch,
): Promise<RepositoryView> {
  return send("POST", "/api/repos", input, fetchImpl);
}

export function updateRepository(
  id: string,
  input: RepositoryUpdateInput,
  fetchImpl: typeof fetch = fetch,
): Promise<RepositoryView> {
  return send("PUT", `/api/repos/${encodeURIComponent(id)}`, input, fetchImpl);
}

/** Unregisters a repository (204); a refusal such as `repo_has_active_task` is an ApiError with a code. */
export function unregisterRepository(id: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  return request(`/api/repos/${encodeURIComponent(id)}`, { method: "DELETE" }, fetchImpl);
}

/** Queues an inspection; 409 (thrown, code `already_queued`) when one is already queued. */
export function inspectRepositoryNow(
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ jobId: string }> {
  return request(`/api/repos/${encodeURIComponent(id)}/inspect`, { method: "POST" }, fetchImpl);
}

export function acceptCurrentRemotes(
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RepositoryView> {
  return request(
    `/api/repos/${encodeURIComponent(id)}/accept-remotes`,
    { method: "POST" },
    fetchImpl,
  );
}

export function getProjects(fetchImpl: typeof fetch = fetch): Promise<ProjectView[]> {
  return request("/api/projects", undefined, fetchImpl);
}

export function getProject(id: string, fetchImpl: typeof fetch = fetch): Promise<ProjectDetail> {
  return request(`/api/projects/${encodeURIComponent(id)}`, undefined, fetchImpl);
}

/** A user-added fact is approved at once (C9). */
export function addProjectFact(
  projectId: string,
  input: { kind: ProjectFactView["kind"]; content: string },
  fetchImpl: typeof fetch = fetch,
): Promise<ProjectFactView> {
  return send("POST", `/api/projects/${encodeURIComponent(projectId)}/facts`, input, fetchImpl);
}

/** Approves a fact, optionally with edited content. */
export function acceptBrainFact(
  id: string,
  content?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProjectFactView> {
  return send(
    "POST",
    `/api/brain/facts/${encodeURIComponent(id)}/accept`,
    content === undefined ? {} : { content },
    fetchImpl,
  );
}

export function rejectBrainFact(
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProjectFactView> {
  return request(
    `/api/brain/facts/${encodeURIComponent(id)}/reject`,
    { method: "POST" },
    fetchImpl,
  );
}

export function createMilestone(
  projectId: string,
  input: Omit<MilestoneInput, "status"> & { status?: MilestoneInput["status"] },
  fetchImpl: typeof fetch = fetch,
): Promise<MilestoneView> {
  return send(
    "POST",
    `/api/projects/${encodeURIComponent(projectId)}/milestones`,
    input,
    fetchImpl,
  );
}

export function updateMilestone(
  projectId: string,
  id: string,
  input: MilestoneUpdateInput,
  fetchImpl: typeof fetch = fetch,
): Promise<MilestoneView> {
  return send(
    "PUT",
    `/api/projects/${encodeURIComponent(projectId)}/milestones/${encodeURIComponent(id)}`,
    input,
    fetchImpl,
  );
}

export function deleteMilestone(
  projectId: string,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  return request(
    `/api/projects/${encodeURIComponent(projectId)}/milestones/${encodeURIComponent(id)}`,
    { method: "DELETE" },
    fetchImpl,
  );
}

export function getUpcoming(fetchImpl: typeof fetch = fetch): Promise<UpcomingMilestone[]> {
  return request("/api/brain/upcoming", undefined, fetchImpl);
}

// ---- Engineering automation (Phase 10, E19) ----

export function getEngineeringTasks(
  status?: EngineeringTaskStatus,
  fetchImpl: typeof fetch = fetch,
): Promise<EngineeringTaskView[]> {
  const q = status ? `?status=${encodeURIComponent(status)}` : "";
  return request(`/api/engineering/tasks${q}`, undefined, fetchImpl);
}

/** The only read that carries the plan and step outputs (diff text, test tail). */
export function getEngineeringTask(
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<EngineeringTaskDetail> {
  return request(`/api/engineering/tasks/${encodeURIComponent(id)}`, undefined, fetchImpl);
}

export function createEngineeringTask(
  input: EngineeringTaskCreateInput,
  fetchImpl: typeof fetch = fetch,
): Promise<EngineeringTaskDetail> {
  return send("POST", "/api/engineering/tasks", input, fetchImpl);
}

/** A refusal (`ambiguous_repository`, `no_content`, ...) is an ApiError whose `code` is the reason. */
export function createTaskFromJira(
  key: string,
  repositoryId?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<EngineeringTaskDetail> {
  return send(
    "POST",
    "/api/engineering/tasks/from-jira",
    repositoryId ? { key, repositoryId } : { key },
    fetchImpl,
  );
}

export function createTaskFromSlack(
  messageId: string,
  repositoryId?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<EngineeringTaskDetail> {
  return send(
    "POST",
    "/api/engineering/tasks/from-slack",
    repositoryId ? { messageId, repositoryId } : { messageId },
    fetchImpl,
  );
}

export function approveTaskDescription(
  id: string,
  description: string,
  fetchImpl: typeof fetch = fetch,
): Promise<EngineeringTaskDetail> {
  return send(
    "POST",
    `/api/engineering/tasks/${encodeURIComponent(id)}/approve-description`,
    { description },
    fetchImpl,
  );
}

export interface PlanApprovalBody {
  parentBranch: string;
  testCommand: string;
  environmentId?: string;
  rememberAsTracked?: boolean;
}

export function approveTaskPlan(
  id: string,
  body: PlanApprovalBody,
  fetchImpl: typeof fetch = fetch,
): Promise<EngineeringTaskDetail> {
  return send(
    "POST",
    `/api/engineering/tasks/${encodeURIComponent(id)}/approve-plan`,
    body,
    fetchImpl,
  );
}

/** Saves edited commit or PR text on a pending approval; the API validates it. */
export function editEngineeringApproval(
  taskId: string,
  approvalId: string,
  edit: ApprovalTextEdit,
  fetchImpl: typeof fetch = fetch,
): Promise<Approval> {
  return send(
    "PUT",
    `/api/engineering/tasks/${encodeURIComponent(taskId)}/approvals/${encodeURIComponent(approvalId)}`,
    edit,
    fetchImpl,
  );
}

/** Asks for a new merge approval after failing checks; a refusal is an ApiError with a code. */
export function retryEngineeringMerge(
  taskId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<EngineeringTaskDetail> {
  return request(
    `/api/engineering/tasks/${encodeURIComponent(taskId)}/retry-merge`,
    { method: "POST" },
    fetchImpl,
  );
}

/** Queues the develop step again after a sandbox refusal; a refusal is an ApiError with a code. */
export function retryEngineeringDevelop(
  taskId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<EngineeringTaskDetail> {
  return request(
    `/api/engineering/tasks/${encodeURIComponent(taskId)}/retry-develop`,
    { method: "POST" },
    fetchImpl,
  );
}

export function cancelEngineeringTask(
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<EngineeringTaskDetail> {
  return request(
    `/api/engineering/tasks/${encodeURIComponent(id)}/cancel`,
    { method: "POST" },
    fetchImpl,
  );
}

export function requestCodeAnswer(
  messageId: string,
  repositoryId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ codeAnswerId: string }> {
  return send(
    "POST",
    `/api/inbox/messages/${encodeURIComponent(messageId)}/code-answer`,
    { repositoryId },
    fetchImpl,
  );
}

export function getCodeAnswers(
  messageId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CodeAnswerView[]> {
  return request(
    `/api/inbox/messages/${encodeURIComponent(messageId)}/code-answers`,
    undefined,
    fetchImpl,
  );
}

export function dismissCodeAnswer(id: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  return request(
    `/api/code-answers/${encodeURIComponent(id)}/dismiss`,
    { method: "POST" },
    fetchImpl,
  );
}

/** Requests approval for the (edited) answer; the backend refuses a suspected injection without `useAnyway`. */
export function sendCodeAnswer(
  id: string,
  text: string,
  useAnyway: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<{ outgoingId: string; approvalId: string }> {
  return send(
    "POST",
    `/api/code-answers/${encodeURIComponent(id)}/send`,
    { text, useAnyway },
    fetchImpl,
  );
}

/** Dashboard layouts (Phase 11, D5). The API normalises; the page renders what it returns. */
export function getLayouts(fetchImpl: typeof fetch = fetch): Promise<DashboardLayoutsResponse> {
  return request("/api/dashboard/layouts", undefined, fetchImpl);
}

export function createLayout(
  name: string,
  fromId?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DashboardLayoutView> {
  return send("POST", "/api/dashboard/layouts", { name, fromId }, fetchImpl);
}

export function updateLayout(
  id: string,
  patch: { name?: string; layout?: DashboardLayout },
  fetchImpl: typeof fetch = fetch,
): Promise<DashboardLayoutView> {
  return send("PUT", `/api/dashboard/layouts/${encodeURIComponent(id)}`, patch, fetchImpl);
}

export function activateLayout(
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DashboardLayoutsResponse> {
  return request(
    `/api/dashboard/layouts/${encodeURIComponent(id)}/activate`,
    { method: "POST" },
    fetchImpl,
  );
}

export function resetLayout(
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DashboardLayoutView> {
  return request(
    `/api/dashboard/layouts/${encodeURIComponent(id)}/reset`,
    { method: "POST" },
    fetchImpl,
  );
}

export async function deleteLayout(id: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  await request<void>(
    `/api/dashboard/layouts/${encodeURIComponent(id)}`,
    { method: "DELETE" },
    fetchImpl,
  );
}

export function getRuntime(fetchImpl: typeof fetch = fetch): Promise<RuntimeView> {
  return request("/api/system/runtime", undefined, fetchImpl);
}

export function getBackups(fetchImpl: typeof fetch = fetch): Promise<BackupEntry[]> {
  return request("/api/system/backups", undefined, fetchImpl);
}

/** 202 with the job id; 409 (`already_running`) when a manual backup is already queued or running. */
export function startBackup(fetchImpl: typeof fetch = fetch): Promise<{ jobId: string }> {
  return request("/api/system/backups", { method: "POST" }, fetchImpl, [202]);
}
