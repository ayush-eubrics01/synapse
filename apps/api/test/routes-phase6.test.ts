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
      // R15: the internal slack_conversations.id, not the external id.
      conversationId: "c1",
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

// ---------------------------------------------------------------------------------------------
// Task 9: commitments, follow-up drafts
const SELF = "USELF00001";
const DRAFT = "SECRET-DRAFT-TEXT please share status";
const DESCRIPTION = "SECRET-COMMITMENT-DESC ship the report";
let seq = 0;

function commitmentRow(o: Partial<typeof schema.commitments.$inferInsert> = {}): string {
  const id = o.id ?? `cm${++seq}`;
  c.db
    .insert(schema.commitments)
    .values({
      id,
      description: DESCRIPTION,
      ownerSlackUserId: SENDER,
      counterpartySlackUserId: SELF,
      direction: "theirs",
      status: "open",
      reviewStatus: "accepted",
      dedupKey: `k${id}`,
      createdAt: NOW,
      updatedAt: NOW,
      ...o,
    })
    .run();
  return id;
}

function followupRow(o: Partial<typeof schema.followups.$inferInsert> = {}): string {
  const id = o.id ?? `fu${++seq}`;
  c.db
    .insert(schema.followups)
    .values({
      id,
      origin: "stalled",
      // The internal slack_conversations.id, not the external id.
      conversationId: "c1",
      threadTs: "1793879000.000050",
      recipientSlackUserId: SENDER,
      draftText: DRAFT,
      confidence: 0.7,
      status: "draft",
      createdAt: NOW,
      updatedAt: NOW,
      ...o,
    })
    .run();
  return id;
}
const followupViews = async (qs = "") =>
  (await (await req(`/api/followups${qs}`)).json()) as import("@synapse/contracts").FollowupView[];
const commitmentViews = async (qs = "") =>
  (await (
    await req(`/api/commitments${qs}`)
  ).json()) as import("@synapse/contracts").CommitmentView[];

