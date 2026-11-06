import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AIProvider, MessageSink, SendMessageCommand, SendResult } from "@synapse/contracts";
import { schema } from "@synapse/database";
import { FakeClock, newId } from "@synapse/shared";
import { eq } from "drizzle-orm";
import { type Container, createContainer } from "../../src/container";
import { loadConfig } from "../../src/core/config/config";
import { ACK_TEXT, withAutoReplyTag } from "../../src/modules/auto-reply/policy";
import {
  AUTOREPLY_EVALUATE_JOB,
  AutoReplyService,
  type AutoReplyServiceDeps,
} from "../../src/modules/auto-reply/service";
import { AutoSendBlocked } from "../../src/modules/outgoing/service";
import { registerAutoReplyJobs } from "../../src/workers/auto-reply/evaluate";

const NOW = "2026-11-06T12:00:00.000Z";
const MIN = 60_000;
const H = 60 * MIN;
const SELF = "USELF00001";
const ADA = "UADA000001";
const GRACE = "UGRACE0001";
const CHANNEL = "C0CHAN0001";
const DM = "D0ADA00001";
const TS = "1793880000.000100";
const DRAFT = "SECRET-DRAFT-TEXT Hi Ada, is the release checklist still on track?";
// Mentions the user, so a channel message is addressed to them (Phase 6b final review).
const INCOMING = "SECRET-INCOMING-TEXT <@USELF00001> the deploy is failing, can you look";
const TAGGED_ACK = withAutoReplyTag(ACK_TEXT);

class FakeSink implements MessageSink {
  sends: SendMessageCommand[] = [];
  async send(cmd: SendMessageCommand): Promise<SendResult> {
    this.sends.push(cmd);
    return { status: "sent_unverified" };
  }
  async findSent(): Promise<boolean | null> {
    return null;
  }
}

const fakeProvider: AIProvider = {
  execute: async () => {
    throw new Error("fake provider must not execute");
  },
  getHealth: async () => ({ status: "ok", version: "fake" }),
};

let c: Container;
let clock: FakeClock;
let sink: FakeSink;
let seq: number;

beforeEach(() => {
  clock = new FakeClock(NOW);
  sink = new FakeSink();
  seq = 0;
  c = createContainer(loadConfig({ SYNAPSE_DB_PATH: ":memory:" }), {
    run: async () => "Linger=yes",
    provider: fakeProvider,
    sink,
    clock,
  });
  c.settings.set("slack.selfUserId", SELF);
  c.db
    .insert(schema.slackUsers)
    .values([
      { id: "u-self", externalId: SELF, name: "Me" },
      { id: "u-ada", externalId: ADA, name: "Ada" },
      { id: "u-grace", externalId: GRACE, name: "Grace" },
    ])
    .run();
  c.db
    .insert(schema.slackConversations)
    .values([
      { id: "c-ch", externalId: CHANNEL, type: "channel", name: "eng" },
      { id: "c-dm", externalId: DM, type: "im" },
      { id: "c-mp", externalId: "G0GROUP001", type: "mpim" },
    ])
    .run();
  // Ada wrote first in the DM, so she is its partner (the inbox partner rule).
  c.db
    .insert(schema.slackMessages)
    .values({
      id: "m-dm0",
      conversationId: "c-dm",
      ts: "1793870000.000100",
      senderUserId: "u-ada",
      text: "hello",
      sentAt: "2026-11-01T12:00:00.000Z",
      collectedAt: NOW,
    })
    .run();
  c.people.setPriority(ADA, { priority: "high" });
});
afterEach(() => c.sqlite.close());

function msg(
  over: {
    sender?: string;
    conv?: string;
    text?: string | null;
    thread?: string | null;
    sentAt?: string;
  } = {},
): { id: string; ts: string } {
  seq += 1;
  const id = `m${seq}`;
  const ts = `${1793880000 + seq}.000100`;
  c.db
    .insert(schema.slackMessages)
    .values({
      id,
      conversationId: over.conv ?? "c-ch",
      ts,
      threadTs: over.thread ?? null,
      senderUserId: over.sender ?? "u-ada",
      text: over.text === undefined ? INCOMING : over.text,
      sentAt: over.sentAt ?? NOW,
      collectedAt: NOW,
      contentExpiredAt: over.text === null ? NOW : null,
    })
    .run();
  return { id, ts };
}

