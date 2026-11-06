import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AIProvider, CodeAnswerView, ConversationThread } from "@synapse/contracts";
import { schema } from "@synapse/database";
import { eq } from "drizzle-orm";
import { createApp } from "../../src/app";
import { type Container, createContainer } from "../../src/container";
import { loadConfig } from "../../src/core/config/config";

const fakeProvider: AIProvider = {
  execute: async () => {
    throw new Error("fake provider must not execute");
  },
  getHealth: async () => ({ status: "ok", version: "fake" }),
};
const NOW = "2026-11-06T12:00:00.000Z";
const ANSWER = "ANSWER-MARKER it lives in src/a.ts";

let c: Container;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  c = createContainer(loadConfig({ SYNAPSE_DB_PATH: ":memory:" }), {
    run: async () => "Linger=no",
    provider: fakeProvider,
    clock: { now: () => new Date(NOW) },
  });
  app = createApp(c);
  c.db
    .insert(schema.repositories)
    .values({
      id: "repo-1",
      name: "demo-app",
      localPath: "/tmp/synapse-demo-app",
      upstreamPushDisabled: true,
      trackedBranch: "main",
      jiraProjectKeys: [],
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run();
  c.db
    .insert(schema.slackUsers)
    .values({ id: "su-1", externalId: "UPRIO00001", name: "Pat" })
    .run();
  c.db
    .insert(schema.slackConversations)
    .values({ id: "c-1", externalId: "C0CHAN0001", type: "channel", name: "dev" })
    .run();
  c.db
    .insert(schema.slackMessages)
    .values({
      id: "m1",
      conversationId: "c-1",
      ts: "1000.000100",
      threadTs: "999.000100",
      senderUserId: "su-1",
      text: "where is config loaded?",
      sentAt: "2026-11-06T11:00:00.000Z",
      collectedAt: NOW,
    })
    .run();
});
afterEach(() => c.sqlite.close());

const call = (path: string, init?: RequestInit) =>
  app.request(`http://127.0.0.1:7400${path}`, init);
