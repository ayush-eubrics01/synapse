import { afterEach, beforeEach, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { type Container, createContainer } from "../src/container";
import { loadConfig } from "../src/core/config/config";

let c: Container;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  c = createContainer(loadConfig({ SYNAPSE_DB_PATH: ":memory:" }), {
    run: async () => "Linger=yes",
  });
  app = createApp(c);
});
afterEach(() => c.sqlite.close());

let n = 0;
function pending() {
  n++;
  return c.approvals.request(c.db, {
    action: "slack.send",
    targetIntegration: "slack",
    targetRef: "C1/1",
    payload: { text: "hi" },
    riskLevel: "medium",
    idempotencyKey: `route-${n}`,
    requestedByModule: "inbox",
  });
}

const post = (path: string, body?: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

test("health live is 200", async () => {
  const res = await app.request("/health/live");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

test("health ready is 200 with a report", async () => {
  const res = await app.request("/health/ready");
  expect(res.status).toBe(200);
  const body = (await res.json()) as { status: string; checks: Record<string, unknown> };
  expect(Object.keys(body.checks).sort()).toEqual([
    "bun",
    "database",
    "heartbeat",
    "jobs",
    "linger",
  ]);
});

test("approve a pending approval, then approving again is 409", async () => {
  const a = pending();
  const list = await app.request("/api/approvals?status=pending");
  expect(((await list.json()) as { id: string }[]).map((x) => x.id)).toContain(a.id);
  const res = await post(`/api/approvals/${a.id}/approve`, {});
  expect(res.status).toBe(200);
  expect(((await res.json()) as { status: string }).status).toBe("approved");
  expect((await post(`/api/approvals/${a.id}/approve`, {})).status).toBe(409);
});

test("unknown approval id is 404", async () => {
  expect((await post("/api/approvals/nope/approve", {})).status).toBe(404);
});

test("reject with an empty body is 400; with a reason is 200", async () => {
  const a = pending();
  expect((await post(`/api/approvals/${a.id}/reject`)).status).toBe(400);
  const res = await post(`/api/approvals/${a.id}/reject`, { reason: "no" });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { status: string }).status).toBe("rejected");
});

test("jobs limit over 200 is 400, valid limit is 200", async () => {
  expect((await app.request("/api/jobs?limit=500")).status).toBe(400);
  expect((await app.request("/api/jobs?status=BOGUS")).status).toBe(400);
  const res = await app.request("/api/jobs?limit=5");
  expect(res.status).toBe(200);
  expect(Array.isArray(await res.json())).toBe(true);
});

test("notifications list unread and mark read", async () => {
  const id = c.notifications.notify(c.db, { kind: "k", severity: "info", title: "t" });
  const unread = (await (await app.request("/api/notifications?unread=true")).json()) as {
    id: string;
  }[];
  expect(unread.map((x) => x.id)).toEqual([id]);
  expect((await post(`/api/notifications/${id}/read`)).status).toBe(200);
  expect(await (await app.request("/api/notifications?unread=true")).json()).toEqual([]);
});

test("unexpected errors are 500 with a generic body", async () => {
  c.sqlite.close();
  const res = await app.request("/api/jobs");
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({ error: "internal error" });
  c = createContainer(loadConfig({ SYNAPSE_DB_PATH: ":memory:" }));
});

test("SSE stream forwards notification events", async () => {
  const res = await app.request("/api/stream");
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const reader = res.body?.getReader();
  if (!reader) throw new Error("no body");
  await Bun.sleep(20);
  c.notifications.notify(c.db, { kind: "k", severity: "high", title: "hello" });
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 3000;
  while (!text.includes("data:") && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  await reader.cancel();
  expect(text).toContain("event: notification");
  expect(text).toContain('"title":"hello"');
});
