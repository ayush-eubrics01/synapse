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
