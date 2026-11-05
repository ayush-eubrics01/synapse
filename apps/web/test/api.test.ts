import { expect, test } from "bun:test";
import {
  acceptSuggestion,
  confirmSlackIdentity,
  decideApproval,
  evaluatePerson,
  getCandidates,
  getClaudeRuns,
  getClaudeStatus,
  getHealth,
  getInboxMessages,
  getJobs,
  getPeople,
  getPersonFlags,
  getPersonProfile,
  getRecommendations,
  getSecurityFlags,
  getSlackIdentity,
  getSlackStatus,
  getUrgent,
  retryApply,
  reviewFlag,
  setPersonPriority,
  setUrgentStatus,
  startBackfill,
} from "../lib/api";

type Call = { url: string; init?: RequestInit };

function fake(status: number, body: unknown): { calls: Call[]; impl: typeof fetch } {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

test("decideApproval POSTs the reason as JSON", async () => {
  const { calls, impl } = fake(200, { id: "a1", status: "rejected" });
  const result = await decideApproval("a1", "reject", "no", impl);
  expect(result.id).toBe("a1");
  expect(calls[0]?.url).toBe("/api/approvals/a1/reject");
  expect(calls[0]?.init?.method).toBe("POST");
  expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ reason: "no" });
});

test("non-2xx throws with status and error field", async () => {
  const { impl } = fake(409, { error: "invalid transition" });
  await expect(decideApproval("a1", "approve", undefined, impl)).rejects.toThrow(
    /409.*invalid transition/,
  );
});

test("non-2xx without a JSON body still includes the status", async () => {
  const impl = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
  await expect(getJobs(20, impl)).rejects.toThrow(/500/);
});

test("getJobs passes the limit; getHealth reads the report", async () => {
  const jobs = fake(200, []);
  await getJobs(20, jobs.impl);
  expect(jobs.calls[0]?.url).toBe("/api/jobs?limit=20");
  const health = fake(200, { status: "ok", checks: {} });
  expect((await getHealth(health.impl)).status).toBe("ok");
  expect(health.calls[0]?.url).toBe("/health/ready");
});

test("getClaudeStatus and getClaudeRuns call the claude routes", async () => {
  const status = fake(200, { quota: null, auth: { refreshExpiresAt: null, slides: null } });
  expect((await getClaudeStatus(status.impl)).quota).toBeNull();
  expect(status.calls[0]?.url).toBe("/api/claude/status");
  const runs = fake(200, []);
  expect(await getClaudeRuns(10, runs.impl)).toEqual([]);
  expect(runs.calls[0]?.url).toBe("/api/claude/runs?limit=10");
});

test("inbox and slack API URLs", async () => {
  const msgs = fake(200, []);
  await getInboxMessages(50, msgs.impl);
  expect(msgs.calls[0]?.url).toBe("/api/inbox/messages?limit=50");
  const status = fake(200, { incremental: {}, backfill: {}, searchesToday: 0 });
  await getSlackStatus(status.impl);
  expect(status.calls[0]?.url).toBe("/api/slack/status");
  const bf = fake(200, { started: true, state: {} });
  await startBackfill(bf.impl);
  expect(bf.calls[0]?.url).toBe("/api/slack/backfill");
  expect(bf.calls[0]?.init?.method).toBe("POST");
});

test("urgency, security, people and identity API URLs", async () => {
  const body = (c: { init?: RequestInit }) => JSON.parse(String(c.init?.body));
  const u = fake(200, []);
  await getUrgent("open", u.impl);
  expect(u.calls[0]?.url).toBe("/api/urgent?status=open");
  const st = fake(200, {});
  await setUrgentStatus("m 1", "resolved", st.impl);
  expect(st.calls[0]?.url).toBe("/api/urgent/m%201/status");
  expect(st.calls[0]?.init?.method).toBe("POST");
  expect(body(st.calls[0] as Call)).toEqual({ status: "resolved" });
  const f = fake(200, []);
  await getSecurityFlags(false, f.impl);
  await getPersonFlags("U1", f.impl);
  expect(f.calls.map((x) => x.url)).toEqual([
    "/api/security/flags?includeReviewed=false",
    "/api/security/flags/person/U1",
  ]);
  const r = fake(200, {});
  await reviewFlag("f1", "contacted", r.impl);
  expect(r.calls[0]?.url).toBe("/api/security/flags/f1/review");
  expect(body(r.calls[0] as Call)).toEqual({ status: "contacted" });
  const p = fake(200, []);
  await getPeople(p.impl);
  expect(p.calls[0]?.url).toBe("/api/people");
  const sp = fake(200, {});
  await setPersonPriority(
    "U1",
    { priority: "high", rationale: "", extraAttention: false },
    sp.impl,
  );
  expect(sp.calls[0]?.url).toBe("/api/people/U1/priority");
  expect(sp.calls[0]?.init?.method).toBe("PUT");
  expect(body(sp.calls[0] as Call)).toEqual({
    priority: "high",
    rationale: "",
    extraAttention: false,
  });
  const id = fake(200, { selfUserId: null, suggestion: null, suggestionName: null });
  await getSlackIdentity(id.impl);
  await confirmSlackIdentity("U1", id.impl);
  expect(id.calls.map((x) => x.url)).toEqual(["/api/slack/identity", "/api/slack/identity"]);
  expect(id.calls[1]?.init?.method).toBe("PUT");
  expect(body(id.calls[1] as Call)).toEqual({ selfUserId: "U1" });
});

test("people profile calls hit the expected endpoints", async () => {
  const f = fake(200, { queued: true });
  await getCandidates(10, f.impl);
  await getRecommendations(f.impl);
  await getPersonProfile("U1", f.impl);
  await evaluatePerson("U1", f.impl);
  await acceptSuggestion("r 1", f.impl);
  await retryApply("r1", f.impl);
  expect(f.calls.map((c) => `${c.init?.method ?? "GET"} ${c.url}`)).toEqual([
    "GET /api/people/candidates?limit=10",
    "GET /api/people/recommendations?status=pending",
    "GET /api/people/U1/profile",
    "POST /api/people/U1/evaluate",
    "POST /api/people/recommendations/r%201/accept-suggestion",
    "POST /api/people/recommendations/r1/retry-apply",
  ]);
});

test("evaluatePerson returns a refusal as data and a 409 retry as an error", async () => {
  const refused = fake(202, { queued: false, reason: "identity_required" });
  expect(await evaluatePerson("U1", refused.impl)).toEqual({
    queued: false,
    reason: "identity_required",
  });
  const conflict = fake(409, { error: "apply retry not allowed" });
  await expect(retryApply("r1", conflict.impl)).rejects.toThrow("409: apply retry not allowed");
});