describe("commitments routes", () => {
  test("list by filter returns server-computed actions", async () => {
    const pending = commitmentRow({ reviewStatus: "pending_review" });
    const open = commitmentRow();
    expect((await commitmentViews("?filter=review")).map((v) => [v.id, v.actions])).toEqual([
      [pending, ["accept", "reject", "edit"]],
    ]);
    const [v] = await commitmentViews("?filter=theirs");
    expect(v).toMatchObject({
      id: open,
      actions: ["start", "block", "complete", "cancel", "draft_followup"],
    });
    // owed by the user (mine): no manual follow-up draft
    const mine = commitmentRow({
      direction: "mine",
      ownerSlackUserId: SELF,
      counterpartySlackUserId: SENDER,
    });
    expect((await commitmentViews("?filter=mine"))[0]).toMatchObject({
      id: mine,
      actions: ["start", "block", "complete", "cancel"],
    });
    expect((await req("/api/commitments?filter=bogus")).status).toBe(400);
  });

  test("review: accept with edits, then 409 when no longer pending, 404 unknown", async () => {
    const id = commitmentRow({ reviewStatus: "pending_review" });
    const res = await post(`/api/commitments/${id}/review`, {
      decision: "accept",
      edits: { description: "edited" },
    });
    expect(res.status).toBe(200);
    expect((await commitmentViews("?filter=all"))[0]).toMatchObject({
      id,
      description: "edited",
      reviewStatus: "accepted",
    });
    expect((await post(`/api/commitments/${id}/review`, { decision: "reject" })).status).toBe(409);
    expect((await post("/api/commitments/nope/review", { decision: "accept" })).status).toBe(404);
    const other = commitmentRow({ reviewStatus: "pending_review" });
    expect(
      (
        await post(`/api/commitments/${other}/review`, {
          decision: "reject",
          edits: { dueAt: null },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await post(`/api/commitments/${other}/review`, {
          decision: "accept",
          edits: { owner: "x" },
        })
      ).status,
    ).toBe(400);
    c.settings.set("slack.selfUserId", SELF);
    expect(
      (
        await post(`/api/commitments/${other}/review`, {
          decision: "accept",
          edits: { owner: "UOTHER0002", counterparty: "UOTHER0003" },
        })
      ).status,
    ).toBe(409);
  });

  test("status: transition, 409 for an illegal one, 404 unknown", async () => {
    const id = commitmentRow();
    expect((await post(`/api/commitments/${id}/status`, { status: "in_progress" })).status).toBe(
      200,
    );
    expect((await commitmentViews("?filter=in_progress"))[0]?.id).toBe(id);
    await post(`/api/commitments/${id}/status`, { status: "completed" });
    expect((await post(`/api/commitments/${id}/status`, { status: "open" })).status).toBe(409);
    expect((await post("/api/commitments/nope/status", { status: "open" })).status).toBe(404);
    expect((await post(`/api/commitments/${id}/status`, { status: "weird" })).status).toBe(400);
    const unreviewed = commitmentRow({ reviewStatus: "pending_review" });
    expect(
      (await post(`/api/commitments/${unreviewed}/status`, { status: "blocked" })).status,
    ).toBe(409);
  });

  test("proposal: confirm completes, a second decision is 409, unknown is 404", async () => {
    const id = commitmentRow();
    c.db
      .insert(schema.commitmentUpdates)
      .values({
        id: "up1",
        commitmentId: id,
        actor: "ai",
        field: "status",
        toValue: "completed",
        reason: "proposed:D1:123.456",
        createdAt: NOW,
      })
      .run();
    const [v] = await commitmentViews("?filter=all");
    expect(v?.proposals).toHaveLength(1);
    expect(v?.actions).toContain("confirm_proposal");
    expect((await post("/api/commitments/proposals/up1", { accept: true })).status).toBe(200);
    expect((await commitmentViews("?filter=closed"))[0]?.status).toBe("completed");
    expect((await post("/api/commitments/proposals/up1", { accept: false })).status).toBe(409);
    expect((await post("/api/commitments/proposals/nope", { accept: true })).status).toBe(404);
    expect((await post("/api/commitments/proposals/up1", {})).status).toBe(400);
  });

  test("draft-followup queues a manual draft job once; only accepted open theirs qualify", async () => {
    const id = commitmentRow();
    const res = await post(`/api/commitments/${id}/draft-followup`);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ queued: true });
    const jobs = c.db.select().from(schema.jobs).all();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      type: "commitments.draft_followup",
      input: { commitmentId: id, manual: true, origin: "manual" },
      concurrencyGroup: "commitments.intelligence",
    });
    expect(await (await post(`/api/commitments/${id}/draft-followup`)).json()).toEqual({
      queued: false,
    });
    for (const o of [
      { direction: "mine" as const },
      { reviewStatus: "pending_review" as const },
      { status: "completed" as const, closedAt: NOW },
    ]) {
      const bad = commitmentRow(o);
      expect((await post(`/api/commitments/${bad}/draft-followup`)).status).toBe(409);
    }
    expect((await post("/api/commitments/nope/draft-followup")).status).toBe(404);
    expect(c.db.select().from(schema.jobs).all()).toHaveLength(1);
  });
});

