import type {
  Approval,
  ApprovalView,
  CandidatesResponse,
  CommitmentFilter,
  CommitmentStatus,
  CommitmentView,
  ConversationSummary,
  ConversationThread,
  DashboardOverview,
  EvaluateResult,
  FlagStatus,
  FollowupView,
  GroupedFlags,
  HealthReport,
  Job,
  OutgoingResolveAction,
  PersonDetail,
  PersonFlag,
  RecommendationView,
  UrgencyStatus,
  UrgentItem,
} from "@synapse/contracts";

async function request<T>(
  url: string,
  init: RequestInit | undefined,
  fetchImpl: typeof fetch,
  okStatuses: number[] = [],
): Promise<T> {
  const res = await fetchImpl(url, init);
  if (!res.ok && !okStatuses.includes(res.status)) {
    let detail = "";
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === "string") detail = `: ${body.error}`;
    } catch {
      // body was not JSON; the status alone is reported
    }
    throw new Error(`${init?.method ?? "GET"} ${url} failed with ${res.status}${detail}`);
  }
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
  permissionDenialCount: number;
  errorKind: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface ClaudeQuotaWindow {
  utilization: number;
  status: string;
  resetsAt?: string;
}

/** Utilization percentages at which the orchestrator gates jobs (ADR-029). */
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
