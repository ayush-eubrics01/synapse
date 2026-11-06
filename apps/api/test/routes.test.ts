import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { AIProvider } from "@synapse/contracts";
import { schema } from "@synapse/database";
import { createApp } from "../src/app";
import { type Container, createContainer } from "../src/container";
import { loadConfig } from "../src/core/config/config";

const fakeProvider: AIProvider = {
  execute: async () => {
    throw new Error("fake provider must not execute");
  },
  getHealth: async () => ({ status: "ok", version: "fake" }),
};

let c: Container;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  c = createContainer(loadConfig({ SYNAPSE_DB_PATH: ":memory:" }), {
    run: async () => "Linger=yes",
    provider: fakeProvider,
  });
  app = createApp(c);
});
afterEach(() => c.sqlite.close());

// Requests carry a loopback Host for the configured API port, as a real client's would.
const API = "http://127.0.0.1:7400";
const req = (path: string, init?: RequestInit) => app.request(`${API}${path}`, init);

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
  req(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

test("health live is 200", async () => {
  const res = await req("/health/live");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

test("health ready is 200 with a report", async () => {
  const res = await req("/health/ready");
  expect(res.status).toBe(200);
  const body = (await res.json()) as { status: string; checks: Record<string, unknown> };
  expect(Object.keys(body.checks).sort()).toEqual([
    "auth",
    "bun",
    "claude",
    "claude_activity",
    "database",
    "desktop-notifier",
    "events",
    "heartbeat",
    "jobs",
    "linger",
    "screening-rules",
    "security-rules",
  ]);
});

test("approve a pending approval, then approving again is 409", async () => {
  const a = pending();
  const list = await req("/api/approvals?status=pending");
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
  expect((await req("/api/jobs?limit=500")).status).toBe(400);
  expect((await req("/api/jobs?status=BOGUS")).status).toBe(400);
  const res = await req("/api/jobs?limit=5");
  expect(res.status).toBe(200);
  expect(Array.isArray(await res.json())).toBe(true);
});

test("jobs are listed newest first", async () => {
  const ids: string[] = [];
  for (const [i, priority] of [10, 500, 100].entries()) {
    ids.push(c.queue.enqueue(c.db, { type: "t", idempotencyKey: `order-${i}`, priority }).id);
    await Bun.sleep(2);
  }
  const res = await req("/api/jobs?limit=200");
  const listed = ((await res.json()) as { id: string }[]).map((j) => j.id);
  expect(listed.filter((id) => ids.includes(id))).toEqual([...ids].reverse());
});

test("worker pushes job.updated with id and status after a job settles", async () => {
  const t = createContainer(loadConfig({ SYNAPSE_DB_PATH: ":memory:" }), {
    run: async () => "Linger=yes",
    provider: fakeProvider,
    testHandlers: true,
  });
  try {
    const messages: unknown[] = [];
    t.live.subscribe((m) => messages.push(m));
    const { id } = t.queue.enqueue(t.db, { type: "test.noop", idempotencyKey: "live-1" });
    while (await t.worker.runOnce()) {}
    expect(messages).toContainEqual({ type: "job.updated", data: { id, status: "COMPLETED" } });
  } finally {
    t.sqlite.close();
  }
});

test("notifications list unread and mark read", async () => {
  const id = c.notifications.notify(c.db, { kind: "k", severity: "info", title: "t" });
  const unread = (await (await req("/api/notifications?unread=true")).json()) as {
    id: string;
  }[];
  expect(unread.map((x) => x.id)).toEqual([id]);
  expect((await post(`/api/notifications/${id}/read`)).status).toBe(200);
  expect(await (await req("/api/notifications?unread=true")).json()).toEqual([]);
});

test("unexpected errors are 500 with a generic body", async () => {
  const spy = spyOn(console, "error").mockImplementation(() => {});
  c.sqlite.close();
  let res: Response;
  try {
    res = await req("/api/jobs");
    expect(spy).toHaveBeenCalledTimes(1);
    const args = spy.mock.calls[0] ?? [];
    expect(args[0]).toBe("request failed:");
    expect(args[1]).toBe("GET");
    expect(args[2]).toBe("/api/jobs");
    expect(typeof args[3]).toBe("string");
  } finally {
    spy.mockRestore();
  }
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({ error: "internal error" });
  c = createContainer(loadConfig({ SYNAPSE_DB_PATH: ":memory:" }), { provider: fakeProvider });
});

test("SSE stream forwards notification events", async () => {
  const res = await req("/api/stream");
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

test("a foreign Host is 403 with a generic body", async () => {
  for (const host of ["evil.example:7400", "127.0.0.1:9999", "localhost", "evil.example"]) {
    const res = await req("/health/live", { headers: { host } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  }
  expect((await app.request("http://rebound.example:7400/api/jobs")).status).toBe(403);
});

test("loopback Hosts for the API port are allowed", async () => {
  for (const host of ["127.0.0.1:7400", "localhost:7400", "[::1]:7400", "LOCALHOST:7400"]) {
    expect((await req("/health/live", { headers: { host } })).status).toBe(200);
  }
});

test("requests proxied by the Next rewrite are checked by X-Forwarded-Host", async () => {
  const via = (forwarded: string) =>
    req("/api/jobs", { headers: { host: "127.0.0.1:7400", "x-forwarded-host": forwarded } });
  expect((await via("127.0.0.1:7401")).status).toBe(200);
  expect((await via("localhost:7401")).status).toBe(200);
  expect((await via("evil.example:7401")).status).toBe(403);
  expect((await via("")).status).toBe(403);
});

test("a foreign Origin on POST is 403; loopback web and API origins are allowed", async () => {
  const a = pending();
  const postFrom = (origin: string) =>
    req(`/api/approvals/${a.id}/reject`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: "{}",
    });
  for (const origin of ["http://evil.example", "null", "http://127.0.0.1:9999"]) {
    const res = await postFrom(origin);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  }
  expect(c.approvals.listPending().map((x) => x.id)).toContain(a.id);
  expect((await postFrom("http://127.0.0.1:7401")).status).toBe(200);
  const b = pending();
  const fromApi = await req(`/api/approvals/${b.id}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:7400" },
    body: "{}",
  });
  expect(fromApi.status).toBe(200);
  // GET is not origin-checked (a cross-origin page cannot read the response without CORS).
  expect((await req("/api/jobs", { headers: { origin: "http://evil.example" } })).status).toBe(200);
});

test("/api/claude/runs is newest first, limited, and has no content fields", async () => {
  for (const [i, status] of ["succeeded", "failed"].entries()) {
    c.db
      .insert(schema.claudeRuns)
      .values({
        id: `run-${i}`,
        workerProfile: "collector",
        model: "haiku",
        status,
        inputTokens: 5,
        permissionDenials: i === 1 ? ["Bash", "Write"] : [],
        error: i === 1 ? { kind: "timeout", message: "x" } : null,
        startedAt: `2026-01-01T00:00:0${i}.000Z`,
      })
      .run();
  }
  const rows = (await (await req("/api/claude/runs")).json()) as Record<string, unknown>[];
  expect(rows.map((r) => r.id)).toEqual(["run-1", "run-0"]);
  expect(Object.keys(rows[0] ?? {}).sort()).toEqual(
    [
      "id",
      "jobId",
      "workerProfile",
      "model",
      "status",
      "numTurns",
      "durationMs",
      "tokens",
      "costUsdEquivalent",
      "permissionDenialCount",
      "errorKind",
      "startedAt",
      "finishedAt",
    ].sort(),
  );
  expect(rows[0]?.permissionDenialCount).toBe(2);
  expect(rows[0]?.errorKind).toBe("timeout");
  expect(rows[1]?.errorKind).toBeNull();
  const one = (await (await req("/api/claude/runs?limit=1")).json()) as unknown[];
  expect(one).toHaveLength(1);
  expect((await req("/api/claude/runs?limit=0")).status).toBe(400);
  expect((await req("/api/claude/runs?limit=101")).status).toBe(400);
});

test("/api/claude/status is null quota on an empty db, computed level after a snapshot", async () => {
  const empty = (await (await req("/api/claude/status")).json()) as {
    quota: unknown;
    auth: { refreshExpiresAt: string | null; slides: boolean | null };
  };
  expect(empty.quota).toBeNull();
  expect(empty.auth.refreshExpiresAt).toBeNull();
  const future = new Date(Date.now() + 3_600_000).toISOString();
  c.db
    .insert(schema.quotaSnapshots)
    .values({
      id: "q1",
      observedAt: new Date().toISOString(),
      fiveHourUtilization: 0.7,
      fiveHourResetsAt: future,
      sevenDayUtilization: 0.1,
      sevenDayResetsAt: future,
      status: "allowed",
      fiveHourStatus: "allowed",
      sevenDayStatus: "allowed",
    })
    .run();
  const body = (await (await req("/api/claude/status")).json()) as {
    quota: { level: string; window: string; fiveHour: { utilization: number } };
  };
  expect(body.quota.level).toBe("soft");
  expect(body.quota.window).toBe("five_hour");
  expect(body.quota.fiveHour.utilization).toBe(0.7);
});

// --- inbox and slack routes ---

function seed(ts: string, conv = "C1", text = "hello") {
  c.inbox.persistPage("slack.messages", {
    messages: [
      {
        externalId: `${conv}:${ts}`,
        conversationId: conv,
        conversationType: "channel",
        conversationName: `name-${conv}`,
        ts,
        senderId: "U1",
        senderName: "Ada",
        text,
        sentAt: new Date(Number(ts) * 1000).toISOString(),
      },
    ],
    rejected: 0,
  });
}

type Msg = {
  conversation: { id: string; name: string | null; type: string };
  sender: { id: string; name: string | null };
  sentAt: string;
  text: string | null;
};

test("inbox messages: newest first, conversation filter, before, limit 0 is 400", async () => {
  seed("1700000100.000100", "C1");
  seed("1700000200.000100", "C2");
  seed("1700000300.000100", "C1");
  const all = (await (await req("/api/inbox/messages")).json()) as Msg[];
  expect(all.map((m) => m.sentAt)).toEqual([
    new Date(1700000300_000).toISOString(),
    new Date(1700000200_000).toISOString(),
    new Date(1700000100_000).toISOString(),
  ]);
  expect(all[0]?.conversation).toEqual({ id: "C1", name: "name-C1", type: "channel" });
  expect(all[0]?.sender).toEqual({ id: "U1", name: "Ada" });
  const c1 = (await (await req("/api/inbox/messages?conversationId=C1")).json()) as Msg[];
  expect(c1).toHaveLength(2);
  const before = (await (
    await req(`/api/inbox/messages?before=${new Date(1700000300_000).toISOString()}`)
  ).json()) as Msg[];
  expect(before).toHaveLength(2);
  const one = (await (await req("/api/inbox/messages?limit=1")).json()) as Msg[];
  expect(one).toHaveLength(1);
  expect((await req("/api/inbox/messages?limit=0")).status).toBe(400);
  expect((await req("/api/inbox/messages?limit=201")).status).toBe(400);
  expect((await req("/api/inbox/messages?before=yesterday")).status).toBe(400);
});

test("inbox messages: expired content has null text", async () => {
  seed("1700000100.000100");
  c.inbox.expireContent(0);
  const [m] = (await (await req("/api/inbox/messages")).json()) as Msg[];
  expect(m?.text).toBeNull();
});

test("slack status returns both streams and searchesToday for today (UTC) only", async () => {
  const today = c.clock.now().toISOString().slice(0, 10);
  c.sync.update(c.db, "slack.messages", { searchCount: 2, searchCountDate: today });
  c.sync.update(c.db, "slack.backfill", { searchCount: 3, searchCountDate: "2000-01-01" });
  const body = (await (await req("/api/slack/status")).json()) as {
    incremental: { stream: string };
    backfill: { stream: string; status: string };
    searchesToday: number;
  };
  expect(body.incremental.stream).toBe("slack.messages");
  expect(body.backfill.stream).toBe("slack.backfill");
  expect(body.backfill.status).toBe("idle");
  expect(body.searchesToday).toBe(2);
});

test("POST /api/slack/backfill starts once; a second call reports already running", async () => {
  const first = await post("/api/slack/backfill");
  expect(first.status).toBe(200);
  expect(((await first.json()) as { started: boolean }).started).toBe(true);
  const second = await post("/api/slack/backfill");
  expect(second.status).toBe(200);
  const body = (await second.json()) as { started: boolean; state: { status: string } };
  expect(body.started).toBe(false);
  expect(body.state.status).toBe("running");
});

test("R60 M4: backfill.resumable is true only when running with no live backfill job", async () => {
  type S = { backfill: { status: string; resumable: boolean } };
  const status = async () => ((await (await req("/api/slack/status")).json()) as S).backfill;
  expect((await status()).resumable).toBe(false); // idle
  await post("/api/slack/backfill");
  expect(await status()).toMatchObject({ status: "running", resumable: false }); // job PENDING
  c.db.update(schema.jobs).set({ status: "NEEDS_ATTENTION" }).run();
  expect(await status()).toMatchObject({ status: "running", resumable: true });
  const resumed = (await (await post("/api/slack/backfill")).json()) as { started: boolean };
  expect(resumed.started).toBe(true);
  expect((await status()).resumable).toBe(false);
});

test("health ready caches the claude provider health for 60 s", async () => {
  let calls = 0;
  const counting: AIProvider = {
    execute: fakeProvider.execute,
    getHealth: async () => {
      calls++;
      return { status: "ok", version: "fake" };
    },
  };
  c.sqlite.close();
  c = createContainer(loadConfig({ SYNAPSE_DB_PATH: ":memory:" }), {
    run: async () => "Linger=yes",
    provider: counting,
  });
  app = createApp(c);
  await req("/health/ready");
  const before = calls;
  await req("/health/ready");
  expect(calls).toBe(before);
  expect(calls).toBe(1);
});

test("inbox before: a row exactly at the boundary is excluded (offset form normalized)", async () => {
  seed("1700000100.000100");
  seed("1700000200.000100");
  const boundary = new Date(1700000200_000).toISOString();
  const offset = boundary.replace("Z", "+00:00");
  for (const b of [boundary, offset]) {
    const rows = (await (
      await req(`/api/inbox/messages?before=${encodeURIComponent(b)}`)
    ).json()) as Msg[];
    expect(rows.map((m) => m.sentAt)).toEqual([new Date(1700000100_000).toISOString()]);
  }
});

test("inbox conversationId must look like a Slack id", async () => {
  expect((await req("/api/inbox/messages?conversationId=bad%20id")).status).toBe(400);
  expect((await req("/api/inbox/messages?conversationId=c1")).status).toBe(400);
  expect((await req("/api/inbox/messages?conversationId=C1")).status).toBe(200);
});
