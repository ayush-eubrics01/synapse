import { expect, test } from "bun:test";
import {
  ApiError,
  acceptSuggestion,
  activateLayout,
  classifyOverviewFailure,
  confirmSlackIdentity,
  createLayout,
  decideApproval,
  deleteLayout,
  discardRecommendation,
  dismissAwayDigest,
  evaluatePerson,
  getAway,
  getAwayDigest,
  getCandidates,
  getClaudeRuns,
  getClaudeStatus,
  getConversations,
  getHealth,
  getInboxMessages,
  getJobs,
  getLayouts,
  getOverview,
  getPeople,
  getPersonFlags,
  getPersonProfile,
  getRecommendations,
  getSecurityFlags,
  getSlackIdentity,
  getSlackStatus,
  getThread,
  getUrgent,
  resetLayout,
  retryApply,
  reviewFlag,
  setAway,
  setPersonPriority,
  setUrgentStatus,
  startBackfill,
  unregisterRepository,
  updateLayout,
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

test("an HTTP error is an ApiError carrying the status, with the same message", async () => {
  const { impl } = fake(500, { error: "db locked" });
  const err = await getOverview(impl).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect(err).toBeInstanceOf(Error);
  expect((err as ApiError).status).toBe(500);
  expect((err as ApiError).message).toBe("GET /api/dashboard/overview failed with 500: db locked");
});

test("classifyOverviewFailure: a thrown fetch is a network failure, an ApiError is HTTP", async () => {
  const down = (async () => {
    throw new TypeError("Failed to fetch");
  }) as unknown as typeof fetch;
  const network = await getOverview(down).catch((e: unknown) => e);
  expect(classifyOverviewFailure(network)).toEqual({ kind: "network" });
  const http = await getOverview(fake(500, {}).impl).catch((e: unknown) => e);
  expect(classifyOverviewFailure(http)).toEqual({ kind: "http", status: 500 });
  expect(classifyOverviewFailure(new ApiError("x", 503))).toEqual({ kind: "http", status: 503 });
});

test("classifyOverviewFailure: a malformed 200 body is unexpected, not unreachable", async () => {
  expect(classifyOverviewFailure(new TypeError("fetch failed"))).toEqual({ kind: "network" });
  expect(classifyOverviewFailure(new ApiError("x", 500))).toEqual({ kind: "http", status: 500 });
  expect(classifyOverviewFailure(new SyntaxError("bad json"))).toEqual({ kind: "unexpected" });
  const bad = (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch;
  const rejected = await getOverview(bad).catch((e: unknown) => e);
  expect(rejected).toBeInstanceOf(Error);
  expect(classifyOverviewFailure(rejected)).toEqual({ kind: "unexpected" });
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
  await discardRecommendation("r1", f.impl);
  expect(f.calls.map((c) => `${c.init?.method ?? "GET"} ${c.url}`)).toEqual([
    "GET /api/people/candidates?limit=10",
    "GET /api/people/recommendations?status=pending",
    "GET /api/people/U1/profile",
    "POST /api/people/U1/evaluate",
    "POST /api/people/recommendations/r%201/accept-suggestion",
    "POST /api/people/recommendations/r1/retry-apply",
    "POST /api/people/recommendations/r1/discard",
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

test("getOverview reads the dashboard aggregate", async () => {
  const { calls, impl } = fake(200, { engineeringLock: { held: false } });
  expect((await getOverview(impl)).engineeringLock).toEqual({ held: false });
  expect(calls[0]?.url).toBe("/api/dashboard/overview");
  expect(calls[0]?.init?.method).toBeUndefined();
});

test("getConversations passes the limit, default 50", async () => {
  const a = fake(200, []);
  await getConversations(undefined, a.impl);
  expect(a.calls[0]?.url).toBe("/api/inbox/conversations?limit=50");
  const b = fake(200, []);
  await getConversations(20, b.impl);
  expect(b.calls[0]?.url).toBe("/api/inbox/conversations?limit=20");
});

test("getThread encodes the id and passes the limit", async () => {
  const a = fake(200, { conversation: { id: "D0ADA" }, messages: [] });
  expect((await getThread("D0ADA", undefined, a.impl)).messages).toEqual([]);
  expect(a.calls[0]?.url).toBe("/api/inbox/conversations/D0ADA/thread?limit=200");
  const b = fake(200, { conversation: { id: "C 1" }, messages: [] });
  await getThread("C 1", 30, b.impl);
  expect(b.calls[0]?.url).toBe("/api/inbox/conversations/C%201/thread?limit=30");
});

test("getThread throws on 404 with the server error", async () => {
  const { impl } = fake(404, { error: "conversation not found" });
  await expect(getThread("D0NONE", undefined, impl)).rejects.toThrow(/404.*conversation not found/);
});

test("getClaudeStatus exposes the quota thresholds", async () => {
  const thresholds = {
    fiveHour: { soft: 70, hard: 85, stop: 95 },
    sevenDay: { soft: 70, hard: 85 },
  };
  const { impl } = fake(200, {
    quota: null,
    thresholds,
    auth: { refreshExpiresAt: null, slides: null },
  });
  expect((await getClaudeStatus(impl)).thresholds).toEqual(thresholds);
});

test("away API URLs", async () => {
  const g = fake(200, { on: false, sessionId: null, startedAt: null });
  expect((await getAway(g.impl)).on).toBe(false);
  expect(g.calls[0]?.url).toBe("/api/away");
  const p = fake(200, { on: true, sessionId: "S1", startedAt: "2026-11-06T08:00:00Z" });
  await setAway(true, p.impl);
  expect(p.calls[0]?.url).toBe("/api/away");
  expect(p.calls[0]?.init?.method).toBe("PUT");
  expect(JSON.parse(String(p.calls[0]?.init?.body))).toEqual({ on: true });
  const d = fake(200, null);
  expect(await getAwayDigest(d.impl)).toBeNull();
  expect(d.calls[0]?.url).toBe("/api/away/digest");
  // The route answers 204 with no body: no JSON parse, no throw, resolves undefined.
  const calls: Call[] = [];
  const noContent = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  expect(await dismissAwayDigest("S 1", noContent)).toBeUndefined();
  expect(calls[0]?.url).toBe("/api/away/digest/S%201/dismiss");
  expect(calls[0]?.init?.method).toBe("POST");
  const bad = fake(500, { error: "boom" });
  await expect(setAway(true, bad.impl)).rejects.toThrow("failed with 500");
});

test("layout API URLs, methods and error codes", async () => {
  const g = fake(200, {});
  await getLayouts(g.impl);
  expect(g.calls[0]?.url).toBe("/api/dashboard/layouts");
  const c = fake(201, {});
  await createLayout("Focus", "L1", c.impl);
  expect(c.calls[0]?.init?.method).toBe("POST");
  expect(JSON.parse(String(c.calls[0]?.init?.body))).toEqual({ name: "Focus", fromId: "L1" });
  const u = fake(200, {});
  await updateLayout("L 1", { name: "Deep" }, u.impl);
  expect(u.calls[0]?.url).toBe("/api/dashboard/layouts/L%201");
  expect(u.calls[0]?.init?.method).toBe("PUT");
  const a = fake(200, {});
  const answer = { active: { id: "L1" }, layouts: [] };
  expect(await activateLayout("L1", fake(200, answer).impl)).toEqual(answer as never);
  await activateLayout("L1", a.impl);
  await resetLayout("L1", a.impl);
  expect(a.calls.map((x) => x.url)).toEqual([
    "/api/dashboard/layouts/L1/activate",
    "/api/dashboard/layouts/L1/reset",
  ]);
  const calls: Call[] = [];
  const noContent = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  expect(await deleteLayout("L2", noContent)).toBeUndefined();
  expect(calls[0]?.init?.method).toBe("DELETE");
  const bad = fake(409, { error: "active_layout" });
  await expect(deleteLayout("L1", bad.impl)).rejects.toMatchObject({
    status: 409,
    code: "active_layout",
  });
});

test("unregisterRepository DELETEs the repo and resolves undefined on 204", async () => {
  const calls: Call[] = [];
  const noContent = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  expect(await unregisterRepository("r1", noContent)).toBeUndefined();
  expect(calls[0]?.url).toBe("/api/repos/r1");
  expect(calls[0]?.init?.method).toBe("DELETE");
  const busy = fake(409, { error: "repo_has_active_task" });
  const err = await unregisterRepository("r1", busy.impl).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).code).toBe("repo_has_active_task");
});
