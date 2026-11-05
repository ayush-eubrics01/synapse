import { beforeEach, describe, expect, test } from "bun:test";
import {
  type Approval,
  JobError,
  type MessageSink,
  type SendMessageCommand,
  type SendResult,
} from "@synapse/contracts";
import { openDatabase, runMigrations, schema, type Tx } from "@synapse/database";
import { FakeClock } from "@synapse/shared";
import { and, eq } from "drizzle-orm";
import { createContainer } from "../../src/container";
import { ApprovalEngine } from "../../src/core/approvals/approvals";
import { registerApprovalExecution } from "../../src/core/approvals/execution";
import { AuditLogger } from "../../src/core/audit/audit";
import { loadConfig } from "../../src/core/config/config";
import { SettingsService } from "../../src/core/config/settings";
import { OutboxDispatcher } from "../../src/core/events/dispatcher";
import { LiveBus } from "../../src/core/events/live-bus";
import { EventPublisher } from "../../src/core/events/publisher";
import { JobQueue } from "../../src/core/jobs/queue";
import { type HandlerRegistration, JobWorker } from "../../src/core/jobs/worker";
import { NotificationService } from "../../src/core/notifications/notifications";
import { PermissionManager } from "../../src/core/permissions/permissions";
import { reapExpiredJobs } from "../../src/core/recovery/recovery";
import {
  FollowupNotFound,
  InvalidOutgoingText,
  OUTGOING_VERIFY_JOB,
  OutgoingNotFound,
  OutgoingService,
  ResolveNotAllowed,
  SendAlreadyPending,
} from "../../src/modules/outgoing/service";
import { PeopleService } from "../../src/modules/people/service";
import { SecurityFlagsService } from "../../src/modules/security-flags/service";
import { registerOutgoingJobs } from "../../src/workers/outgoing";

const NOW = "2026-11-06T12:00:00.000Z";
const NOW_SECONDS = Date.parse(NOW) / 1000;
const SECRET = "SECRET-OUTGOING-TEXT please ship";
const CHANNEL = "C0SYNTH01";
const THREAD = "1793880000.000100";

class FakeSink implements MessageSink {
  sends: SendMessageCommand[] = [];
  finds: { cmd: SendMessageCommand; sinceTs: string }[] = [];
  sendImpl: (cmd: SendMessageCommand) => Promise<SendResult> = async () => ({
    status: "sent_unverified",
  });
  findResults: (boolean | null)[] = [];

  async send(cmd: SendMessageCommand, _signal: AbortSignal): Promise<SendResult> {
    this.sends.push(cmd);
    return this.sendImpl(cmd);
  }

  async findSent(cmd: SendMessageCommand, sinceTs: string): Promise<boolean | null> {
    this.finds.push({ cmd, sinceTs });
    return this.findResults.length > 0 ? (this.findResults.shift() ?? null) : false;
  }
}

type Setup = ReturnType<typeof setup>;

