import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  AIProvider,
  ApprovalView,
  MessageSink,
  SendMessageCommand,
  SendResult,
  UrgentItem,
} from "@synapse/contracts";
import { schema } from "@synapse/database";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app";
import { type Container, createContainer } from "../src/container";
import { loadConfig } from "../src/core/config/config";

const fakeProvider: AIProvider = {
  execute: async () => {
    throw new Error("fake provider must not execute");
  },
  getHealth: async () => ({ status: "ok", version: "fake" }),
};
const NOW = "2026-11-06T12:00:00.000Z";
const SECRET = "SECRET-REPLY-TEXT on it";
const SENDER = "UTHEM00001";

class FakeSink implements MessageSink {
  sends: SendMessageCommand[] = [];
  result: SendResult = { status: "sent_unverified" };
  async send(cmd: SendMessageCommand): Promise<SendResult> {
    this.sends.push(cmd);
    return this.result;
  }
  async findSent(): Promise<boolean | null> {
    return false;
  }
}

let c: Container;
let app: ReturnType<typeof createApp>;
let sink: FakeSink;
let logs: string[];
const realError = console.error;

beforeEach(() => {
  logs = [];
  console.error = (...a: unknown[]) => logs.push(a.join(" "));
  sink = new FakeSink();
  c = createContainer(loadConfig({ SYNAPSE_DB_PATH: ":memory:" }), {
    run: async () => "Linger=yes",
    provider: fakeProvider,
    sink,
  });
  app = createApp(c);
  c.db.insert(schema.slackUsers).values({ id: "u1", externalId: SENDER, name: "Grace" }).run();
  c.db
    .insert(schema.slackConversations)
    .values({ id: "c1", externalId: "C0SYNTH01", type: "channel", name: "ops" })
    .run();
});
afterEach(() => {
  console.error = realError;
  c.sqlite.close();
});