const post = (path: string, body?: unknown) =>
  call(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const trigger = (messageId = "m1", repositoryId = "repo-1") =>
  post(`/api/inbox/messages/${messageId}/code-answer`, { repositoryId });
const rows = () => c.db.select().from(schema.codeAnswers).all();
const setStatus = (id: string, status: CodeAnswerView["status"], extra = {}) =>
  c.db
    .update(schema.codeAnswers)
    .set({ status, ...extra })
    .where(eq(schema.codeAnswers.id, id))
    .run();

async function ready(extra = {}): Promise<string> {
  const { codeAnswerId } = (await (await trigger()).json()) as { codeAnswerId: string };
  setStatus(codeAnswerId, "ready", { answer: ANSWER, confidence: 0.8, ...extra });
  return codeAnswerId;
}

describe("code answer routes", () => {
  test("POST enqueues one queued row and one single-attempt job", async () => {
    const r = await trigger();
    expect(r.status).toBe(202);
    const { codeAnswerId } = (await r.json()) as { codeAnswerId: string };
    expect(rows().map((x) => [x.id, x.status, x.trigger])).toEqual([
      [codeAnswerId, "queued", "user"],
    ]);
    const jobs = c.db
      .select()
      .from(schema.jobs)
      .all()
      .filter((j) => j.type === "code_answer.generate");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.maxAttempts).toBe(1);
    expect(jobs[0]?.input).toEqual({ codeAnswerId });
    const audit = c.db.select().from(schema.auditEvents).all();
    expect(audit.some((a) => a.action === "code_answer.requested" && a.actor === "user")).toBe(
      true,
    );
  });

  test("a second POST while queued is 409 already_running; a settled row is already_answered", async () => {
    await trigger();
    const again = await trigger();
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "already_running" });
    setStatus(rows()[0]?.id as string, "ready");
    const settled = await trigger();
    expect(settled.status).toBe(409);
    expect(await settled.json()).toEqual({ error: "already_answered" });
  });

  test("after the row failed, a POST makes a new row (retries replace failed rows)", async () => {
    await trigger();
    setStatus(rows()[0]?.id as string, "failed", { failure: "run_failed" });
    const r = await trigger();
    expect(r.status).toBe(202);
    expect(
      rows()
        .map((x) => x.status)
        .sort(),
    ).toEqual(["failed", "queued"]);
  });

  test("unknown message is 404, unknown repository is 400, a missing body is 400", async () => {
    const m = await trigger("nope");
    expect(m.status).toBe(404);
    expect(await m.json()).toEqual({ error: "not_found" });
    const r = await trigger("m1", "nope");
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "invalid_repository" });
    expect((await post("/api/inbox/messages/m1/code-answer", {})).status).toBe(400);
    expect(rows()).toHaveLength(0);
  });

  test("GET lists the message's rows with the repository name", async () => {
    await trigger();
    const list = (await (
      await call("/api/inbox/messages/m1/code-answers")
    ).json()) as CodeAnswerView[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      messageId: "m1",
      repositoryName: "demo-app",
      status: "queued",
    });
    expect(await (await call("/api/inbox/messages/other/code-answers")).json()).toEqual([]);
  });

  test("dismiss: ready is 204 and dismissed; queued is 409; unknown is 404", async () => {
    const id = await ready();
    const d = await post(`/api/code-answers/${id}/dismiss`);
    expect(d.status).toBe(204);
    expect(rows()[0]?.status).toBe("dismissed");
    expect(
      c.db
        .select()
        .from(schema.auditEvents)
        .all()
        .some((a) => a.action === "code_answer.dismissed"),
    ).toBe(true);
    const { codeAnswerId } = (await (await trigger()).json()) as { codeAnswerId: string };
    const q = await post(`/api/code-answers/${codeAnswerId}/dismiss`);
    expect(q.status).toBe(409);
    expect(await q.json()).toEqual({ error: "invalid_state" });
    expect((await post("/api/code-answers/nope/dismiss")).status).toBe(404);
  });

  test("send creates a slack.send approval and an outgoing row with the exact text, thread root and no tag", async () => {
    const id = await ready();
    const text = "Edited reply: see src/a.ts  ";
    const r = await post(`/api/code-answers/${id}/send`, { text });
    expect(r.status).toBe(200);
    const { outgoingId, approvalId } = (await r.json()) as {
      outgoingId: string;
      approvalId: string;
    };
    const approval = c.db
      .select()
      .from(schema.approvals)
      .where(eq(schema.approvals.id, approvalId))
      .get();
    expect(approval).toMatchObject({ action: "slack.send", status: "pending" });
    const out = c.db
      .select()
      .from(schema.outgoingMessages)
      .where(eq(schema.outgoingMessages.id, outgoingId))
      .get();
    expect(out).toMatchObject({
      text: text.trimEnd(),
      conversationExternalId: "C0CHAN0001",
      threadTs: "999.000100",
    });
    expect(out?.text).not.toContain("Sent using @claude");
    expect(rows()[0]).toMatchObject({ status: "sent", outgoingId });
    expect(
      c.db
        .select()
        .from(schema.auditEvents)
        .all()
        .some((a) => a.action === "code_answer.send_requested"),
    ).toBe(true);
    // Sent once: a second send is refused.
    expect((await post(`/api/code-answers/${id}/send`, { text })).status).toBe(409);
  });

  test("send refuses a non-sendable row, an empty text and an oversized text", async () => {
    const { codeAnswerId } = (await (await trigger()).json()) as { codeAnswerId: string };
    const q = await post(`/api/code-answers/${codeAnswerId}/send`, { text: "hi" });
    expect(q.status).toBe(409);
    expect(await q.json()).toEqual({ error: "invalid_state" });
    setStatus(codeAnswerId, "ready");
    const empty = await post(`/api/code-answers/${codeAnswerId}/send`, { text: "  " });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: "invalid_text" });
    expect(
      (await post(`/api/code-answers/${codeAnswerId}/send`, { text: "x".repeat(4001) })).status,
    ).toBe(400);
    expect(c.db.select().from(schema.outgoingMessages).all()).toHaveLength(0);
    expect((await post("/api/code-answers/nope/send", { text: "hi" })).status).toBe(404);
  });

  test("a detected injection needs useAnyway, enforced by the backend", async () => {
    const id = await ready({
      suspectedInjection: { detected: true, severity: "high", reason: "asks to leak", quote: "" },
    });
    const refused = await post(`/api/code-answers/${id}/send`, { text: "reply" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "injection_unacknowledged" });
    const explicit = await post(`/api/code-answers/${id}/send`, {
      text: "reply",
      useAnyway: false,
    });
    expect(explicit.status).toBe(409);
    expect(c.db.select().from(schema.outgoingMessages).all()).toHaveLength(0);
    expect(rows()[0]?.status).toBe("ready");
    const ok = await post(`/api/code-answers/${id}/send`, { text: "reply", useAnyway: true });
    expect(ok.status).toBe(200);
    expect(rows()[0]?.status).toBe("sent");
  });

  test("the thread DTO counts non-dismissed code answers", async () => {
    const before = (await (
      await call("/api/inbox/conversations/C0CHAN0001/thread")
    ).json()) as ConversationThread;
    expect(before.messages[0]?.codeAnswerCount).toBe(0);
    const id = await ready();
    const one = (await (
      await call("/api/inbox/conversations/C0CHAN0001/thread")
    ).json()) as ConversationThread;
    expect(one.messages[0]?.codeAnswerCount).toBe(1);
    await post(`/api/code-answers/${id}/dismiss`);
    const none = (await (
      await call("/api/inbox/conversations/C0CHAN0001/thread")
    ).json()) as ConversationThread;
    expect(none.messages[0]?.codeAnswerCount).toBe(0);
  });

  test("a held row without an outgoing sends; a held row with an outgoing is refused", async () => {
    const id = await ready();
    setStatus(id, "held");
    const ok = await post(`/api/code-answers/${id}/send`, { text: "reply" });
    expect(ok.status).toBe(200);
    expect(rows()[0]?.status).toBe("sent");
    const { outgoingId } = (await ok.json()) as { outgoingId: string };

    setStatus(id, "failed");
    const other = await ready();
    setStatus(other, "held", { outgoingId });
    const refused = await post(`/api/code-answers/${other}/send`, { text: "reply" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "invalid_state" });
    expect(c.db.select().from(schema.outgoingMessages).all()).toHaveLength(1);
  });

  test("dismiss works from held and unverified", async () => {
    for (const status of ["held", "unverified"] as const) {
      const id = await ready();
      setStatus(id, status);
      expect((await post(`/api/code-answers/${id}/dismiss`)).status).toBe(204);
      expect(rows().find((r) => r.id === id)?.status).toBe("dismissed");
    }
  });
});