function setup(opts: { failVerifyEnqueue?: { on: boolean } } = {}) {
  const { db } = openDatabase(":memory:");
  runMigrations(db);
  const clock = new FakeClock(NOW);
  const events = new EventPublisher(clock);
  const audit = new AuditLogger(clock);
  const settings = new SettingsService(db, clock, events.publish.bind(events));
  const permissions = new PermissionManager(db, audit);
  const engine = new ApprovalEngine(db, clock, events, audit, permissions);
  const dispatcher = new OutboxDispatcher(db, clock, new LiveBus());
  const realQueue = new JobQueue(db, clock, { random: () => 0.5 });
  const fail = opts.failVerifyEnqueue;
  const queue = fail
    ? {
        enqueue: (...args: Parameters<JobQueue["enqueue"]>) => {
          if (fail.on && args[1].type === OUTGOING_VERIFY_JOB) throw new Error("enqueue failed");
          return realQueue.enqueue(...args);
        },
      }
    : realQueue;
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
  registerApprovalExecution({ dispatcher, queue: realQueue, engine, handlers });
  registerOutgoingJobs({ handlers, outgoing });
  const worker = new JobWorker(realQueue, handlers, { workerId: "w1" });

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
  const followup = (id = "f1") =>
    db
      .insert(schema.followups)
      .values({
        id,
        origin: "urgent_reply",
        originMessageId: "m1",
        conversationId: "c1",
        threadTs: THREAD,
        recipientSlackUserId: "UTHEM00001",
        draftText: SECRET,
        status: "awaiting_approval",
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
  followup();

  const request = (over: { followupId?: string | null; text?: string } = {}) =>
    db.transaction(
      (tx) =>
        outgoing.requestSend(tx, {
          followupId: over.followupId === undefined ? "f1" : over.followupId,
          conversationExternalId: CHANNEL,
          threadTs: THREAD,
          text: over.text ?? SECRET,
          requestedByModule: "test",
        }),
      { behavior: "immediate" },
    );
  const out = (id: string) =>
    db.select().from(schema.outgoingMessages).where(eq(schema.outgoingMessages.id, id)).get();
  const fu = (id = "f1") =>
    db.select().from(schema.followups).where(eq(schema.followups.id, id)).get();
  const approval = (id: string) =>
    db.select().from(schema.approvals).where(eq(schema.approvals.id, id)).get();
  const eventsOf = (type: string) =>
    db.select().from(schema.domainEvents).where(eq(schema.domainEvents.type, type)).all();
  const verifyJobs = () =>
    db.select().from(schema.jobs).where(eq(schema.jobs.type, OUTGOING_VERIFY_JOB)).all();
  const notes = () => db.select().from(schema.notifications).all();
  const approveAndRun = async (approvalId: string) => {
    engine.approve(approvalId);
    dispatcher.dispatchOnce();
    expect(await worker.runOnce()).toBe(true);
  };
  /** Moves the clock to the next verify job and runs it. */
  const runVerify = async () => {
    clock.advance(120_000);
    return worker.runOnce();
  };
  const expectNoContent = () => {
    const dump = JSON.stringify([
      db.select().from(schema.auditEvents).all(),
      db.select().from(schema.domainEvents).all(),
      db.select().from(schema.notifications).all(),
      db.select().from(schema.jobs).all(),
      db.select().from(schema.approvals).all(),
      db.select().from(schema.followupHistory).all(),
      db.select().from(schema.securityFlags).all(),
      db.select().from(schema.eventConsumptions).all(),
    ]);
    expect(dump).not.toContain("SECRET");
  };
  return {
    db,
    clock,
    engine,
    dispatcher,
    realQueue,
    settings,
    audit,
    sink,
    outgoing,
    worker,
    followup,
    request,
    out,
    fu,
    approval,
    eventsOf,
    verifyJobs,
    notes,
    approveAndRun,
    runVerify,
    expectNoContent,
  };
}

const toApproval = (s: Setup, id: string): Approval => {
  const r = s.approval(id);
  if (!r) throw new Error("missing approval");
  return {
    id: r.id,
    action: "slack.send",
    targetIntegration: r.targetIntegration ?? "",
    targetRef: r.targetRef ?? "",
    payload: r.payload,
    riskLevel: "medium",
    status: r.status,
    requestedByModule: r.requestedByModule ?? "",
    requestedByWorker: r.requestedByWorker,
    expiresAt: r.expiresAt,
    decidedAt: r.decidedAt,
    executionResult: r.executionResult,
    idempotencyKey: r.idempotencyKey,
    createdAt: r.createdAt,
  };
};

const tick = () => new Promise((r) => setTimeout(r, 0));

let s: Setup;
beforeEach(() => {
  s = setup();
});

describe("requestSend", () => {
  test("creates a pending outgoing message and a slack.send approval with the exact values", () => {
    const { outgoingId, approvalId } = s.request({ text: `${SECRET}  \n ` });
    const o = s.out(outgoingId);
    expect(o?.status).toBe("pending");
    expect(o?.text).toBe(SECRET);
    expect(o?.approvalId).toBe(approvalId);
    expect(o?.followupId).toBe("f1");
    expect(o?.conversationExternalId).toBe(CHANNEL);
    expect(o?.threadTs).toBe(THREAD);
    const a = s.approval(approvalId);
    expect(a?.action).toBe("slack.send");
    expect(a?.targetIntegration).toBe("slack");
    expect(a?.targetRef).toBe(CHANNEL);
    expect(a?.payload).toEqual({ outgoingId });
    expect(a?.riskLevel).toBe("medium");
    expect(a?.idempotencyKey).toBe(`outgoing:${outgoingId}`);
    expect(a?.expiresAt).toBe("2026-11-13T12:00:00.000Z");
    expect(a?.status).toBe("pending");
    const f = s.fu();
    expect(f?.status).toBe("awaiting_approval");
    expect(f?.approvalId).toBe(approvalId);
    expect(f?.outgoingId).toBe(outgoingId);
    s.expectNoContent();
  });

  test("text must be 1..4000 characters after trimming trailing whitespace", () => {
    expect(() => s.request({ text: "   \n" })).toThrow(InvalidOutgoingText);
    expect(() => s.request({ text: "x".repeat(4001) })).toThrow(InvalidOutgoingText);
    const { outgoingId } = s.request({ text: `${"x".repeat(4000)}   ` });
    expect(s.out(outgoingId)?.text).toHaveLength(4000);
  });

  test("a live outgoing message for the followup blocks a second request", () => {
    const first = s.request();
    expect(() => s.request()).toThrow(SendAlreadyPending);
    for (const status of ["sending", "sent_unverified", "needs_attention"] as const) {
      s.db
        .update(schema.outgoingMessages)
        .set({ status })
        .where(eq(schema.outgoingMessages.id, first.outgoingId))
        .run();
      expect(() => s.request()).toThrow(SendAlreadyPending);
    }
    s.db
      .update(schema.outgoingMessages)
      .set({ status: "failed" })
      .where(eq(schema.outgoingMessages.id, first.outgoingId))
      .run();
    expect(s.request().outgoingId).not.toBe(first.outgoingId);
  });

  test("an unknown followup is refused", () => {
    expect(() => s.request({ followupId: "nope" })).toThrow(FollowupNotFound);
  });
});

describe("slack.send executor", () => {
  test("request -> approve -> sent_unverified -> verify true -> sent; one send, followup.sent once", async () => {
    const { outgoingId, approvalId } = s.request();
    await s.approveAndRun(approvalId);

    expect(s.sink.sends).toHaveLength(1);
    const cmd = s.sink.sends[0];
    expect(cmd?.outgoingId).toBe(outgoingId);
    expect(cmd?.approvalId).toBe(approvalId);
    expect(cmd?.conversationExternalId).toBe(CHANNEL);
    expect(cmd?.threadTs).toBe(THREAD);
    expect(cmd?.text).toBe(SECRET);
    const execJob = s.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.idempotencyKey, `approval.execute:${approvalId}`))
      .get();
    expect(cmd?.jobId).toBe(execJob?.id);

    let o = s.out(outgoingId);
    expect(o?.status).toBe("sent_unverified");
    expect(o?.sendingAt).toBe(NOW);
    expect(o?.sentAt).toBe(NOW);
    expect(s.approval(approvalId)?.status).toBe("executed");
    expect(s.fu()?.status).toBe("sent");
    expect(s.eventsOf("followup.sent")).toHaveLength(1);
    expect(s.eventsOf("outgoing.status_changed").length).toBeGreaterThan(0);
    const sent = s.db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, "slack.sent"))
      .all();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.approvalId).toBe(approvalId);

    const jobs = s.verifyJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.idempotencyKey).toBe(`outgoing.verify:${outgoingId}:1`);
    expect(jobs[0]?.priority).toBe(170);
    expect(jobs[0]?.externalWrite).toBe(false);
    expect(jobs[0]?.runAfter).toBe("2026-11-06T12:02:00.000Z");

    s.sink.findResults = [true];
    expect(await s.runVerify()).toBe(true);
    expect(s.sink.finds).toHaveLength(1);
    expect(s.sink.finds[0]?.sinceTs).toBe((NOW_SECONDS - 5).toFixed(6));
    o = s.out(outgoingId);
    expect(o?.status).toBe("sent");
    expect(o?.verifiedAt).toBe("2026-11-06T12:02:00.000Z");
    expect(s.sink.sends).toHaveLength(1);
    expect(s.eventsOf("followup.sent")).toHaveLength(1);
    expect(s.verifyJobs()).toHaveLength(1);
    s.expectNoContent();
  });

  test("the executor skips without sending unless the outgoing message is pending with its approval", async () => {
    const { outgoingId, approvalId } = s.request();
    s.engine.approve(approvalId);
    for (const status of ["sending", "sent_unverified", "sent", "needs_attention", "failed"]) {
      s.db
        .update(schema.outgoingMessages)
        .set({ status: status as "sending" })
        .where(eq(schema.outgoingMessages.id, outgoingId))
        .run();
      const r = await s.outgoing.execute(toApproval(s, approvalId));
      expect(r).toMatchObject({ status: "skipped" });
    }
    s.db
      .update(schema.outgoingMessages)
      .set({ status: "pending" })
      .where(eq(schema.outgoingMessages.id, outgoingId))
      .run();
    const other = { ...toApproval(s, approvalId), id: "another-approval" };
    expect(await s.outgoing.execute(other)).toMatchObject({
      status: "skipped",
      reason: "approval_mismatch",
    });
    expect(s.sink.sends).toHaveLength(0);
  });

  test("uncertain -> needs_attention, never sent again, then verify true -> sent and followup.sent once", async () => {
    s.sink.sendImpl = async () => ({ status: "uncertain", failure: "uncertain_outcome" });
    const { outgoingId, approvalId } = s.request();
    await s.approveAndRun(approvalId);
    let o = s.out(outgoingId);
    expect(o?.status).toBe("needs_attention");
    expect(o?.failure).toBe("uncertain_outcome");
    expect(s.approval(approvalId)?.status).toBe("executed");
    expect(s.fu()?.status).toBe("needs_attention");
    expect(s.eventsOf("followup.sent")).toHaveLength(0);
    expect(s.verifyJobs().map((j) => j.idempotencyKey)).toEqual([
      `outgoing.verify:${outgoingId}:1`,
    ]);

    // Nothing can send it again: the engine, a forced executor call, a new request.
    expect((await s.engine.execute(approvalId)).status).toBe("executed");
    expect(await s.outgoing.execute(toApproval(s, approvalId))).toMatchObject({
      status: "skipped",
    });
    expect(() => s.request()).toThrow(SendAlreadyPending);
    expect(s.sink.sends).toHaveLength(1);

    s.sink.findResults = [true];
    await s.runVerify();
    o = s.out(outgoingId);
    expect(o?.status).toBe("sent");
    expect(s.fu()?.status).toBe("sent");
    expect(s.eventsOf("followup.sent")).toHaveLength(1);
    expect(s.sink.sends).toHaveLength(1);
    s.expectNoContent();
  });

  test("verify false or unknown until max attempts: sent_unverified stays, failure unverified, notification", async () => {
    const { outgoingId, approvalId } = s.request();
    await s.approveAndRun(approvalId);
    s.sink.findResults = [false, null, false, null, false];
    for (let i = 0; i < 5; i++) expect(await s.runVerify()).toBe(true);
    expect(await s.runVerify()).toBe(false);
    const o = s.out(outgoingId);
    expect(o?.status).toBe("sent_unverified");
    expect(o?.failure).toBe("unverified");
    expect(o?.verifyAttempts).toBe(5);
    expect(s.verifyJobs().map((j) => j.idempotencyKey)).toEqual(
      [1, 2, 3, 4, 5].map((n) => `outgoing.verify:${outgoingId}:${n}`),
    );
    expect(s.notes()).toHaveLength(1);
    expect(s.notes()[0]?.ref).toBe(outgoingId);
    expect(s.sink.sends).toHaveLength(1);
    expect(s.eventsOf("followup.sent")).toHaveLength(1);
    s.expectNoContent();
  });

  test("verify false until max attempts: needs_attention stays needs_attention, with a notification", async () => {
    s.sink.sendImpl = async () => ({ status: "uncertain", failure: "uncertain_outcome" });
    s.settings.set("outgoing.verify.maxAttempts", 2);
    const { outgoingId, approvalId } = s.request();
    await s.approveAndRun(approvalId);
    await s.runVerify();
    await s.runVerify();
    expect(await s.runVerify()).toBe(false);
    const o = s.out(outgoingId);
    expect(o?.status).toBe("needs_attention");
    expect(o?.failure).toBe("uncertain_outcome");
    expect(o?.verifyAttempts).toBe(2);
    expect(s.notes()).toHaveLength(1);
    expect(s.fu()?.status).toBe("needs_attention");
    expect(s.sink.sends).toHaveLength(1);
  });

  test("argument_mismatch (R5): needs_attention, high runtime flag, notification, never back to draft", async () => {
    s.db
      .insert(schema.claudeRuns)
      .values({ id: "run-1", workerProfile: "collector", status: "completed", startedAt: NOW })
      .run();
    s.sink.sendImpl = async () => ({
      status: "failed",
      failure: "argument_mismatch",
      mismatch: true,
      runId: "run-1",
    });
    const { outgoingId, approvalId } = s.request();
    await s.approveAndRun(approvalId);
    const o = s.out(outgoingId);
    expect(o?.status).toBe("needs_attention");
    expect(o?.failure).toBe("argument_mismatch");
    expect(o?.claudeRunId).toBe("run-1");
    expect(s.approval(approvalId)?.status).toBe("executed");
    expect(s.fu()?.status).not.toBe("draft");
    expect(s.verifyJobs()).toHaveLength(0);
    const flags = s.db.select().from(schema.securityFlags).all();
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({
      messageId: "m1",
      detector: "runtime",
      severity: "high",
      claudeRunId: "run-1",
    });
    const blocked = s
      .notes()
      .filter((n) => n.title === "Send blocked: arguments changed — check Slack");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.severity).toBe("high");
    expect(() => s.request()).toThrow(SendAlreadyPending);
    expect(s.sink.sends).toHaveLength(1);
    s.expectNoContent();
  });

  test("uncertain with mismatch is treated as argument_mismatch, no verify", async () => {
    s.sink.sendImpl = async () => ({
      status: "uncertain",
      failure: "uncertain_outcome",
      mismatch: true,
    });
    const { outgoingId, approvalId } = s.request();
    await s.approveAndRun(approvalId);
    expect(s.out(outgoingId)?.failure).toBe("argument_mismatch");
    expect(s.out(outgoingId)?.status).toBe("needs_attention");
    expect(s.verifyJobs()).toHaveLength(0);
    // no run id: the flag is still raised against the origin message
    expect(s.db.select().from(schema.securityFlags).all()).toHaveLength(1);
  });

  test("a definitive failure (tool_error, no_send) fails the approval and returns the draft", async () => {
    for (const failure of ["tool_error", "no_send"]) {
      const t = setup();
      t.sink.sendImpl = async () => ({ status: "failed", failure });
      const { outgoingId, approvalId } = t.request();
      await t.approveAndRun(approvalId);
      const o = t.out(outgoingId);
      expect(o?.status).toBe("failed");
      expect(o?.failure).toBe(failure);
      const a = t.approval(approvalId);
      expect(a?.status).toBe("failed");
      expect(a?.executionResult).toEqual({ error: `slack send failed: ${failure}` });
      expect(t.fu()?.status).toBe("draft");
      expect(t.verifyJobs()).toHaveLength(0);
      expect(t.request().outgoingId).not.toBe(outgoingId);
      expect(t.sink.sends).toHaveLength(1);
      t.expectNoContent();
    }
  });

  test("a failure before spawn (sink rethrow) sends nothing: not_started, approval failed, draft again", async () => {
    s.sink.sendImpl = async () => {
      throw new JobError({ kind: "quota_exhausted", message: "quota stop" });
    };
    const { outgoingId, approvalId } = s.request();
    const logs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void logs.push(a.join(" "));
    try {
      await s.approveAndRun(approvalId);
    } finally {
      console.error = orig;
    }
    expect(logs).toEqual([`outgoing send not started outgoing=${outgoingId} error=JobError`]);
    expect(s.sink.sends).toHaveLength(1);
    const o = s.out(outgoingId);
    expect(o?.status).toBe("failed");
    expect(o?.failure).toBe("not_started");
    expect(s.approval(approvalId)?.status).toBe("failed");
    expect(s.approval(approvalId)?.executionResult).toEqual({
      error: "slack send failed: not_started",
    });
    expect(s.fu()?.status).toBe("draft");
    expect(s.verifyJobs()).toHaveLength(0);
    s.expectNoContent();
  });

  test("a crash during execution (lease expiry) parks the job and never re-executes; the sweep hands it to the user", async () => {
    s.sink.sendImpl = () => new Promise<SendResult>(() => {}); // the process dies mid-send
    const { outgoingId, approvalId } = s.request();
    s.engine.approve(approvalId);
    s.dispatcher.dispatchOnce();
    const job = s.realQueue.claim("dead-worker", 60_000, ["approval.execute"]);
    expect(job).not.toBeNull();
    void s.engine.execute(approvalId);
    for (let i = 0; i < 5; i++) await tick();
    expect(s.sink.sends).toHaveLength(1);
    expect(s.out(outgoingId)?.status).toBe("sending");

    const sweeps = [{ name: "outgoing.sending", run: (tx: Tx) => s.outgoing.recoverySweep(tx) }];
    s.clock.advance(61_000);
    reapExpiredJobs({ db: s.db, clock: s.clock, audit: s.audit, sweeps });
    const parked = s.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.id, job?.id ?? ""))
      .get();
    expect(parked?.status).toBe("NEEDS_ATTENTION");
    expect(s.out(outgoingId)?.status).toBe("sending"); // under 10 minutes: left alone
    expect(await s.worker.runOnce()).toBe(false);
    expect((await s.engine.execute(approvalId)).status).toBe("skipped");
    expect(await s.outgoing.execute(toApproval(s, approvalId))).toMatchObject({
      status: "skipped",
    });
    expect(() => s.request()).toThrow(SendAlreadyPending);

    s.clock.advance(10 * 60_000);
    reapExpiredJobs({ db: s.db, clock: s.clock, audit: s.audit, sweeps });
    const o = s.out(outgoingId);
    expect(o?.status).toBe("needs_attention");
    expect(o?.failure).toBe("uncertain_outcome");
    expect(s.fu()?.status).toBe("needs_attention");
    expect(s.verifyJobs().map((j) => j.idempotencyKey)).toEqual([
      `outgoing.verify:${outgoingId}:1`,
    ]);
    s.sink.findResults = [false];
    await s.runVerify();
    expect(s.sink.finds[0]?.sinceTs).toBe((NOW_SECONDS - 5).toFixed(6));
    expect(s.sink.sends).toHaveLength(1);
    s.expectNoContent();
  });

  test("if recording the outcome fails after a send, the message stays sending until the sweep", async () => {
    const flag = { on: true };
    const t = setup({ failVerifyEnqueue: flag });
    const { outgoingId, approvalId } = t.request();
    const logs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void logs.push(a.join(" "));
    try {
      await t.approveAndRun(approvalId);
    } finally {
      console.error = orig;
    }
    expect(t.out(outgoingId)?.status).toBe("sending");
    expect(t.approval(approvalId)?.status).toBe("failed");
    expect(t.approval(approvalId)?.executionResult).toEqual({
      error: "slack send failed: outcome_unrecorded",
    });
    expect(logs.join("")).not.toContain("SECRET");
    flag.on = false;
    t.clock.advance(10 * 60_000 + 1);
    t.db.transaction((tx) => t.outgoing.recoverySweep(tx));
    expect(t.out(outgoingId)?.status).toBe("needs_attention");
    expect(t.verifyJobs()).toHaveLength(1);
    expect(t.sink.sends).toHaveLength(1);
  });
});

