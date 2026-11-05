import type { Approval, HealthReport, Job } from "@synapse/contracts";

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

export function getApprovals(fetchImpl: typeof fetch = fetch): Promise<Approval[]> {
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

export interface ClaudeStatus {
  quota: {
    level: "ok" | "soft" | "hard" | "stop";
    window: "five_hour" | "seven_day" | null;
    resetsAt: string | null;
    fiveHour?: ClaudeQuotaWindow;
    sevenDay?: ClaudeQuotaWindow;
  } | null;
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

export function getSlackStatus(fetchImpl: typeof fetch = fetch): Promise<SlackStatusDto> {
  return request("/api/slack/status", undefined, fetchImpl);
}

export function startBackfill(
  fetchImpl: typeof fetch = fetch,
): Promise<{ started: boolean; state: SlackSyncState }> {
  return request("/api/slack/backfill", { method: "POST" }, fetchImpl);
}

export type UrgencyStatusDto = "new" | "acknowledged" | "in_progress" | "resolved" | "dismissed";

export interface UrgentItemDto {
  messageId: string;
  level: "critical" | "high" | "medium" | "low";
  reason: string;
  status: UrgencyStatusDto;
  /** Computed by the server; the UI shows exactly these buttons. */
  allowedTransitions: UrgencyStatusDto[];
  assessed: boolean;
  fallback: boolean;
  sender: { id: string; name: string | null };
  conversation: { id: string; name: string | null; type: string };
  sentAt: string;
  text: string | null;
  permalink: string | null;
  draft: { text: string | null; confidence: number } | null;
}

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

export interface GroupedFlagsDto {
  slackUserId: string;
  name: string;
  openCount: number;
  maxSeverity: "info" | "warning" | "high";
  latestOpenId: string | null;
  latest: {
    id: string;
    excerpt: string;
    detector: string;
    createdAt: string;
    permalink: string | null;
  };
}

export interface SecurityFlagDto {
  id: string;
  severity: "info" | "warning" | "high";
  status: "open" | "acknowledged" | "contacted" | "dismissed";
  detector: string;
  excerpt: string;
  createdAt: string;
}

export type FlagReviewStatus = "acknowledged" | "contacted" | "dismissed";

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