const req = (path: string, init?: RequestInit) => app.request(`http://127.0.0.1:7400${path}`, init);
const post = (path: string, body?: unknown) =>
  req(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
const urgentItems = async () => (await (await req("/api/urgent")).json()) as UrgentItem[];
const approvals = async () =>
  (await (await req("/api/approvals?status=pending")).json()) as ApprovalView[];

function message(o: Partial<typeof schema.slackMessages.$inferInsert> = {}): string {
  const id = o.id ?? "m1";
  c.db
    .insert(schema.slackMessages)
    .values({
      id,
      conversationId: "c1",
      ts: "1793880000.000100",
      senderUserId: "u1",
      text: "server is down",
      sentAt: NOW,
      collectedAt: NOW,
      urgencyLevel: "high",
      urgencyReason: "outage",
      ...o,
    })
    .run();
  return id;
}
const reply = (id: string, text = SECRET, extra: object = {}) =>
  post(`/api/urgent/${id}/reply`, { text, ...extra });
const outgoingRow = () => c.db.select().from(schema.outgoingMessages).get();

describe("urgent reply", () => {
  test("creates a followup, an outgoing message and an approval; nothing is sent", async () => {
    const id = message({ threadTs: "1793879000.000050" });
    const res = await reply(id);
    expect(res.status).toBe(200);
    const { followupId, approvalId } = (await res.json()) as {
      followupId: string;
      approvalId: string;
    };
    const f = c.db.select().from(schema.followups).where(eq(schema.followups.id, followupId)).get();
    expect(f).toMatchObject({
      origin: "urgent_reply",
      originMessageId: id,
      conversationId: "C0SYNTH01",
      threadTs: "1793879000.000050",
      recipientSlackUserId: SENDER,
      draftText: SECRET,
      status: "awaiting_approval",
      approvalId,
    });
    expect(outgoingRow()).toMatchObject({ status: "pending", text: SECRET, approvalId });
    expect(sink.sends).toHaveLength(0);
    const [item] = await urgentItems();
    expect(item?.reply).toMatchObject({
      followupId,
      approvalId,
      outgoingStatus: "pending",
      actions: [],
    });
  });

  test("thread_ts falls back to the message ts; trailing whitespace is trimmed", async () => {
    const id = message();
    await reply(id, `${SECRET}  \n`);
    expect(outgoingRow()).toMatchObject({ threadTs: "1793880000.000100", text: SECRET });
  });

  test("the approval view shows the exact text, recipient and conversation (H4)", async () => {
    const id = message();
    await reply(id);
    const [a] = await approvals();
    expect(a?.outgoing).toEqual({
      text: SECRET,
      recipientName: "Grace",
      conversationLabel: "#ops",
      threadReply: true,
    });
    // Text only in route responses: not in events, audit rows, notifications or logs.
    const rest = JSON.stringify([
      c.db.select().from(schema.domainEvents).all(),
      c.db.select().from(schema.auditEvents).all(),
      c.db.select().from(schema.notifications).all(),
      logs,
    ]);
    expect(rest).not.toContain(SECRET);
  });

  test("DM and group DM labels", async () => {
    c.db.update(schema.slackConversations).set({ type: "im", name: null }).run();
    await reply(message());
    expect((await approvals())[0]?.outgoing?.conversationLabel).toBe("a DM");
    c.db.update(schema.slackConversations).set({ type: "mpim" }).run();
    expect((await approvals())[0]?.outgoing?.conversationLabel).toBe("a group DM");
  });

  test("a second request while one is live is 409", async () => {
    const id = message();
    expect((await reply(id)).status).toBe(200);
    expect((await reply(id, "other")).status).toBe(409);
    expect(c.db.select().from(schema.outgoingMessages).all()).toHaveLength(1);
  });

  test("unknown or non-urgent message is 404; bad text is 400", async () => {
    expect((await reply("nope")).status).toBe(404);
    const low = message({ id: "low", urgencyLevel: "low", ts: "1.0" });
    expect((await reply(low)).status).toBe(404);
    const id = message();
    expect((await reply(id, "")).status).toBe(400);
    expect((await reply(id, "   ")).status).toBe(400);
    expect((await reply(id, "x".repeat(4001))).status).toBe(400);
    expect((await reply(id, "x".repeat(4000))).status).toBe(200);
  });

  test("expired message text is 409 unless allowNoThread, then it posts without a thread", async () => {
    const id = message({ text: null, contentExpiredAt: NOW });
    expect((await reply(id)).status).toBe(409);
    expect(c.db.select().from(schema.outgoingMessages).all()).toHaveLength(0);
    expect((await reply(id, SECRET, { allowNoThread: true })).status).toBe(200);
    expect(outgoingRow()?.threadTs).toBeNull();
    expect((await approvals())[0]?.outgoing?.threadReply).toBe(false);
  });

  test("approve then execute: the sink gets the exact text and the list shows sent_unverified", async () => {
    const id = message();
    const { approvalId } = (await (await reply(id)).json()) as { approvalId: string };
    expect(sink.sends).toHaveLength(0);
    expect((await post(`/api/approvals/${approvalId}/approve`)).status).toBe(200);
    expect(sink.sends).toHaveLength(0); // approval alone does not send until the job runs
    await c.approvals.execute(approvalId);
    expect(sink.sends).toHaveLength(1);
    expect(sink.sends[0]).toMatchObject({ conversationExternalId: "C0SYNTH01", text: SECRET });
    const [item] = await urgentItems();
    expect(item?.reply).toMatchObject({ outgoingStatus: "sent_unverified", status: "sent" });
    expect((await reply(id, "again")).status).toBe(409);
  });

  test("revoke returns the draft: nothing sent, re-request allowed on the same followup", async () => {
    const id = message();
    const first = (await (await reply(id)).json()) as { followupId: string; approvalId: string };
    await post(`/api/approvals/${first.approvalId}/approve`);
    expect((await post(`/api/approvals/${first.approvalId}/revoke`)).status).toBe(200);
    c.dispatcher.dispatchOnce();
    await c.approvals.execute(first.approvalId);
    expect(sink.sends).toHaveLength(0);
    const [item] = await urgentItems();
    expect(item?.reply).toMatchObject({
      status: "draft",
      outgoingStatus: "failed",
      canRequest: true,
    });
    const second = (await (await reply(id, "edited")).json()) as { followupId: string };
    expect(second.followupId).toBe(first.followupId);
    expect(c.db.select().from(schema.followups).all()).toHaveLength(1);
  });

  test("needs_attention lists the resolve actions and POST /api/outgoing/:id/resolve acts", async () => {
    const id = message();
    const { approvalId } = (await (await reply(id)).json()) as { approvalId: string };
    await post(`/api/approvals/${approvalId}/approve`);
    sink.result = { status: "uncertain" } as unknown as SendResult;
    await c.approvals.execute(approvalId);
    const out = outgoingRow();
    c.db
      .update(schema.outgoingMessages)
      .set({ status: "needs_attention", failure: "uncertain_outcome" })
      .run();
    const [item] = await urgentItems();
    expect(item?.reply?.actions).toEqual(["mark_sent", "resend", "discard"]);
    expect((await post(`/api/outgoing/${out?.id}/resolve`, { decision: "bogus" })).status).toBe(
      400,
    );
    expect((await post("/api/outgoing/nope/resolve", { decision: "discard" })).status).toBe(404);
    expect((await post(`/api/outgoing/${out?.id}/resolve`, { decision: "mark_sent" })).status).toBe(
      200,
    );
    expect((await urgentItems())[0]?.reply).toMatchObject({ outgoingStatus: "sent", actions: [] });
    expect((await post(`/api/outgoing/${out?.id}/resolve`, { decision: "mark_sent" })).status).toBe(
      409,
    );
  });

  test("exhausted sent_unverified offers mark_sent and discard only", async () => {
    const id = message();
    await reply(id);
    c.db
      .update(schema.outgoingMessages)
      .set({ status: "sent_unverified", failure: "unverified" })
      .run();
    expect((await urgentItems())[0]?.reply?.actions).toEqual(["mark_sent", "discard"]);
    const out = outgoingRow();
    expect((await post(`/api/outgoing/${out?.id}/resolve`, { decision: "resend" })).status).toBe(
      409,
    );
  });
});
