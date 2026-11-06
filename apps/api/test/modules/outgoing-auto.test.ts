import { expect, test } from "bun:test";
import {
  JobError,
  type MessageSink,
  type SendMessageCommand,
  type SendOptions,
  type SendResult,
} from "@synapse/contracts";
import { openDatabase, runMigrations, schema } from "@synapse/database";
import { FakeClock } from "@synapse/shared";
import { eq } from "drizzle-orm";
import { ApprovalEngine, AutoReplyDisabledByPermission } from "../../src/core/approvals/approvals";
import { registerApprovalExecution } from "../../src/core/approvals/execution";
import { AuditLogger } from "../../src/core/audit/audit";
import { SettingsService } from "../../src/core/config/settings";
import { OutboxDispatcher } from "../../src/core/events/dispatcher";
import { LiveBus } from "../../src/core/events/live-bus";
import { EventPublisher } from "../../src/core/events/publisher";
import { JobQueue } from "../../src/core/jobs/queue";
import { type HandlerRegistration, JobWorker } from "../../src/core/jobs/worker";
import { NotificationService } from "../../src/core/notifications/notifications";
import { PermissionManager } from "../../src/core/permissions/permissions";
import { withAutoReplyTag } from "../../src/modules/auto-reply/policy";
import {
  AutoReplyNotFound,
  AutoReplyNotSendable,
  AutoSendBlocked,
  AutoSendMismatch,
  MissingAutoReplyTag,
  OUTGOING_VERIFY_JOB,
  OutgoingService,
} from "../../src/modules/outgoing/service";
import { PeopleService } from "../../src/modules/people/service";
import { SecurityFlagsService } from "../../src/modules/security-flags/service";
import { registerOutgoingJobs } from "../../src/workers/outgoing";

const NOW = "2026-11-06T12:00:00.000Z";
const SECRET = "SECRET-AUTO-REPLY-TEXT see you soon";
const TAGGED = withAutoReplyTag(SECRET);
const CHANNEL = "C0SYNTH01";
const THREAD = "1793880000.000100";

/** Mimics the orchestrator: waits for a slot, then calls `beforeSpawn` just before spawning. */
class FakeSink implements MessageSink {
  /** Commands that reached the (fake) spawn. */
  sends: SendMessageCommand[] = [];
  /** Every call, spawned or not, with its options. */
  calls: { cmd: SendMessageCommand; opts: SendOptions | undefined }[] = [];
  findResults: (boolean | null)[] = [];
  /** Runs while the send "waits for a Claude slot". */
  whileWaiting: () => void = () => {};
  sendImpl: () => Promise<SendResult> = async () => ({ status: "sent_unverified" });
  async send(
    cmd: SendMessageCommand,
    _signal: AbortSignal,
    opts?: SendOptions,
  ): Promise<SendResult> {
    this.calls.push({ cmd, opts });
    this.whileWaiting();
    if (opts?.beforeSpawn && !opts.beforeSpawn()) {
      throw new JobError({
        kind: "cancelled_before_spawn",
        message: "cancelled before spawn",
        details: { notSpawned: true },
      });
    }
    this.sends.push(cmd);
    return this.sendImpl();
  }
  async findSent(): Promise<boolean | null> {
    return this.findResults.shift() ?? false;
  }
}