describe("approval decisions", () => {
  test("revoke before execution: nothing sent, outgoing failed revoked, followup draft", async () => {
    const { outgoingId, approvalId } = s.request();
    s.engine.approve(approvalId);
    s.dispatcher.dispatchOnce();
    s.engine.revoke(approvalId, "changed my mind");
    s.dispatcher.dispatchOnce();
    expect(await s.worker.runOnce()).toBe(true);
    expect(s.sink.sends).toHaveLength(0);
    expect(s.out(outgoingId)).toMatchObject({ status: "failed", failure: "revoked" });
    expect(s.fu()?.status).toBe("draft");
    s.expectNoContent();
  });

  test("reject: outgoing failed rejected, followup draft", () => {
    const { outgoingId, approvalId } = s.request();
    s.engine.reject(approvalId, "no");
    s.dispatcher.dispatchOnce();
    expect(s.out(outgoingId)).toMatchObject({ status: "failed", failure: "rejected" });
    expect(s.fu()?.status).toBe("draft");
  });

  test("expiry: nothing sent, outgoing failed expired, followup draft", async () => {
    const { outgoingId, approvalId } = s.request();
    s.engine.approve(approvalId);
    s.dispatcher.dispatchOnce();
    s.clock.advance(7 * 24 * 3_600_000);
    expect(s.engine.expireDue()).toBe(1);
    s.dispatcher.dispatchOnce();
    expect(await s.worker.runOnce()).toBe(true);
    expect(s.sink.sends).toHaveLength(0);
    expect(s.out(outgoingId)).toMatchObject({ status: "failed", failure: "expired" });
    expect(s.fu()?.status).toBe("draft");
  });

  test("a decision acts only on a still-pending outgoing message and only on slack approvals", () => {
    const { outgoingId, approvalId } = s.request();
    s.engine.approve(approvalId);
    s.db
      .update(schema.outgoingMessages)
      .set({ status: "needs_attention", failure: "uncertain_outcome" })
      .where(eq(schema.outgoingMessages.id, outgoingId))
      .run();
    s.engine.revoke(approvalId, "x");
    s.dispatcher.dispatchOnce();
    expect(s.out(outgoingId)?.status).toBe("needs_attention");

    const other = s.engine.request(s.db, {
      action: "records.update",
      targetIntegration: "people",
      targetRef: "p",
      payload: { outgoingId },
      riskLevel: "low",
      idempotencyKey: "people-x",
      requestedByModule: "test",
    });
    s.engine.reject(other.id, "no");
    expect(s.dispatcher.dispatchOnce().failed).toBe(0);
    expect(s.out(outgoingId)?.status).toBe("needs_attention");
  });
});