function followup(
  over: {
    origin?: "stalled" | "spec_clarity";
    recipient?: string | null;
    confidence?: number | null;
    conv?: string;
    thread?: string | null;
    originMessageId?: string | null;
    text?: string;
    status?: "draft" | "discarded";
    commitmentId?: string | null;
    runId?: string | null;
    suspectedInjection?: boolean;
    contextMessageIds?: string[] | null;
  } = {},
): string {
  const id = newId();
  c.db
    .insert(schema.followups)
    .values({
      id,
      origin: over.origin ?? "stalled",
      originMessageId: over.originMessageId ?? null,
      conversationId: over.conv ?? "c-dm",
      threadTs: over.thread ?? null,
      recipientSlackUserId: over.recipient === undefined ? ADA : over.recipient,
      draftText: over.text ?? DRAFT,
      confidence: over.confidence === undefined ? 0.9 : over.confidence,
      status: over.status ?? "draft",
      commitmentId: over.commitmentId ?? null,
      claudeRunId: over.runId ?? null,
      suspectedInjection: over.suspectedInjection ?? false,
      contextMessageIds: over.contextMessageIds ?? null,
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run();
  return id;
}
const ago = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString();
const later = (ms: number) => new Date(Date.parse(NOW) + ms).toISOString();

const ar = (id: string) =>
  c.db.select().from(schema.autoReplies).where(eq(schema.autoReplies.id, id)).get();
const allAr = () => c.db.select().from(schema.autoReplies).all();
const out = (id: string) =>
  c.db.select().from(schema.outgoingMessages).where(eq(schema.outgoingMessages.id, id)).get();
const fu = (id: string) =>
  c.db.select().from(schema.followups).where(eq(schema.followups.id, id)).get();
const eventsOf = (type: string) =>
  c.db
    .select()
    .from(schema.domainEvents)
    .where(eq(schema.domainEvents.type, type))
    .all()
    .map((e) => e.payload);
const ackJobs = () =>
  c.db
    .select()
    .from(schema.jobs)
    .where(eq(schema.jobs.type, AUTOREPLY_EVALUATE_JOB))
    .all()
    .filter((j) => j.idempotencyKey.startsWith("autoreply:acknowledgement:"));
function flag(over: {
  messageId?: string | null;
  runId?: string | null;
  severity?: "info" | "warning" | "high";
}) {
  c.db
    .insert(schema.securityFlags)
    .values({
      id: newId(),
      messageId: over.messageId ?? null,
      claudeRunId: over.runId ?? null,
      sourceExternalRef: `ref-${newId()}`,
      slackUserId: ADA,
      detector: over.runId ? "runtime" : "rules",
      ruleId: `r-${newId()}`,
      severity: over.severity ?? "warning",
      excerpt: "x",
      reason: "x",
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run();
}
const audits = (action: string) =>
  c.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, action)).all();

function seedSent(createdAt: string, over: { conv?: string; thread?: string | null } = {}) {
  c.db
    .insert(schema.autoReplies)
    .values({
      id: newId(),
      sessionId: c.autoReply.status().sessionId as string,
      kind: "acknowledgement",
      recipientSlackUserId: ADA,
      conversationExternalId: over.conv ?? "C0OTHER001",
      threadTs: over.thread === undefined ? `${newId()}` : over.thread,
      decision: "sent",
      text: TAGGED_ACK,
      createdAt,
    })
    .run();
}

describe("setAway and status", () => {
  test("on opens one session, sets the setting, audits as the user and publishes", () => {
    expect(c.autoReply.status()).toEqual({ on: false, sessionId: null, startedAt: null });
    const r = c.autoReply.setAway(true);
    expect(r.on).toBe(true);
    expect(r.sessionId).not.toBeNull();
    expect(c.settings.get("autoReply.awayMode")).toBe(true);
    expect(c.autoReply.status()).toEqual({ on: true, sessionId: r.sessionId, startedAt: NOW });
    expect(audits("away.started")).toHaveLength(1);
    expect(audits("away.started")[0]).toMatchObject({ actor: "user", targetRef: r.sessionId });
    expect(eventsOf("away.changed")).toEqual([{ on: true }]);
    // Idempotent: on again returns the open session, no new audit or event.
    expect(c.autoReply.setAway(true).sessionId).toBe(r.sessionId);
    expect(c.db.select().from(schema.awaySessions).all()).toHaveLength(1);
    expect(audits("away.started")).toHaveLength(1);
    expect(eventsOf("away.changed")).toHaveLength(1);
  });

  test("off closes the session; off again is a no-op", () => {
    const { sessionId } = c.autoReply.setAway(true);
    clock.advance(H);
    expect(c.autoReply.setAway(false)).toMatchObject({ on: false, sessionId: null });
    const s = c.db
      .select()
      .from(schema.awaySessions)
      .where(eq(schema.awaySessions.id, sessionId as string))
      .get();
    expect(s?.endedAt).toBe(new Date(Date.parse(NOW) + H).toISOString());
    expect(c.settings.get("autoReply.awayMode")).toBe(false);
    expect(audits("away.ended")).toHaveLength(1);
    expect(audits("away.ended")[0]).toMatchObject({ actor: "user", targetRef: sessionId });
    expect(eventsOf("away.changed")).toEqual([{ on: true }, { on: false }]);
    expect(c.autoReply.setAway(false)).toEqual({ on: false, sessionId: null, startedAt: null });
    expect(audits("away.ended")).toHaveLength(1);
    expect(eventsOf("away.changed")).toHaveLength(2);
    // A new session can open after the old one closed.
    expect(c.autoReply.setAway(true).sessionId).not.toBe(sessionId);
  });

  test("off never touches an auto-send that is already sending", async () => {
    c.autoReply.setAway(true);
    const m = msg();
    const r = c.autoReply.evaluate({ kind: "acknowledgement", messageId: m.id });
    if (r.status !== "sent") throw new Error("expected sent");
    // An executor elsewhere has claimed it: the row is `sending`.
    c.db
      .update(schema.outgoingMessages)
      .set({ status: "sending", sendingAt: NOW })
      .where(eq(schema.outgoingMessages.id, r.outgoingId))
      .run();
    c.autoReply.setAway(false);
    c.dispatcher.dispatchOnce();
    expect(out(r.outgoingId)?.status).toBe("sending");
    expect(out(r.outgoingId)?.failure).toBeNull();
    expect(ar(r.autoReplyId)?.decision).toBe("sent");
    expect(eventsOf("autoreply.held")).toHaveLength(0);
  });
});

describe("evaluate: acknowledgements", () => {
  beforeEach(() => {
    c.autoReply.setAway(true);
  });

  test("an urgent message from Ada sends one tagged acknowledgement in her thread", async () => {
    const m = msg();
    const r = c.autoReply.evaluate({ kind: "acknowledgement", messageId: m.id });
    expect(r.status).toBe("sent");
    if (r.status !== "sent") return;
    expect(ar(r.autoReplyId)).toMatchObject({
      kind: "acknowledgement",
      decision: "sent",
      reason: null,
      text: TAGGED_ACK,
      recipientSlackUserId: ADA,
      conversationExternalId: CHANNEL,
      threadTs: m.ts,
      sourceMessageId: m.id,
      outgoingId: r.outgoingId,
      approvalId: r.approvalId,
    });
    expect(out(r.outgoingId)).toMatchObject({
      text: TAGGED_ACK,
      conversationExternalId: CHANNEL,
      threadTs: m.ts,
      status: "pending",
    });
    // The policy approval runs through the normal execute path.
    c.dispatcher.dispatchOnce();
    expect(await c.worker.runOnce()).toBe(true);
    expect(sink.sends).toHaveLength(1);
    expect(sink.sends[0]).toMatchObject({
      text: TAGGED_ACK,
      conversationExternalId: CHANNEL,
      threadTs: m.ts,
      authorisedBy: "policy",
    });
    expect(out(r.outgoingId)?.status).toBe("sent_unverified");
    // autoreply.sent comes from the outgoing service on delivery, exactly once.
    expect(eventsOf("autoreply.sent")).toEqual([{ autoReplyId: r.autoReplyId }]);
  });

  test("a thread reply is acknowledged in its thread", () => {
    const m = msg({ thread: TS });
    const r = c.autoReply.evaluate({ kind: "acknowledgement", messageId: m.id });
    if (r.status !== "sent") throw new Error(`expected sent, got ${r.status}`);
    expect(out(r.outgoingId)?.threadTs).toBe(TS);
  });

  test("the same from Grace is held: not_priority, no outgoing, autoreply.held", () => {
    const m = msg({ sender: "u-grace" });
    const r = c.autoReply.evaluate({ kind: "acknowledgement", messageId: m.id });
    expect(r).toMatchObject({ status: "held", reason: "not_priority" });
    if (r.status !== "held") return;
    expect(ar(r.autoReplyId)).toMatchObject({
      decision: "held",
      reason: "not_priority",
      text: null,
      outgoingId: null,
      recipientSlackUserId: GRACE,
    });
    expect(c.db.select().from(schema.outgoingMessages).all()).toHaveLength(0);
    expect(eventsOf("autoreply.held")).toEqual([
      { autoReplyId: r.autoReplyId, reason: "not_priority" },
    ]);
  });

  test("an incoming message carrying the tag is held: loop_tag", () => {
    const m = msg({ conv: "c-dm", text: "ok, noted\n\nsent  using   @Claude" });
    expect(c.autoReply.evaluate({ kind: "acknowledgement", messageId: m.id })).toMatchObject({
      status: "held",
      reason: "loop_tag",
    });
  });

  test("an incoming message with an open warning flag is held: flagged", () => {
    const m = msg();
    c.db
      .insert(schema.securityFlags)
      .values({
        id: newId(),
        messageId: m.id,
        sourceExternalRef: `${CHANNEL}:${m.ts}`,
        slackUserId: ADA,
        detector: "rules",
        ruleId: "r1",
        severity: "warning",
        excerpt: "x",
        reason: "x",
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
    expect(c.autoReply.evaluate({ kind: "acknowledgement", messageId: m.id })).toMatchObject({
      status: "held",
      reason: "flagged",
    });
  });

  test("an expired source message is held: missing_context", () => {
    const m = msg({ text: null });
    expect(c.autoReply.evaluate({ kind: "acknowledgement", messageId: m.id })).toMatchObject({
      status: "held",
      reason: "missing_context",
    });
  });

  test("a message is acknowledged at most once", () => {
    const m = msg();
    expect(c.autoReply.evaluate({ kind: "acknowledgement", messageId: m.id }).status).toBe("sent");
    expect(c.autoReply.evaluate({ kind: "acknowledgement", messageId: m.id })).toEqual({
      status: "skipped",
      reason: "already_evaluated",
    });
    expect(allAr()).toHaveLength(1);
  });

  test("an unknown message is skipped; the user's own message is skipped", () => {
    expect(c.autoReply.evaluate({ kind: "acknowledgement", messageId: "nope" })).toEqual({
      status: "skipped",
      reason: "not_found",
    });
    const own = msg({ sender: "u-self" });
    expect(c.autoReply.evaluate({ kind: "acknowledgement", messageId: own.id })).toEqual({
      status: "skipped",
      reason: "self",
    });
    expect(allAr()).toHaveLength(0);
  });

  test("a tightened permission holds with policy_disabled and rolls the send back", () => {
    c.permissions.setOverride("slack.auto_reply", "approval_required");
    const m = msg();
    const r = c.autoReply.evaluate({ kind: "acknowledgement", messageId: m.id });
    expect(r).toMatchObject({ status: "held", reason: "policy_disabled" });
    const rows = allAr();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ decision: "held", reason: "policy_disabled", text: null });
    expect(c.db.select().from(schema.outgoingMessages).all()).toHaveLength(0);
    expect(c.db.select().from(schema.approvals).all()).toHaveLength(0);
    expect(eventsOf("autoreply.held")).toEqual([
      { autoReplyId: rows[0]?.id, reason: "policy_disabled" },
    ]);
  });
});

describe("evaluate: acknowledgements only for addressed messages", () => {
  beforeEach(() => {
    c.autoReply.setAway(true);
  });
  const ack = (messageId: string) => c.autoReply.evaluate({ kind: "acknowledgement", messageId });

  test("a channel post with no mention of the user is held: not_addressed", () => {
    const r = ack(msg({ text: "the deploy is failing, can someone look" }).id);
    expect(r).toMatchObject({ status: "held", reason: "not_addressed" });
    expect(c.db.select().from(schema.outgoingMessages).all()).toHaveLength(0);
    // A mention of someone else is not a mention of the user.
    expect(ack(msg({ text: "<@UGRACE0001> can you look" }).id)).toMatchObject({
      status: "held",
      reason: "not_addressed",
    });
  });

  test("a channel post that mentions the user (plain, labelled or escaped) is addressed", () => {
    expect(ack(msg({ text: "<@USELF00001> can you look" }).id).status).toBe("sent");
    clock.advance(H);
    expect(ack(msg({ text: "<@USELF00001|me> can you look", thread: "1.1" }).id).status).toBe(
      "sent",
    );
    clock.advance(H);
    expect(ack(msg({ text: "&lt;@USELF00001&gt; can you look", thread: "2.2" }).id).status).toBe(
      "sent",
    );
  });

  test("a DM or group DM is addressed without a mention", () => {
    expect(ack(msg({ conv: "c-dm", text: "can you look" }).id).status).toBe("sent");
    expect(ack(msg({ conv: "c-mp", text: "can you look" }).id).status).toBe("sent");
  });

  test("a thread reply is addressed when the user posted in that thread before it", () => {
    const root = msg({ sender: "u-grace", text: "release thread", sentAt: ago(10 * MIN) });
    msg({ sender: "u-self", text: "on it", thread: root.ts, sentAt: ago(5 * MIN) });
    expect(ack(msg({ text: "still failing", thread: root.ts }).id).status).toBe("sent");
  });

  test("the user posting in another thread, or only after, does not address it", () => {
    const root = msg({ sender: "u-grace", text: "release thread", sentAt: ago(10 * MIN) });
    msg({ sender: "u-self", text: "elsewhere", thread: TS, sentAt: ago(5 * MIN) });
    expect(ack(msg({ text: "still failing", thread: root.ts }).id)).toMatchObject({
      status: "held",
      reason: "not_addressed",
    });
  });
});

describe("evaluate: before the session or already answered", () => {
  beforeEach(() => {
    c.autoReply.setAway(true);
  });
  const ack = (messageId: string) => c.autoReply.evaluate({ kind: "acknowledgement", messageId });

  test("an acknowledgement for a message sent before away started is held: before_session", () => {
    expect(ack(msg({ sentAt: ago(MIN) }).id)).toMatchObject({
      status: "held",
      reason: "before_session",
    });
    // At the session start exactly is not before it.
    expect(ack(msg({ sentAt: NOW }).id).status).toBe("sent");
  });

  test("an acknowledgement after the user already replied in the thread: already_answered", () => {
    const m = msg();
    msg({ sender: "u-self", text: "looking", thread: m.ts, sentAt: later(MIN) });
    expect(ack(m.id)).toMatchObject({ status: "held", reason: "already_answered" });
  });

  test("the user's own tagged auto-reply is not an answer: not already_answered", () => {
    const m = msg();
    msg({
      sender: "u-self",
      text: "Back later.\n\nSent using @claude",
      thread: m.ts,
      sentAt: later(MIN),
    });
    expect(ack(m.id).status).toBe("sent");
  });

  test("in a channel, a reply by the user in another thread is not an answer", () => {
    const m = msg();
    msg({ sender: "u-self", text: "elsewhere", thread: TS, sentAt: later(MIN) });
    expect(ack(m.id).status).toBe("sent");
  });

  test("in a DM, any later message by the user is an answer", () => {
    const m = msg({ conv: "c-dm", text: "can you look" });
    msg({ sender: "u-self", conv: "c-dm", text: "yes", thread: TS, sentAt: later(MIN) });
    expect(ack(m.id)).toMatchObject({ status: "held", reason: "already_answered" });
  });

  test("a follow-up question whose origin predates the session is held: before_session", () => {
    const m = msg({ sentAt: ago(MIN) });
    const f = followup({
      origin: "spec_clarity",
      originMessageId: m.id,
      conv: "c-ch",
      thread: m.ts,
    });
    expect(c.autoReply.evaluate({ kind: "followup_question", followupId: f })).toMatchObject({
      status: "held",
      reason: "before_session",
    });
    expect(fu(f)?.status).toBe("draft");
  });

  test("a follow-up question the user already answered is held: already_answered", () => {
    const m = msg();
    msg({ sender: "u-self", text: "details", thread: m.ts, sentAt: later(MIN) });
    const f = followup({
      origin: "spec_clarity",
      originMessageId: m.id,
      conv: "c-ch",
      thread: m.ts,
    });
    expect(c.autoReply.evaluate({ kind: "followup_question", followupId: f })).toMatchObject({
      status: "held",
      reason: "already_answered",
    });
  });

  test("a follow-up question without an origin message is held: missing_context", () => {
    const f = followup({ origin: "spec_clarity", originMessageId: null });
    expect(c.autoReply.evaluate({ kind: "followup_question", followupId: f })).toMatchObject({
      status: "held",
      reason: "missing_context",
    });
  });

  test("a stalled reminder has no source message, so neither check applies", () => {
    msg({ sender: "u-self", conv: "c-dm", text: "hi", sentAt: later(MIN) });
    expect(c.autoReply.evaluate({ kind: "stalled_reminder", followupId: followup() }).status).toBe(
      "sent",
    );
  });
});

describe("evaluate: drafting-context flags", () => {
  beforeEach(() => {
    c.autoReply.setAway(true);
  });

  test("a draft whose run suspected injection is held: injection_suspected (both kinds)", () => {
    const f = followup({ suspectedInjection: true });
    expect(c.autoReply.evaluate({ kind: "stalled_reminder", followupId: f })).toMatchObject({
      status: "held",
      reason: "injection_suspected",
    });
    expect(fu(f)?.status).toBe("draft");
    const m = msg();
    const q = followup({
      origin: "spec_clarity",
      originMessageId: m.id,
      conv: "c-ch",
      thread: m.ts,
      suspectedInjection: true,
    });
    expect(c.autoReply.evaluate({ kind: "followup_question", followupId: q })).toMatchObject({
      status: "held",
      reason: "injection_suspected",
    });
  });

  test("an open warning flag on any context message holds the draft: flagged", () => {
    const ctx = msg({ sender: "u-grace", text: "context" });
    flag({ messageId: ctx.id });
    const f = followup({ contextMessageIds: ["m-dm0", ctx.id] });
    expect(c.autoReply.evaluate({ kind: "stalled_reminder", followupId: f })).toMatchObject({
      status: "held",
      reason: "flagged",
    });
  });

  test("an info flag on a context message, or null context ids, keeps the old checks", () => {
    const ctx = msg({ sender: "u-grace", text: "context" });
    flag({ messageId: ctx.id, severity: "info" });
    const f = followup({ contextMessageIds: [ctx.id] });
    expect(c.autoReply.evaluate({ kind: "stalled_reminder", followupId: f }).status).toBe("sent");
    const warned = msg({ sender: "u-grace", text: "context" });
    flag({ messageId: warned.id });
    // A row drafted before 0014 has no context ids: not checkable, so only the old checks run.
    const old = followup({ contextMessageIds: null, conv: "c-ch", thread: TS });
    expect(c.autoReply.evaluate({ kind: "stalled_reminder", followupId: old }).status).toBe("sent");
  });
});

describe("evaluate: follow-ups", () => {
  beforeEach(() => {
    c.autoReply.setAway(true);
  });

  test("a stalled draft to Ada at 0.9 is sent and leaves draft", () => {
    const f = followup();
    const r = c.autoReply.evaluate({ kind: "stalled_reminder", followupId: f });
    if (r.status !== "sent") throw new Error(`expected sent, got ${JSON.stringify(r)}`);
    expect(ar(r.autoReplyId)).toMatchObject({
      kind: "stalled_reminder",
      followupId: f,
      conversationExternalId: DM,
      threadTs: null,
      text: withAutoReplyTag(DRAFT),
    });
    expect(out(r.outgoingId)).toMatchObject({
      text: withAutoReplyTag(DRAFT),
      conversationExternalId: DM,
      threadTs: null,
      followupId: f,
    });
    expect(fu(f)).toMatchObject({
      status: "awaiting_approval",
      outgoingId: r.outgoingId,
      approvalId: r.approvalId,
    });
    // Moved once, by requestAutoSend.
    const history = c.db
      .select()
      .from(schema.followupHistory)
      .where(eq(schema.followupHistory.followupId, f))
      .all();
    expect(history.map((h) => h.event)).toEqual(["auto_send_requested"]);
    // It cannot be sent twice.
    expect(c.autoReply.evaluate({ kind: "stalled_reminder", followupId: f }).status).toBe(
      "skipped",
    );
  });

  test("a stalled draft at 0.5 is held: low_confidence, still draft, no acknowledgement", () => {
    const m = msg();
    const f = followup({ confidence: 0.5, originMessageId: m.id });
    const r = c.autoReply.evaluate({ kind: "stalled_reminder", followupId: f });
    expect(r).toMatchObject({ status: "held", reason: "low_confidence" });
    expect(ackJobs()).toHaveLength(0);
    expect(fu(f)?.status).toBe("draft");
    expect(allAr()).toHaveLength(1);
  });

  test("a spec-clarity draft at 0.5 is held and an acknowledgement is queued instead", async () => {
    const m = msg();
    const f = followup({
      origin: "spec_clarity",
      confidence: 0.5,
      originMessageId: m.id,
      conv: "c-ch",
      thread: m.ts,
    });
    const r = c.autoReply.evaluate({ kind: "followup_question", followupId: f });
    expect(r).toMatchObject({ status: "held", reason: "low_confidence" });
    expect(r).not.toHaveProperty("acknowledgement");
    expect(fu(f)?.status).toBe("draft");
    // A6: the acknowledgement is its own job, keyed like the urgent trigger's.
    expect(ackJobs().map((j) => [j.idempotencyKey, j.concurrencyGroup, j.input])).toEqual([
      [
        `autoreply:acknowledgement:${m.id}`,
        "autoreply",
        { kind: "acknowledgement", messageId: m.id },
      ],
    ]);
    expect(allAr()).toHaveLength(1);
    expect(await c.worker.runOnce()).toBe(true);
    const ack = allAr().find((a) => a.kind === "acknowledgement");
    expect(ack).toMatchObject({
      decision: "sent",
      sourceMessageId: m.id,
      threadTs: m.ts,
      text: TAGGED_ACK,
    });
  });

  test("a null-confidence spec-clarity draft is held: low_confidence", () => {
    const m = msg();
    const f = followup({
      origin: "spec_clarity",
      confidence: null,
      originMessageId: m.id,
      conv: "c-ch",
      thread: m.ts,
    });
    const r = c.autoReply.evaluate({ kind: "followup_question", followupId: f });
    expect(r).toMatchObject({ status: "held", reason: "low_confidence" });
    expect(allAr()).toHaveLength(1);
  });

  test("a follow-up without a recipient is held: missing_context", () => {
    const f = followup({ recipient: null });
    expect(c.autoReply.evaluate({ kind: "stalled_reminder", followupId: f })).toMatchObject({
      status: "held",
      reason: "missing_context",
    });
    expect(fu(f)?.status).toBe("draft");
  });

  test("a draft with a promise is held: content_promise", () => {
    const f = followup({ text: "I'll send the notes by tomorrow" });
    expect(c.autoReply.evaluate({ kind: "stalled_reminder", followupId: f })).toMatchObject({
      status: "held",
      reason: "content_promise",
    });
  });

  test("A3 extension: an open flag on the drafting run holds the draft: flagged", () => {
    c.db
      .insert(schema.claudeRuns)
      .values({ id: "run-1", workerProfile: "intelligence", status: "succeeded", startedAt: NOW })
      .run();
    flag({ runId: "run-1" });
    const f = followup({ runId: "run-1" });
    expect(c.autoReply.evaluate({ kind: "stalled_reminder", followupId: f })).toMatchObject({
      status: "held",
      reason: "flagged",
    });
    // An info flag on a run does not count.
    c.db
      .insert(schema.claudeRuns)
      .values({ id: "run-2", workerProfile: "intelligence", status: "succeeded", startedAt: NOW })
      .run();
    flag({ runId: "run-2", severity: "info" });
    const ok = followup({ runId: "run-2", conv: "c-ch", thread: TS });
    expect(c.autoReply.evaluate({ kind: "stalled_reminder", followupId: ok }).status).toBe("sent");
  });

  test("A3 extension: an open flag on the origin message holds the draft: flagged", () => {
    const m = msg();
    flag({ messageId: m.id, severity: "high" });
    const f = followup({ origin: "spec_clarity", originMessageId: m.id });
    expect(c.autoReply.evaluate({ kind: "followup_question", followupId: f })).toMatchObject({
      status: "held",
      reason: "flagged",
    });
  });

  test("A3 extension: an open flag on a commitment source message holds a stalled draft", () => {
    const src = msg();
    c.db
      .insert(schema.commitments)
      .values({
        id: "cm1",
        description: "d",
        ownerSlackUserId: ADA,
        direction: "theirs",
        status: "open",
        reviewStatus: "accepted",
        dedupKey: "k1",
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
    c.db
      .insert(schema.commitmentSources)
      .values({
        id: newId(),
        commitmentId: "cm1",
        messageId: src.id,
        sourceExternalRef: `${CHANNEL}:${src.ts}`,
        conversationId: "c-ch",
        createdAt: NOW,
      })
      .run();
    flag({ messageId: src.id });
    const f = followup({ commitmentId: "cm1" });
    expect(c.autoReply.evaluate({ kind: "stalled_reminder", followupId: f })).toMatchObject({
      status: "held",
      reason: "flagged",
    });
  });

  test("a draft that already carries the tag is held: loop_tag", () => {
    const f = followup({ text: "Any update?\n\nSent using @claude" });
    expect(c.autoReply.evaluate({ kind: "stalled_reminder", followupId: f })).toMatchObject({
      status: "held",
      reason: "loop_tag",
    });
  });

  test("a DM draft to someone other than the DM partner is held: recipient_mismatch", () => {
    const f = followup({ recipient: GRACE });
    c.people.setPriority(GRACE, { priority: "high" });
    expect(c.autoReply.evaluate({ kind: "stalled_reminder", followupId: f })).toMatchObject({
      status: "held",
      reason: "recipient_mismatch",
    });
    // A DM with no partner yet (no message from anyone but the user) cannot be verified.
    c.db
      .insert(schema.slackConversations)
      .values({ id: "c-dm2", externalId: "D0EMPTY001", type: "im" })
      .run();
    const g = followup({ conv: "c-dm2" });
    expect(c.autoReply.evaluate({ kind: "stalled_reminder", followupId: g })).toMatchObject({
      status: "held",
      reason: "recipient_mismatch",
    });
  });

  test("a non-draft follow-up or an origin mismatch is skipped", () => {
    const gone = followup({ status: "discarded" });
    expect(c.autoReply.evaluate({ kind: "stalled_reminder", followupId: gone })).toEqual({
      status: "skipped",
      reason: "not_draft",
    });
    const stalled = followup();
    expect(c.autoReply.evaluate({ kind: "followup_question", followupId: stalled })).toEqual({
      status: "skipped",
      reason: "kind_mismatch",
    });
    expect(c.autoReply.evaluate({ kind: "stalled_reminder", followupId: "nope" })).toEqual({
      status: "skipped",
      reason: "not_found",
    });
    expect(allAr()).toHaveLength(0);
  });
});

describe("evaluate: caps", () => {
  beforeEach(() => {
    c.autoReply.setAway(true);
  });

  test("a 4th send to Ada within 24 h is held: daily_cap; the window is rolling", () => {
    // One sent 25 h ago does not count; three within the window do.
    seedSent(new Date(Date.parse(NOW) - 25 * H).toISOString());
    seedSent(new Date(Date.parse(NOW) - 23 * H).toISOString());
    seedSent(new Date(Date.parse(NOW) - 2 * H).toISOString());
    const first = c.autoReply.evaluate({ kind: "acknowledgement", messageId: msg().id });
    expect(first.status).toBe("sent");
    expect(c.autoReply.evaluate({ kind: "acknowledgement", messageId: msg().id })).toMatchObject({
      status: "held",
      reason: "daily_cap",
    });
    // Two hours later the oldest in-window send has aged out.
    clock.advance(2 * H);
    expect(c.autoReply.evaluate({ kind: "acknowledgement", messageId: msg().id }).status).toBe(
      "sent",
    );
  });

  test("an acknowledgement then a follow-up question in the same thread within 30 min: thread_gap", () => {
    const m = msg();
    expect(c.autoReply.evaluate({ kind: "acknowledgement", messageId: m.id }).status).toBe("sent");
    clock.advance(10 * MIN);
    const f = followup({
      origin: "spec_clarity",
      conv: "c-ch",
      thread: m.ts,
      originMessageId: m.id,
    });
    expect(c.autoReply.evaluate({ kind: "followup_question", followupId: f })).toMatchObject({
      status: "held",
      reason: "thread_gap",
    });
    // A different thread is not affected.
    const o = msg({ thread: TS });
    const other = followup({
      origin: "spec_clarity",
      conv: "c-ch",
      thread: TS,
      originMessageId: o.id,
    });
    expect(c.autoReply.evaluate({ kind: "followup_question", followupId: other }).status).toBe(
      "sent",
    );
  });

  test("in a DM the gap is per conversation: a threaded ack blocks a top-level question", () => {
    const m = msg({ conv: "c-dm", thread: TS });
    expect(c.autoReply.evaluate({ kind: "acknowledgement", messageId: m.id }).status).toBe("sent");
    clock.advance(10 * MIN);
    const q = msg({ conv: "c-dm" });
    const f = followup({
      origin: "spec_clarity",
      conv: "c-dm",
      thread: null,
      originMessageId: q.id,
    });
    expect(c.autoReply.evaluate({ kind: "followup_question", followupId: f })).toMatchObject({
      status: "held",
      reason: "thread_gap",
    });
  });

  test("a top-level (null thread) send gates the next top-level send in that conversation", () => {
    expect(c.autoReply.evaluate({ kind: "stalled_reminder", followupId: followup() }).status).toBe(
      "sent",
    );
    clock.advance(5 * MIN);
    expect(
      c.autoReply.evaluate({ kind: "stalled_reminder", followupId: followup() }),
    ).toMatchObject({ status: "held", reason: "thread_gap" });
  });
});

describe("evaluate: away off and failures", () => {
  test("with no open session nothing is recorded", () => {
    const m = msg();
    expect(c.autoReply.evaluate({ kind: "acknowledgement", messageId: m.id })).toEqual({
      status: "skipped",
      reason: "away_off",
    });
    expect(allAr()).toHaveLength(0);
  });

  function withOutgoing(
    requestAutoSend: AutoReplyServiceDeps["outgoing"]["requestAutoSend"],
    queue: AutoReplyServiceDeps["queue"] = c.queue,
  ): AutoReplyService {
    return new AutoReplyService({
      db: c.db,
      clock,
      events: c.events,
      audit: c.audit,
      queue,
      settings: c.settings,
      people: c.people,
      securityFlags: c.securityFlags,
      outgoing: { requestAutoSend, requestSend: (tx, i) => c.outgoing.requestSend(tx, i) },
      codeAnswers: c.codeAnswers,
    });
  }

  test("A6: the fallback acknowledgement is enqueued in the hold's transaction", () => {
    c.autoReply.setAway(true);
    const svc = withOutgoing((tx, i) => c.outgoing.requestAutoSend(tx, i), {
      enqueue: () => {
        throw new Error("enqueue failed");
      },
    });
    const m = msg();
    const f = followup({ origin: "spec_clarity", confidence: 0.5, originMessageId: m.id });
    expect(() => svc.evaluate({ kind: "followup_question", followupId: f })).toThrow(
      "enqueue failed",
    );
    // The hold rolled back with the enqueue: the retried job re-evaluates from scratch.
    expect(allAr()).toHaveLength(0);
    expect(eventsOf("autoreply.held")).toHaveLength(0);
  });

  test("A6: a failing fallback acknowledgement is retried by its own job", async () => {
    c.autoReply.setAway(true);
    let failures = 1;
    const svc = withOutgoing((tx, i) => {
      if (failures-- > 0) throw new Error("transient");
      return c.outgoing.requestAutoSend(tx, i);
    });
    registerAutoReplyJobs({
      handlers: c.handlers as Map<string, never>,
      autoReply: svc,
    });
    const m = msg();
    const f = followup({ origin: "spec_clarity", confidence: 0.5, originMessageId: m.id });
    expect(svc.evaluate({ kind: "followup_question", followupId: f })).toMatchObject({
      status: "held",
      reason: "low_confidence",
    });
    expect(await c.worker.runOnce()).toBe(true);
    expect(ackJobs()[0]?.status).toBe("RETRY");
    expect(allAr().filter((a) => a.kind === "acknowledgement")).toHaveLength(0);
    clock.advance(H);
    expect(await c.worker.runOnce()).toBe(true);
    expect(ackJobs()[0]?.status).toBe("COMPLETED");
    expect(allAr().find((a) => a.kind === "acknowledgement")).toMatchObject({
      decision: "sent",
      sourceMessageId: m.id,
    });
  });

  test("AutoSendBlocked rolls the sent row back and records a held away_off row", () => {
    c.autoReply.setAway(true);
    const svc = withOutgoing(() => {
      throw new AutoSendBlocked("x", "away_off");
    });
    const f = followup();
    const r = svc.evaluate({ kind: "stalled_reminder", followupId: f });
    expect(r).toMatchObject({ status: "held", reason: "away_off" });
    const rows = allAr();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ decision: "held", reason: "away_off", text: null });
    expect(fu(f)?.status).toBe("draft");
    expect(eventsOf("autoreply.held")).toEqual([{ autoReplyId: rows[0]?.id, reason: "away_off" }]);
  });

  test("any other error propagates and records nothing", () => {
    c.autoReply.setAway(true);
    const svc = withOutgoing(() => {
      throw new Error("boom");
    });
    expect(() => svc.evaluate({ kind: "stalled_reminder", followupId: followup() })).toThrow(
      "boom",
    );
    expect(allAr()).toHaveLength(0);
    expect(eventsOf("autoreply.held")).toHaveLength(0);
  });
});

describe("digest", () => {
  test("lists the ended session's sent and held rows with names; dismiss hides it", () => {
    const { sessionId } = c.autoReply.setAway(true);
    const sent = c.autoReply.evaluate({ kind: "acknowledgement", messageId: msg().id });
    clock.advance(MIN);
    const held = c.autoReply.evaluate({
      kind: "acknowledgement",
      messageId: msg({ sender: "u-grace" }).id,
    });
    clock.advance(MIN);
    const dmSent = c.autoReply.evaluate({ kind: "stalled_reminder", followupId: followup() });
    const mpHeld = c.autoReply.evaluate({
      kind: "stalled_reminder",
      followupId: followup({ conv: "c-mp", confidence: 0.1 }),
    });
    // An open session has no digest yet.
    expect(c.autoReply.digest()).toBeNull();
    clock.advance(H);
    c.autoReply.setAway(false);
    const d = c.autoReply.digest();
    expect(d?.session).toEqual({
      id: sessionId as string,
      startedAt: NOW,
      endedAt: new Date(Date.parse(NOW) + 2 * MIN + H).toISOString(),
    });
    expect(d?.sent.map((v) => v.id)).toEqual([
      (sent as { autoReplyId: string }).autoReplyId,
      (dmSent as { autoReplyId: string }).autoReplyId,
    ]);
    expect(d?.sent[0]).toMatchObject({
      kind: "acknowledgement",
      decision: "sent",
      reason: null,
      recipient: { slackUserId: ADA, name: "Ada" },
      conversationLabel: "#eng",
      createdAt: NOW,
      outgoingStatus: "pending",
    });
    expect(d?.sent[1]).toMatchObject({
      kind: "stalled_reminder",
      conversationLabel: "Ada",
      threadTs: null,
    });
    expect(d?.held).toHaveLength(2);
    expect(d?.held[0]).toMatchObject({
      id: (held as { autoReplyId: string }).autoReplyId,
      decision: "held",
      reason: "not_priority",
      recipient: { slackUserId: GRACE, name: "Grace" },
      outgoingStatus: null,
    });
    expect(d?.held[1]).toMatchObject({
      id: (mpHeld as { autoReplyId: string }).autoReplyId,
      reason: "low_confidence",
      conversationLabel: "Group DM",
    });
    // Views carry no reply text.
    expect(JSON.stringify(d)).not.toContain("SECRET");
    expect(JSON.stringify(d)).not.toContain("away at the moment");

    expect(c.autoReply.dismissDigest("nope")).toBe(false);
    expect(c.autoReply.dismissDigest(sessionId as string)).toBe(true);
    expect(c.autoReply.digest()).toBeNull();
  });

  test("an open session cannot be dismissed", () => {
    const { sessionId } = c.autoReply.setAway(true);
    expect(c.autoReply.dismissDigest(sessionId as string)).toBe(false);
  });
});

test("events, audit rows and jobs carry ids only, never reply or message text", async () => {
  c.autoReply.setAway(true);
  c.autoReply.evaluate({ kind: "acknowledgement", messageId: msg().id });
  c.autoReply.evaluate({ kind: "stalled_reminder", followupId: followup() });
  c.autoReply.evaluate({
    kind: "stalled_reminder",
    followupId: followup({ confidence: 0.1, text: "SECRET-HELD-DRAFT" }),
  });
  c.autoReply.setAway(false);
  c.dispatcher.dispatchOnce();
  const dump = JSON.stringify([
    c.db.select().from(schema.auditEvents).all(),
    c.db.select().from(schema.domainEvents).all(),
    c.db.select().from(schema.jobs).all(),
    c.db.select().from(schema.notifications).all(),
  ]);
  expect(dump).not.toContain("SECRET");
  expect(dump).not.toContain("away at the moment");
});