describe("followup routes", () => {
  test("list shows recipient, label, thread flags, outgoing and actions; urgent replies are excluded", async () => {
    const id = followupRow();
    const noThread = followupRow({ threadTs: null });
    c.db
      .insert(schema.followupHistory)
      .values({
        id: "h1",
        followupId: noThread,
        event: "noThread",
        detail: "no_thread",
        createdAt: NOW,
      })
      .run();
    followupRow({ origin: "urgent_reply" });
    followupRow({ status: "discarded" });
    const views = await followupViews();
    expect(views).toHaveLength(2);
    const v = views.find((x) => x.id === id);
    expect(v).toMatchObject({
      origin: "stalled",
      recipient: { id: SENDER, name: "Grace" },
      conversationLabel: "#ops",
      threadReply: true,
      noThread: false,
      draftText: DRAFT,
      status: "draft",
      outgoing: null,
      actions: ["send", "discard"],
      resolveActions: [],
    });
    expect(views.find((x) => x.id === noThread)).toMatchObject({
      noThread: true,
      threadReply: false,
    });
    expect((await followupViews("?status=discarded")).map((x) => x.status)).toEqual(["discarded"]);
    expect((await req("/api/followups?status=bogus")).status).toBe(400);
  });

  test("send maps the internal conversation id, stores the edited text, creates an approval and never calls the sink", async () => {
    const id = followupRow();
    const res = await post(`/api/followups/${id}/send`, { text: `edited ${SECRET}  \n` });
    expect(res.status).toBe(200);
    const { approvalId, outgoingId } = (await res.json()) as {
      approvalId: string;
      outgoingId: string;
    };
    const f = c.db.select().from(schema.followups).where(eq(schema.followups.id, id)).get();
    expect(f).toMatchObject({
      draftText: `edited ${SECRET}`,
      status: "awaiting_approval",
      approvalId,
      outgoingId,
    });
    expect(outgoingRow()).toMatchObject({
      conversationExternalId: "C0SYNTH01",
      threadTs: "1793879000.000050",
      text: `edited ${SECRET}`,
      status: "pending",
    });
    expect(sink.sends).toHaveLength(0);
    const [a] = await approvals();
    expect(a?.id).toBe(approvalId);
    const [v] = await followupViews();
    expect(v).toMatchObject({
      status: "awaiting_approval",
      outgoing: { id: outgoingId, status: "pending", failure: null },
      actions: [],
    });
    // Approving executes the send through the sink with the approved text only.
    await post(`/api/approvals/${approvalId}/approve`);
    await c.approvals.execute(approvalId);
    expect(sink.sends).toHaveLength(1);
    expect(sink.sends[0]).toMatchObject({
      conversationExternalId: "C0SYNTH01",
      text: `edited ${SECRET}`,
    });
  });

  test("send accepts an external conversation id as stored by urgent replies and a failed draft again", async () => {
    const id = followupRow({ conversationId: "C0SYNTH01", status: "failed" });
    expect((await post(`/api/followups/${id}/send`, { text: "again" })).status).toBe(200);
  });

  test("a draft whose conversation cannot be resolved lists discard only, and send is 409", async () => {
    const id = followupRow({ conversationId: "gone" });
    const v = (await followupViews()).find((x) => x.id === id);
    expect(v).toMatchObject({ conversationLabel: null, actions: ["discard"] });
    expect((await post(`/api/followups/${id}/send`, { text: "x" })).status).toBe(409);
    expect(sink.sends).toHaveLength(0);
  });

  test("send validation and 404/409 cases; a rejected send leaves the draft unchanged", async () => {
    const id = followupRow();
    expect((await post(`/api/followups/${id}/send`, { text: "" })).status).toBe(400);
    expect((await post(`/api/followups/${id}/send`, { text: "   \n" })).status).toBe(400);
    expect((await post(`/api/followups/${id}/send`, { text: "x".repeat(4001) })).status).toBe(400);
    expect((await post(`/api/followups/${id}/send`, {})).status).toBe(400);
    expect((await post("/api/followups/nope/send", { text: "hi" })).status).toBe(404);
    expect((await post(`/api/followups/${id}/send`, { text: "x".repeat(4000) })).status).toBe(200);
    // live send: a second request is 409 and does not touch the stored text
    expect((await post(`/api/followups/${id}/send`, { text: "second" })).status).toBe(409);
    expect(c.db.select().from(schema.outgoingMessages).all()).toHaveLength(1);
    expect(c.db.select().from(schema.followups).get()?.draftText).toBe("x".repeat(4000));
    for (const status of ["discarded", "sent"] as const) {
      const f = followupRow({ status });
      expect((await post(`/api/followups/${f}/send`, { text: "hi" })).status).toBe(409);
    }
    const noConv = followupRow({ conversationId: "missing" });
    expect((await post(`/api/followups/${noConv}/send`, { text: "hi" })).status).toBe(409);
    // a live outgoing on a draft-status followup is still blocked by SendAlreadyPending
    const live = followupRow();
    await post(`/api/followups/${live}/send`, { text: "hi" });
    c.db
      .update(schema.followups)
      .set({ status: "draft" })
      .where(eq(schema.followups.id, live))
      .run();
    expect((await post(`/api/followups/${live}/send`, { text: "hi" })).status).toBe(409);
  });

  test("discard: draft discarded with history and event; 409 when sent or live; 404 unknown", async () => {
    const id = followupRow();
    expect((await post(`/api/followups/${id}/discard`)).status).toBe(200);
    expect(c.db.select().from(schema.followups).get()?.status).toBe("discarded");
    expect(
      c.db
        .select()
        .from(schema.domainEvents)
        .where(eq(schema.domainEvents.type, "followup.status_changed"))
        .all(),
    ).toHaveLength(1);
    expect((await post(`/api/followups/${id}/discard`)).status).toBe(409);
    expect((await post(`/api/followups/${id}/send`, { text: "hi" })).status).toBe(409);
    expect((await post("/api/followups/nope/discard")).status).toBe(404);
    const live = followupRow();
    await post(`/api/followups/${live}/send`, { text: "hi" });
    expect((await post(`/api/followups/${live}/discard`)).status).toBe(409);
  });

  test("needs_attention lists resolve actions mirroring the resolve route; none for a draft", async () => {
    const id = followupRow();
    await post(`/api/followups/${id}/send`, { text: "hi" });
    const out = outgoingRow();
    c.db
      .update(schema.outgoingMessages)
      .set({ status: "needs_attention", failure: "uncertain_outcome" })
      .run();
    c.db.update(schema.followups).set({ status: "needs_attention" }).run();
    const [v] = await followupViews();
    expect(v).toMatchObject({
      outgoing: { status: "needs_attention", failure: "uncertain_outcome" },
      actions: [],
      resolveActions: ["mark_sent", "resend", "discard"],
    });
    expect((await post(`/api/outgoing/${out?.id}/resolve`, { decision: "mark_sent" })).status).toBe(
      200,
    );
    expect(await followupViews()).toHaveLength(0);
  });

  test("a followup.sent event sets last_followup_at on the commitment; others and failures are harmless", async () => {
    const cm = commitmentRow();
    const withCm = followupRow({ commitmentId: cm });
    await post(`/api/followups/${withCm}/send`, { text: `hi ${SECRET}` });
    c.db.update(schema.outgoingMessages).set({ status: "needs_attention" }).run();
    const out = outgoingRow();
    await post(`/api/outgoing/${out?.id}/resolve`, { decision: "mark_sent" });
    c.dispatcher.dispatchOnce();
    const row = c.db.select().from(schema.commitments).where(eq(schema.commitments.id, cm)).get();
    expect(row?.lastFollowupAt).not.toBeNull();
    // a followup with no commitment, and an unknown followup id, change nothing and do not throw
    const plain = followupRow();
    c.db.transaction((tx) => {
      c.followups.onFollowupSent({ payload: { followupId: plain } }, tx);
      c.followups.onFollowupSent({ payload: { followupId: "nope" } }, tx);
      c.followups.onFollowupSent({ payload: {} }, tx);
    });
    // a failure inside the consumer is swallowed and logs ids only
    c.db.transaction((tx) => {
      const broken = Object.create(tx, {
        transaction: {
          value: () => {
            throw new Error(`boom ${SECRET}`);
          },
        },
      });
      c.followups.onFollowupSent({ payload: { followupId: withCm } }, broken);
    });
    expect(logs.join("\n")).not.toContain(SECRET);
    expect(logs.join("\n")).toContain("commitments followup_sent failed");
  });

  test("no draft or commitment text reaches logs, events, audit rows or notifications", async () => {
    const cm = commitmentRow();
    const id = followupRow({ commitmentId: cm });
    await post(`/api/followups/${id}/send`, { text: SECRET });
    await post(`/api/commitments/${cm}/draft-followup`);
    const dump = JSON.stringify([
      c.db.select().from(schema.domainEvents).all(),
      c.db.select().from(schema.auditEvents).all(),
      c.db.select().from(schema.notifications).all(),
      c.db.select().from(schema.followupHistory).all(),
      logs,
    ]);
    expect(dump).not.toContain(SECRET);
    expect(dump).not.toContain(DRAFT);
    expect(dump).not.toContain(DESCRIPTION);
  });
});