describe("resolveNeedsAttention", () => {
  const toNeedsAttention = async () => {
    s.sink.sendImpl = async () => ({ status: "uncertain", failure: "uncertain_outcome" });
    const r = s.request();
    await s.approveAndRun(r.approvalId);
    return r;
  };

  test("resend: a new outgoing message and approval with the same text; the old one superseded", async () => {
    const old = await toNeedsAttention();
    const res = s.outgoing.resolveNeedsAttention(old.outgoingId, "resend");
    expect(res.resend).toBeDefined();
    const next = res.resend as { outgoingId: string; approvalId: string };
    expect(next.outgoingId).not.toBe(old.outgoingId);
    expect(next.approvalId).not.toBe(old.approvalId);
    expect(s.out(old.outgoingId)).toMatchObject({ status: "failed", failure: "superseded" });
    expect(s.out(next.outgoingId)).toMatchObject({ status: "pending", text: SECRET });
    expect(s.approval(next.approvalId)?.status).toBe("pending");
    expect(s.fu()).toMatchObject({
      status: "awaiting_approval",
      outgoingId: next.outgoingId,
      approvalId: next.approvalId,
    });
    const rows = s.db
      .select()
      .from(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.action, "outgoing.resolved"),
          eq(schema.auditEvents.actor, "user"),
        ),
      )
      .all();
    expect(rows).toHaveLength(1);
    // A late verify of the superseded message changes nothing.
    s.sink.findResults = [true];
    await s.runVerify();
    expect(s.out(old.outgoingId)?.status).toBe("failed");
    expect(s.fu()?.status).toBe("awaiting_approval");
    expect(s.sink.sends).toHaveLength(1);
    s.expectNoContent();
  });

  test("mark_sent: sent, followup sent, followup.sent once", async () => {
    const r = await toNeedsAttention();
    s.outgoing.resolveNeedsAttention(r.outgoingId, "mark_sent");
    expect(s.out(r.outgoingId)?.status).toBe("sent");
    expect(s.fu()?.status).toBe("sent");
    expect(s.eventsOf("followup.sent")).toHaveLength(1);
    expect(() => s.outgoing.resolveNeedsAttention(r.outgoingId, "mark_sent")).toThrow(
      ResolveNotAllowed,
    );
  });

  test("discard: failed discarded, followup discarded", async () => {
    const r = await toNeedsAttention();
    s.outgoing.resolveNeedsAttention(r.outgoingId, "discard");
    expect(s.out(r.outgoingId)).toMatchObject({ status: "failed", failure: "discarded" });
    expect(s.fu()?.status).toBe("discarded");
  });

  test("allowed only from needs_attention or an exhausted sent_unverified", async () => {
    expect(() => s.outgoing.resolveNeedsAttention("missing", "discard")).toThrow(OutgoingNotFound);
    const { outgoingId, approvalId } = s.request();
    expect(() => s.outgoing.resolveNeedsAttention(outgoingId, "resend")).toThrow(ResolveNotAllowed);
    await s.approveAndRun(approvalId);
    expect(() => s.outgoing.resolveNeedsAttention(outgoingId, "resend")).toThrow(ResolveNotAllowed);
    s.settings.set("outgoing.verify.maxAttempts", 1);
    await s.runVerify();
    expect(s.out(outgoingId)?.failure).toBe("unverified");
    s.outgoing.resolveNeedsAttention(outgoingId, "mark_sent");
    expect(s.out(outgoingId)?.status).toBe("sent");
    expect(s.eventsOf("followup.sent")).toHaveLength(1);
  });
});

describe("container wiring", () => {
  test("Container.outgoing, the executor, the verify job and the sweep are registered", () => {
    const c = createContainer(loadConfig({ SYNAPSE_DB_PATH: ":memory:" }), {
      run: async () => "Linger=yes",
      provider: {
        execute: async () => {
          throw new Error("fake provider must not execute");
        },
        getHealth: async () => ({ status: "ok", version: "fake" }),
      },
    });
    try {
      expect(c.outgoing).toBeInstanceOf(OutgoingService);
      expect(c.approvals.hasExecutor("slack.send")).toBe(true);
      expect(c.handlers.has(OUTGOING_VERIFY_JOB)).toBe(true);
      expect(c.recoverySweeps.map((x) => x.name)).toContain("outgoing.sending");
    } finally {
      c.sqlite.close();
    }
  });
});