function setup() {
  const { db } = openDatabase(":memory:");
  runMigrations(db);
  const clock = new FakeClock(NOW);
  const events = new EventPublisher(clock);
  const audit = new AuditLogger(clock);
  const settings = new SettingsService(db, clock, events.publish.bind(events));
  const permissions = new PermissionManager(db, audit);
  const engine = new ApprovalEngine(db, clock, events, audit, permissions);
  const dispatcher = new OutboxDispatcher(db, clock, new LiveBus());
  const queue = new JobQueue(db, clock, { random: () => 0.5 });
  const notifications = new NotificationService(db, clock, new LiveBus());
  const people = new PeopleService({ db, clock, events, audit, settings });
  const securityFlags = new SecurityFlagsService({
    db,
    clock,
    events,
    audit,
    settings,
    notifications,
    people,
  });
  securityFlags.init();
  const sink = new FakeSink();
  const outgoing = new OutgoingService({
    db,
    clock,
    events,
    audit,
    queue,
    settings,
    notifications,
    approvals: engine,
    securityFlags,
    sink,
  });
  const handlers = new Map<string, HandlerRegistration>();
  outgoing.register(engine, dispatcher);
  registerApprovalExecution({ dispatcher, queue, engine, handlers });
  registerOutgoingJobs({ handlers, outgoing });
  const worker = new JobWorker(queue, handlers, { workerId: "w1" });

  settings.set("autoReply.awayMode", true, { emit: false });
  db.insert(schema.awaySessions).values({ id: "s1", startedAt: NOW }).run();

  db.insert(schema.slackUsers).values({ id: "u1", externalId: "UTHEM00001", name: "P" }).run();
  db.insert(schema.slackConversations)
    .values({ id: "c1", externalId: CHANNEL, type: "channel" })
    .run();
  db.insert(schema.slackMessages)
    .values({
      id: "m1",
      conversationId: "c1",
      ts: THREAD,
      senderUserId: "u1",
      text: "origin",
      sentAt: NOW,
      collectedAt: NOW,
    })
    .run();
  db.insert(schema.followups)
    .values({
      id: "f1",
      origin: "stalled",
      originMessageId: "m1",
      conversationId: "c1",
      threadTs: THREAD,
      recipientSlackUserId: "UTHEM00001",
      draftText: SECRET,
      status: "draft",
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run();

  const autoReply = (
    id = "ar1",
    over: { followupId?: string | null; session?: string; threadTs?: string | null } = {},
  ) =>
    db
      .insert(schema.autoReplies)
      .values({
        id,
        sessionId: over.session ?? "s1",
        kind: over.followupId ? "stalled_reminder" : "acknowledgement",
        recipientSlackUserId: "UTHEM00001",
        conversationExternalId: CHANNEL,
        threadTs: over.threadTs === undefined ? THREAD : over.threadTs,
        followupId: over.followupId ?? null,
        decision: "sent",
        text: TAGGED,
        createdAt: NOW,
      })
      .run();

  const requestAuto = (
    over: {
      autoReplyId?: string;
      followupId?: string | null;
      text?: string;
      conversationExternalId?: string;
      threadTs?: string | null;
    } = {},
  ) =>
    db.transaction(
      (tx) =>
        outgoing.requestAutoSend(tx, {
          autoReplyId: over.autoReplyId ?? "ar1",
          conversationExternalId: over.conversationExternalId ?? CHANNEL,
          threadTs: over.threadTs === undefined ? THREAD : over.threadTs,
          text: over.text ?? TAGGED,
          followupId: over.followupId ?? null,
        }),
      { behavior: "immediate" },
    );
  const requestUser = () =>
    db.transaction(
      (tx) =>
        outgoing.requestSend(tx, {
          followupId: null,
          conversationExternalId: CHANNEL,
          threadTs: THREAD,
          text: SECRET,
          requestedByModule: "test",
        }),
      { behavior: "immediate" },
    );
  const out = (id: string) =>
    db.select().from(schema.outgoingMessages).where(eq(schema.outgoingMessages.id, id)).get();
  const ar = (id = "ar1") =>
    db.select().from(schema.autoReplies).where(eq(schema.autoReplies.id, id)).get();
  const approval = (id: string) =>
    db.select().from(schema.approvals).where(eq(schema.approvals.id, id)).get();
  const eventsOf = (type: string) =>
    db.select().from(schema.domainEvents).where(eq(schema.domainEvents.type, type)).all();
  /** Dispatches approval.approved and runs the approval.execute job. */
  const run = async () => {
    dispatcher.dispatchOnce();
    expect(await worker.runOnce()).toBe(true);
    dispatcher.dispatchOnce();
  };
  const runVerify = async () => {
    clock.advance(120_000);
    expect(await worker.runOnce()).toBe(true);
    dispatcher.dispatchOnce();
  };
  const expectNoContent = () => {
    const dump = JSON.stringify([
      db.select().from(schema.auditEvents).all(),
      db.select().from(schema.domainEvents).all(),
      db.select().from(schema.notifications).all(),
      db.select().from(schema.jobs).all(),
      db.select().from(schema.approvals).all(),
      db.select().from(schema.followupHistory).all(),
    ]);
    expect(dump).not.toContain("SECRET");
  };
  return {
    db,
    clock,
    settings,
    permissions,
    engine,
    dispatcher,
    worker,
    sink,
    outgoing,
    autoReply,
    requestAuto,
    requestUser,
    out,
    ar,
    approval,
    eventsOf,
    run,
    runVerify,
    expectNoContent,
  };
}

test("an auto-send is policy-approved, linked, and sent with authorisedBy policy and the tagged text", async () => {
  const s = setup();
  s.autoReply();
  const { outgoingId, approvalId } = s.requestAuto();
  const a = s.approval(approvalId);
  expect(a?.action).toBe("slack.auto_reply");
  expect(a?.status).toBe("approved");
  expect(a?.decidedBy).toBe("policy");
  expect(s.out(outgoingId)?.approvalId).toBe(approvalId);
  expect(s.ar()?.outgoingId).toBe(outgoingId);
  expect(s.ar()?.approvalId).toBe(approvalId);
  // Nothing ever pends for the user.
  expect(s.eventsOf("approval.requested")).toHaveLength(0);

  await s.run();
  expect(s.sink.sends).toHaveLength(1);
  expect(s.sink.sends[0]?.authorisedBy).toBe("policy");
  expect(s.sink.sends[0]?.text).toBe(TAGGED);
  expect(s.sink.sends[0]?.approvalId).toBe(approvalId);
  expect(s.out(outgoingId)?.status).toBe("sent_unverified");
  expect(s.approval(approvalId)?.status).toBe("executed");
  expect(s.ar()?.decision).toBe("sent");
  s.expectNoContent();
});

test("autoreply.sent is emitted exactly once: at sent_unverified, not again at verification", async () => {
  const s = setup();
  s.autoReply();
  const { outgoingId } = s.requestAuto();
  await s.run();
  expect(s.eventsOf("autoreply.sent").map((e) => e.payload)).toEqual([{ autoReplyId: "ar1" }]);
  s.sink.findResults = [true];
  await s.runVerify();
  expect(s.out(outgoingId)?.status).toBe("sent");
  expect(s.eventsOf("autoreply.sent")).toHaveLength(1);
});

test("autoreply.sent is emitted once when an uncertain send is verified sent", async () => {
  const s = setup();
  s.autoReply();
  const { outgoingId } = s.requestAuto();
  s.sink.sendImpl = async () => ({ status: "uncertain", failure: "uncertain_outcome" });
  await s.run();
  expect(s.out(outgoingId)?.status).toBe("needs_attention");
  expect(s.eventsOf("autoreply.sent")).toHaveLength(0);
  s.sink.findResults = [true];
  await s.runVerify();
  expect(s.out(outgoingId)?.status).toBe("sent");
  expect(s.eventsOf("autoreply.sent").map((e) => e.payload)).toEqual([{ autoReplyId: "ar1" }]);
});

test("a follow-up auto-send moves the follow-up to sent and emits autoreply.sent once", async () => {
  const s = setup();
  s.autoReply("ar1", { followupId: "f1" });
  const { outgoingId } = s.requestAuto({ followupId: "f1" });
  await s.run();
  expect(s.sink.sends[0]?.authorisedBy).toBe("policy");
  const f = s.db.select().from(schema.followups).where(eq(schema.followups.id, "f1")).get();
  expect(f?.status).toBe("sent");
  expect(f?.outgoingId).toBe(outgoingId);
  expect(s.eventsOf("followup.sent")).toHaveLength(1);
  expect(s.eventsOf("autoreply.sent")).toHaveLength(1);
  s.expectNoContent();
});

test("revalidate: away switched off before execute cancels the send and holds the auto-reply", async () => {
  const s = setup();
  s.autoReply();
  const { outgoingId, approvalId } = s.requestAuto();
  s.settings.set("autoReply.awayMode", false, { emit: false });
  await s.run();
  expect(s.sink.sends).toHaveLength(0);
  expect(s.approval(approvalId)?.status).toBe("revoked");
  expect(s.out(outgoingId)?.status).toBe("failed");
  expect(s.out(outgoingId)?.failure).toBe("cancelled_away_off");
  expect(s.ar()?.decision).toBe("held");
  expect(s.ar()?.reason).toBe("away_off");
  // A16: a held row keeps no text.
  expect(s.ar()?.text).toBeNull();
  expect(s.eventsOf("autoreply.held").map((e) => e.payload)).toEqual([
    { autoReplyId: "ar1", reason: "away_off" },
  ]);
  expect(s.eventsOf("autoreply.sent")).toHaveLength(0);
  // The revoke consumer later finds nothing to do.
  s.dispatcher.dispatchOnce();
  expect(s.out(outgoingId)?.failure).toBe("cancelled_away_off");
  expect(s.eventsOf("autoreply.held")).toHaveLength(1);
  s.expectNoContent();
});

test("revalidate: a changed away session cancels the send", async () => {
  const s = setup();
  s.autoReply();
  const { outgoingId, approvalId } = s.requestAuto();
  // The user came back and went away again: a new session is open; away is still on.
  s.db
    .update(schema.awaySessions)
    .set({ endedAt: NOW })
    .where(eq(schema.awaySessions.id, "s1"))
    .run();
  s.db.insert(schema.awaySessions).values({ id: "s2", startedAt: NOW }).run();
  await s.run();
  expect(s.sink.sends).toHaveLength(0);
  expect(s.approval(approvalId)?.status).toBe("revoked");
  expect(s.out(outgoingId)?.status).toBe("failed");
  expect(s.out(outgoingId)?.failure).toBe("cancelled_away_off");
  expect(s.ar()?.decision).toBe("held");
  expect(s.ar()?.reason).toBe("away_off");
});

test("revalidate: a follow-up auto-send that is cancelled returns the follow-up to draft", async () => {
  const s = setup();
  s.autoReply("ar1", { followupId: "f1" });
  s.requestAuto({ followupId: "f1" });
  s.settings.set("autoReply.awayMode", false, { emit: false });
  await s.run();
  expect(s.sink.sends).toHaveLength(0);
  const f = s.db.select().from(schema.followups).where(eq(schema.followups.id, "f1")).get();
  expect(f?.status).toBe("draft");
});

test("revalidate: the permission tightened after the request holds with policy_disabled", async () => {
  const s = setup();
  s.autoReply();
  const { outgoingId, approvalId } = s.requestAuto();
  s.permissions.setOverride("slack.auto_reply", "approval_required");
  await s.run();
  expect(s.sink.sends).toHaveLength(0);
  expect(s.approval(approvalId)?.status).toBe("revoked");
  expect(s.out(outgoingId)?.failure).toBe("cancelled_policy_disabled");
  expect(s.ar()?.decision).toBe("held");
  expect(s.ar()?.reason).toBe("policy_disabled");
  expect(s.eventsOf("autoreply.held").map((e) => e.payload)).toEqual([
    { autoReplyId: "ar1", reason: "policy_disabled" },
  ]);
});

test("requestAutoSend throws AutoReplyDisabledByPermission when the user tightened slack.auto_reply; nothing is recorded", () => {
  const s = setup();
  s.autoReply();
  s.permissions.setOverride("slack.auto_reply", "approval_required");
  expect(() => s.requestAuto()).toThrow(AutoReplyDisabledByPermission);
  expect(s.db.select().from(schema.approvals).all()).toHaveLength(0);
  expect(s.db.select().from(schema.outgoingMessages).all()).toHaveLength(0);
  expect(s.ar()?.outgoingId).toBeNull();
  expect(s.sink.sends).toHaveLength(0);
});

test("requestAutoSend refuses text without the auto-reply tag", () => {
  const s = setup();
  s.autoReply();
  expect(() => s.requestAuto({ text: SECRET })).toThrow(MissingAutoReplyTag);
  expect(s.db.select().from(schema.outgoingMessages).all()).toHaveLength(0);
  expect(s.db.select().from(schema.approvals).all()).toHaveLength(0);
});

test("requestAutoSend refuses an unknown auto-reply", () => {
  const s = setup();
  expect(() => s.requestAuto({ autoReplyId: "nope" })).toThrow(AutoReplyNotFound);
  expect(s.db.select().from(schema.outgoingMessages).all()).toHaveLength(0);
  expect(s.db.select().from(schema.approvals).all()).toHaveLength(0);
});

test("a slack.send user approval still sends with authorisedBy user and emits no autoreply event", async () => {
  const s = setup();
  const { approvalId } = s.requestUser();
  s.engine.approve(approvalId);
  await s.run();
  expect(s.sink.sends).toHaveLength(1);
  expect(s.sink.sends[0]?.authorisedBy).toBe("user");
  expect(s.sink.calls[0]?.opts?.beforeSpawn).toBeUndefined();
  expect(s.approval(approvalId)?.decidedBy).toBe("user");
  expect(s.eventsOf("autoreply.sent")).toHaveLength(0);
});

test("a user revoke of a still-unexecuted auto-send cancels the outgoing row", async () => {
  const s = setup();
  s.autoReply();
  const { outgoingId, approvalId } = s.requestAuto();
  s.engine.revoke(approvalId, "user");
  await s.run();
  expect(s.sink.sends).toHaveLength(0);
  expect(s.out(outgoingId)?.status).toBe("failed");
  expect(s.out(outgoingId)?.failure).toBe("revoked");
  // M3: decision is the policy's verdict; delivery is the outgoing status.
  expect(s.ar()?.decision).toBe("sent");
  expect(s.ar()?.text).toBe(TAGGED);
  expect(s.eventsOf("autoreply.held")).toHaveLength(0);
});

test("verify jobs exist only for real sends", async () => {
  const s = setup();
  s.autoReply();
  s.requestAuto();
  s.settings.set("autoReply.awayMode", false, { emit: false });
  await s.run();
  const verify = s.db.select().from(schema.jobs).where(eq(schema.jobs.type, OUTGOING_VERIFY_JOB));
  expect(verify.all()).toHaveLength(0);
});

test("claim: away switched off after revalidate but before the claim still cancels; the approval fails", async () => {
  const s = setup();
  s.autoReply();
  const { outgoingId, approvalId } = s.requestAuto();
  const realGet = s.settings.get.bind(s.settings);
  let awayReads = 0;
  // The first read (revalidate) sees away on; the claim's read sees the user back.
  s.settings.get = ((key: Parameters<typeof realGet>[0]) => {
    if (key === "autoReply.awayMode") return ++awayReads === 1;
    return realGet(key);
  }) as typeof s.settings.get;
  await s.run();
  expect(awayReads).toBe(2);
  expect(s.sink.sends).toHaveLength(0);
  expect(s.approval(approvalId)?.status).toBe("failed");
  expect(s.out(outgoingId)?.failure).toBe("cancelled_away_off");
  expect(s.ar()?.decision).toBe("held");
  expect(s.ar()?.reason).toBe("away_off");
  expect(s.eventsOf("autoreply.held")).toHaveLength(1);
});

test("engine claim: the gate shutting after revalidate revokes, and the revoke consumer holds", async () => {
  const s = setup();
  s.autoReply();
  const { outgoingId, approvalId } = s.requestAuto();
  let calls = 0;
  // Open for revalidate, shut from the engine's claim on.
  s.permissions.policyGateOpen = () => ++calls === 1;
  await s.run();
  expect(s.sink.sends).toHaveLength(0);
  expect(s.approval(approvalId)?.status).toBe("revoked");
  expect(s.out(outgoingId)?.failure).toBe("cancelled_policy_disabled");
  expect(s.ar()?.decision).toBe("held");
  expect(s.ar()?.reason).toBe("policy_disabled");
  expect(s.eventsOf("autoreply.held")).toHaveLength(1);
});

test("requestAutoSend refuses an auto-reply that is held or already has a send", () => {
  const s = setup();
  s.autoReply();
  s.requestAuto();
  expect(() => s.requestAuto()).toThrow(AutoReplyNotSendable);
  expect(s.db.select().from(schema.outgoingMessages).all()).toHaveLength(1);
});

// I1: requestAutoSend never trusts its caller; every field must equal the auto_replies row.
const expectNothingRecorded = (s: ReturnType<typeof setup>) => {
  expect(s.db.select().from(schema.outgoingMessages).all()).toHaveLength(0);
  expect(s.db.select().from(schema.approvals).all()).toHaveLength(0);
  expect(s.ar()?.outgoingId ?? null).toBeNull();
};

test("I1: a conversation differing from the auto-reply row throws AutoSendMismatch", () => {
  const s = setup();
  s.autoReply();
  expect(() => s.requestAuto({ conversationExternalId: "C0OTHER01" })).toThrow(AutoSendMismatch);
  expectNothingRecorded(s);
});

test("I1: a thread differing from the auto-reply row throws AutoSendMismatch (null vs ts too)", () => {
  const s = setup();
  s.autoReply();
  expect(() => s.requestAuto({ threadTs: "1793880000.000999" })).toThrow(AutoSendMismatch);
  expect(() => s.requestAuto({ threadTs: null })).toThrow(AutoSendMismatch);
  expectNothingRecorded(s);
});

test("I1: a null thread on both sides matches", async () => {
  const s = setup();
  s.autoReply("ar1", { threadTs: null });
  s.requestAuto({ threadTs: null });
  await s.run();
  expect(s.sink.sends).toHaveLength(1);
  expect(s.sink.sends[0]?.threadTs).toBeUndefined();
});

test("I1: text differing from the auto-reply row throws AutoSendMismatch; trailing whitespace is ignored", () => {
  const s = setup();
  s.autoReply();
  expect(() => s.requestAuto({ text: withAutoReplyTag(`${SECRET} edited`) })).toThrow(
    AutoSendMismatch,
  );
  expectNothingRecorded(s);
  s.requestAuto({ text: `${TAGGED}  \n` });
  expect(s.db.select().from(schema.outgoingMessages).all()).toHaveLength(1);
});

test("I1: a follow-up differing from the auto-reply row throws AutoSendMismatch", () => {
  const s = setup();
  s.autoReply();
  expect(() => s.requestAuto({ followupId: "f1" })).toThrow(AutoSendMismatch);
  expectNothingRecorded(s);
  const t = setup();
  t.autoReply("ar1", { followupId: "f1" });
  expect(() => t.requestAuto({ followupId: null })).toThrow(AutoSendMismatch);
  expectNothingRecorded(t);
});

test("I1: AutoSendMismatch carries ids only", () => {
  const s = setup();
  s.autoReply();
  try {
    s.requestAuto({ text: withAutoReplyTag("SECRET-OTHER") });
    throw new Error("expected AutoSendMismatch");
  } catch (e) {
    expect(e).toBeInstanceOf(AutoSendMismatch);
    expect(JSON.stringify({ m: (e as Error).message, ...(e as object) })).not.toContain("SECRET");
  }
});

test("I1: revalidate refuses an approval whose payload names another auto-reply", async () => {
  const s = setup();
  s.autoReply();
  s.autoReply("ar2");
  const { approvalId } = s.requestAuto();
  const a = s.approval(approvalId);
  s.db
    .update(schema.approvals)
    .set({ payload: { ...(a?.payload as object), autoReplyId: "ar2" } })
    .where(eq(schema.approvals.id, approvalId))
    .run();
  await s.run();
  expect(s.sink.calls).toHaveLength(0);
  expect(s.approval(approvalId)?.executionStartedAt).toBeNull();
});

// M2: blocked up front, nothing recorded.
test("M2: requestAutoSend while away is off throws AutoSendBlocked away_off", () => {
  const s = setup();
  s.autoReply();
  s.settings.set("autoReply.awayMode", false, { emit: false });
  try {
    s.requestAuto();
    throw new Error("expected AutoSendBlocked");
  } catch (e) {
    expect(e).toBeInstanceOf(AutoSendBlocked);
    expect((e as AutoSendBlocked).reason).toBe("away_off");
  }
  expectNothingRecorded(s);
});

test("M2: requestAutoSend for a closed session throws AutoSendBlocked away_off", () => {
  const s = setup();
  s.db.insert(schema.awaySessions).values({ id: "old", startedAt: NOW, endedAt: NOW }).run();
  s.autoReply("ar1", { session: "old" });
  expect(() => s.requestAuto()).toThrow(AutoSendBlocked);
  expectNothingRecorded(s);
});

// M3
test("M3: mark_sent from needs_attention emits autoreply.sent once", async () => {
  const s = setup();
  s.autoReply();
  const { outgoingId } = s.requestAuto();
  s.sink.sendImpl = async () => ({ status: "uncertain", failure: "uncertain_outcome" });
  await s.run();
  expect(s.out(outgoingId)?.status).toBe("needs_attention");
  s.outgoing.resolveNeedsAttention(outgoingId, "mark_sent");
  expect(s.out(outgoingId)?.status).toBe("sent");
  expect(s.eventsOf("autoreply.sent").map((e) => e.payload)).toEqual([{ autoReplyId: "ar1" }]);
});

test("M3: the slack.send executor refuses a policy approval (approval_kind_mismatch)", async () => {
  const s = setup();
  s.autoReply();
  const { outgoingId, approvalId } = s.requestAuto();
  // Route the policy approval to the user-send executor.
  s.db
    .update(schema.approvals)
    .set({ action: "slack.send" })
    .where(eq(schema.approvals.id, approvalId))
    .run();
  // The engine's own claim check would revoke it first (slack.send is not policy-gated); open it
  // so the executor's check is what is exercised.
  s.permissions.policyGateOpen = () => true;
  await s.run();
  expect(s.sink.calls).toHaveLength(0);
  expect(s.out(outgoingId)?.status).toBe("pending");
  expect(s.approval(approvalId)?.executionResult).toMatchObject({
    status: "skipped",
    reason: "approval_kind_mismatch",
  });
});

test("M3: the engine itself revokes a policy approval routed to a non-policy-gated action", async () => {
  const s = setup();
  s.autoReply();
  const { approvalId } = s.requestAuto();
  s.db
    .update(schema.approvals)
    .set({ action: "slack.send" })
    .where(eq(schema.approvals.id, approvalId))
    .run();
  await s.run();
  expect(s.sink.calls).toHaveLength(0);
  expect(s.approval(approvalId)?.status).toBe("revoked");
});

// M4
test("M4: a policy_disabled revoke holds policy_disabled even if the gate reopened before the consumer", async () => {
  const s = setup();
  s.autoReply();
  const { outgoingId, approvalId } = s.requestAuto();
  let calls = 0;
  // Open for revalidate, shut at the engine's claim, open again for the revoke consumer.
  s.permissions.policyGateOpen = () => ++calls !== 2;
  await s.run();
  expect(calls).toBeGreaterThanOrEqual(2);
  expect(s.sink.calls).toHaveLength(0);
  expect(s.approval(approvalId)?.status).toBe("revoked");
  expect(s.out(outgoingId)?.failure).toBe("cancelled_policy_disabled");
  expect(s.ar()?.decision).toBe("held");
  expect(s.ar()?.reason).toBe("policy_disabled");
});

// Concern 3
test("follow-up history for an auto-send says auto_send_requested", () => {
  const s = setup();
  s.autoReply("ar1", { followupId: "f1" });
  s.requestAuto({ followupId: "f1" });
  const history = s.db
    .select()
    .from(schema.followupHistory)
    .where(eq(schema.followupHistory.followupId, "f1"))
    .all()
    .map((h) => h.event);
  expect(history).toContain("auto_send_requested");
  expect(history).not.toContain("send_requested");
});

// I2: away ends while the run waits for a Claude slot.
test("I2: away switched off while waiting for a slot cancels before spawn; held away_off, never uncertain", async () => {
  const s = setup();
  s.autoReply("ar1", { followupId: "f1" });
  const { outgoingId, approvalId } = s.requestAuto({ followupId: "f1" });
  s.sink.whileWaiting = () => s.settings.set("autoReply.awayMode", false, { emit: false });
  await s.run();
  expect(s.sink.calls).toHaveLength(1);
  expect(s.sink.calls[0]?.opts?.beforeSpawn).toBeFunction();
  expect(s.sink.sends).toHaveLength(0);
  expect(s.out(outgoingId)?.status).toBe("failed");
  expect(s.out(outgoingId)?.failure).toBe("cancelled_away_off");
  expect(s.approval(approvalId)?.status).toBe("failed");
  expect(s.ar()?.decision).toBe("held");
  expect(s.ar()?.reason).toBe("away_off");
  expect(s.ar()?.text).toBeNull();
  expect(s.eventsOf("autoreply.held")).toHaveLength(1);
  expect(s.eventsOf("autoreply.sent")).toHaveLength(0);
  const f = s.db.select().from(schema.followups).where(eq(schema.followups.id, "f1")).get();
  expect(f?.status).toBe("draft");
  // Never uncertain: nothing to verify, nothing for the user to resolve.
  const verify = s.db.select().from(schema.jobs).where(eq(schema.jobs.type, OUTGOING_VERIFY_JOB));
  expect(verify.all()).toHaveLength(0);
  s.expectNoContent();
});

test("I2: the gate shutting while waiting for a slot holds policy_disabled", async () => {
  const s = setup();
  s.autoReply();
  const { outgoingId } = s.requestAuto();
  s.sink.whileWaiting = () => s.permissions.setOverride("slack.auto_reply", "approval_required");
  await s.run();
  expect(s.sink.sends).toHaveLength(0);
  expect(s.out(outgoingId)?.failure).toBe("cancelled_policy_disabled");
  expect(s.ar()?.reason).toBe("policy_disabled");
});

test("I2: a new away session opened while waiting cancels the send", async () => {
  const s = setup();
  s.autoReply();
  const { outgoingId } = s.requestAuto();
  s.sink.whileWaiting = () => {
    s.db
      .update(schema.awaySessions)
      .set({ endedAt: NOW })
      .where(eq(schema.awaySessions.id, "s1"))
      .run();
    s.db.insert(schema.awaySessions).values({ id: "s2", startedAt: NOW }).run();
  };
  await s.run();
  expect(s.sink.sends).toHaveLength(0);
  expect(s.out(outgoingId)?.failure).toBe("cancelled_away_off");
  expect(s.ar()?.reason).toBe("away_off");
});
