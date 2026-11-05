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
import { ApprovalEngine, type Executor } from "../../src/core/approvals/approvals";
import {
  approvalExecuteTimeoutMs,
  registerApprovalExecution,
} from "../../src/core/approvals/execution";
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
import { SlackSender } from "../../src/integrations/slack/sender";
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
  signals: AbortSignal[] = [];
  finds: { cmd: SendMessageCommand; sinceTs: string }[] = [];
  sendImpl: (cmd: SendMessageCommand, signal: AbortSignal) => Promise<SendResult> = async () => ({
    status: "sent_unverified",
  });
  /** An Error entry is thrown by findSent (R18). */
  findResults: (boolean | null | Error)[] = [];

  async send(cmd: SendMessageCommand, signal: AbortSignal): Promise<SendResult> {
    this.sends.push(cmd);
    this.signals.push(signal);
    return this.sendImpl(cmd, signal);
  }

  async findSent(cmd: SendMessageCommand, sinceTs: string): Promise<boolean | null> {
    this.finds.push({ cmd, sinceTs });
    const next = this.findResults.length > 0 ? (this.findResults.shift() ?? null) : false;
    if (next instanceof Error) throw next;
    return next;
  }
}

type Setup = ReturnType<typeof setup>;

function setup(opts: { failVerifyEnqueue?: { on: boolean }; sink?: MessageSink } = {}) {
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
  const serviceDeps = {
    db,
    clock,
    events,
    audit,
    queue,
    settings,
    notifications,
    approvals: engine,
    securityFlags,
    sink: opts.sink ?? sink,
  };
  const outgoing = new OutgoingService(serviceDeps);
  /** The same service in a restarted process: nothing is in flight there. */
  const restarted = () => new OutgoingService(serviceDeps);
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
    handlers,
    restarted,
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
const ticks = async (n = 5) => {
  for (let i = 0; i < n; i++) await tick();
};

/** The registered slack.send executor, called directly (it is not reachable from the service). */
const runExecutor = (t: Setup, a: Approval, signal?: AbortSignal) =>
  (t.engine as unknown as { executors: Map<string, Executor> }).executors
    .get("slack.send")
    ?.execute(a, signal);

const claimApproval = (t: Setup, approvalId: string) =>
  t.db
    .update(schema.approvals)
    .set({ executionStartedAt: NOW })
    .where(eq(schema.approvals.id, approvalId))
    .run();

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
    claimApproval(s, approvalId);
    for (const status of ["sending", "sent_unverified", "sent", "needs_attention", "failed"]) {
      s.db
        .update(schema.outgoingMessages)
        .set({ status: status as "sending" })
        .where(eq(schema.outgoingMessages.id, outgoingId))
        .run();
      const r = await runExecutor(s, toApproval(s, approvalId));
      expect(r).toMatchObject({ status: "skipped" });
    }
    s.db
      .update(schema.outgoingMessages)
      .set({ status: "pending" })
      .where(eq(schema.outgoingMessages.id, outgoingId))
      .run();
    const other = { ...toApproval(s, approvalId), id: "another-approval" };
    expect(await runExecutor(s, other)).toMatchObject({
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
    expect(await runExecutor(s, toApproval(s, approvalId))).toMatchObject({
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

  for (const kind of ["auth_paused", "quota_exhausted"] as const) {
    test(`R18: ${kind} during verify defers the job without spending a verify attempt`, async () => {
      const { outgoingId, approvalId } = s.request();
      await s.approveAndRun(approvalId);
      const runAfter = new Date(Date.parse(NOW) + 3_600_000).toISOString();
      s.sink.findResults = [
        new JobError({ kind, message: "paused", retryAfter: runAfter }),
        new JobError({ kind, message: "paused", retryAfter: runAfter }),
        true,
      ];
      expect(await s.runVerify()).toBe(true);
      const [job] = s.verifyJobs();
      expect(job).toMatchObject({ status: "PENDING", attempts: 0, runAfter });
      expect(s.out(outgoingId)?.verifyAttempts).toBe(0);
      expect(s.verifyJobs()).toHaveLength(1);
      // Deferred again: still no verify attempt, no notification, no new verify job.
      s.clock.set(new Date(runAfter));
      expect(await s.worker.runOnce()).toBe(true);
      expect(s.out(outgoingId)?.verifyAttempts).toBe(0);
      expect(s.notes()).toHaveLength(0);
      s.clock.set(new Date(runAfter));
      expect(await s.worker.runOnce()).toBe(true);
      expect(s.out(outgoingId)).toMatchObject({ status: "sent", verifyAttempts: 0 });
      expect(s.sink.sends).toHaveLength(1);
      s.expectNoContent();
    });
  }

  test("R18: through the real SlackSender, an auth pause during the search spends no verify attempt", async () => {
    let paused = true;
    const sender = new SlackSender({
      orchestrator: {
        run: async () => {
          throw new Error("no send run in this test");
        },
      },
      searchSource: {
        collect: async () => {
          if (paused) throw new JobError({ kind: "auth_paused", message: "auth paused" });
          return { pages: [{ messages: [], rejected: 0 }], searches: 1, complete: true };
        },
      },
      selfUserId: () => "U0SYNTHSELF",
    });
    const t = setup({
      sink: {
        send: async () => ({ status: "sent_unverified" }),
        findSent: (cmd, since) => sender.findSent(cmd, since),
      },
    });
    const { outgoingId, approvalId } = t.request();
    await t.approveAndRun(approvalId);
    expect(await t.runVerify()).toBe(true);
    expect(t.out(outgoingId)?.verifyAttempts).toBe(0);
    expect(t.verifyJobs()[0]).toMatchObject({ status: "PENDING", attempts: 0 });
    paused = false;
    t.clock.advance(15 * 60_000);
    expect(await t.worker.runOnce()).toBe(true);
    expect(t.out(outgoingId)?.verifyAttempts).toBe(1);
  });

  test("R18: rate_limited during verify retries at Slack's time without a verify attempt; the last job attempt counts one", async () => {
    const { outgoingId, approvalId } = s.request();
    await s.approveAndRun(approvalId);
    const rl = () =>
      new JobError({
        kind: "rate_limited",
        message: "slack rate limited",
        retryAfter: new Date(s.clock.now().getTime() + 60_000).toISOString(),
      });
    s.sink.findResults = [rl(), rl(), rl()];
    expect(await s.runVerify()).toBe(true);
    expect(s.verifyJobs()[0]).toMatchObject({ status: "RETRY", attempts: 1 });
    expect(s.out(outgoingId)?.verifyAttempts).toBe(0);
    s.clock.advance(60_000);
    s.sink.findResults = [rl()];
    expect(await s.worker.runOnce()).toBe(true);
    expect(s.out(outgoingId)?.verifyAttempts).toBe(0);
    // The job's last attempt never strands the row: it counts as an unknown verify attempt.
    s.clock.advance(60_000);
    s.sink.findResults = [rl()];
    expect(await s.worker.runOnce()).toBe(true);
    expect(s.verifyJobs()[0]?.status).toBe("COMPLETED");
    expect(s.out(outgoingId)?.verifyAttempts).toBe(1);
    expect(s.verifyJobs()).toHaveLength(2);
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
    // R7 (g): exhausted is marked the same way for both statuses and is never verified again.
    expect(o?.failure).toBe("unverified");
    expect(o?.verifyAttempts).toBe(2);
    expect(s.notes()).toHaveLength(1);
    expect(s.fu()?.status).toBe("needs_attention");
    expect(await s.outgoing.verify(outgoingId)).toMatchObject({ status: "skipped" });
    expect(s.sink.finds).toHaveLength(2);
    expect(s.sink.sends).toHaveLength(1);
    // the user may still resend an uncertain message
    expect(s.outgoing.resolveNeedsAttention(outgoingId, "resend").resend).toBeDefined();
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

    // The executor's process died: recovery runs in a new process, where nothing is in flight.
    const fresh = s.restarted();
    const sweeps = [{ name: "outgoing.sending", run: (tx: Tx) => fresh.recoverySweep(tx) }];
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
    expect(await runExecutor(s, toApproval(s, approvalId))).toMatchObject({
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

describe("R7: no duplicate send when a send outlives its job", () => {
  const hanging = (t: Setup) => {
    let release: (r: SendResult) => void = () => {};
    t.sink.sendImpl = () =>
      new Promise<SendResult>((r) => {
        release = r;
      });
    return (r: SendResult) => release(r);
  };
  const shortExecuteTimeout = (t: Setup) => {
    const reg = t.handlers.get("approval.execute");
    if (!reg) throw new Error("approval.execute not registered");
    reg.timeoutMs = 20;
  };

  test("PROBE A: a timed-out execute stays in flight, is never swept, and cannot be resent", async () => {
    const release = hanging(s);
    const { outgoingId, approvalId } = s.request();
    s.engine.approve(approvalId);
    s.dispatcher.dispatchOnce();
    shortExecuteTimeout(s);
    await s.worker.runOnce();
    const job = s.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.type, "approval.execute"))
      .get();
    expect(job?.status).toBe("NEEDS_ATTENTION");
    // (b) the job's signal reached the sink and was aborted by the timeout
    expect(s.sink.signals[0]?.aborted).toBe(true);
    expect(s.out(outgoingId)?.status).toBe("sending");

    s.clock.advance(10 * 60_000 + 1);
    const sweeps = [{ name: "outgoing.sending", run: (tx: Tx) => s.outgoing.recoverySweep(tx) }];
    reapExpiredJobs({ db: s.db, clock: s.clock, audit: s.audit, sweeps });
    expect(s.out(outgoingId)?.status).toBe("sending");
    expect(() => s.outgoing.resolveNeedsAttention(outgoingId, "resend")).toThrow(ResolveNotAllowed);
    expect(() => s.request()).toThrow(SendAlreadyPending);

    release({ status: "sent_unverified" });
    await ticks();
    expect(s.out(outgoingId)?.status).toBe("sent_unverified");
    expect(s.verifyJobs()).toHaveLength(1);
    s.db.transaction((tx) => s.outgoing.recoverySweep(tx));
    expect(s.out(outgoingId)?.status).toBe("sent_unverified");
    expect(s.sink.sends).toHaveLength(1);
    s.expectNoContent();
  });

  test("R7 (b): a job timeout while the send waits for a Claude slot fails before spawn -> not_started", async () => {
    // The real SlackSender over an orchestrator that is waiting for a slot: an abort throws the
    // orchestrator's pre-spawn "cancelled while waiting" error, which the sender rethrows.
    const runs: AbortSignal[] = [];
    const sender = new SlackSender({
      orchestrator: {
        run: (_req, signal) =>
          new Promise((_, reject) => {
            runs.push(signal);
            signal.addEventListener("abort", () =>
              reject(
                new JobError({
                  kind: "timeout",
                  message: "cancelled while waiting for a Claude slot",
                }),
              ),
            );
          }),
      },
      searchSource: {
        collect: async () => {
          throw new Error("no search in this test");
        },
      },
      selfUserId: () => null,
    });
    const t = setup({ sink: sender });
    const { outgoingId, approvalId } = t.request();
    t.engine.approve(approvalId);
    t.dispatcher.dispatchOnce();
    shortExecuteTimeout(t);
    const logs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void logs.push(a.join(" "));
    try {
      await t.worker.runOnce();
      await ticks();
    } finally {
      console.error = orig;
    }
    expect(runs).toHaveLength(1);
    expect(runs[0]?.aborted).toBe(true);
    expect(t.out(outgoingId)).toMatchObject({ status: "failed", failure: "not_started" });
    expect(t.approval(approvalId)?.status).toBe("failed");
    expect(t.fu()?.status).toBe("draft");
    expect(logs).toEqual([`outgoing send not started outgoing=${outgoingId} error=JobError`]);
    expect(t.request().outgoingId).not.toBe(outgoingId);
    t.expectNoContent();
  });

  test("PROBE B: a late argument_mismatch is flagged (in flight: the sweep leaves the row alone)", async () => {
    const release = hanging(s);
    const { outgoingId, approvalId } = s.request();
    s.engine.approve(approvalId);
    const p = s.engine.execute(approvalId);
    await ticks(3);
    s.clock.advance(10 * 60_000 + 1);
    s.db.transaction((tx) => s.outgoing.recoverySweep(tx));
    expect(s.out(outgoingId)?.status).toBe("sending");
    release({ status: "failed", failure: "argument_mismatch", mismatch: true });
    await p;
    expect(s.out(outgoingId)).toMatchObject({
      status: "needs_attention",
      failure: "argument_mismatch",
    });
    expect(s.db.select().from(schema.securityFlags).all()).toHaveLength(1);
    // one blocked-send notification (the security flag adds its own)
    expect(
      s.notes().filter((n) => n.title === "Send blocked: arguments changed — check Slack"),
    ).toHaveLength(1);
  });

  test("R7 (d): an outcome after another process swept the row is still recorded", async () => {
    s.db
      .insert(schema.claudeRuns)
      .values({ id: "run-late", workerProfile: "collector", status: "completed", startedAt: NOW })
      .run();
    const swept = (id: string) =>
      s.db
        .update(schema.outgoingMessages)
        .set({ status: "needs_attention", failure: "uncertain_outcome" })
        .where(eq(schema.outgoingMessages.id, id))
        .run();

    // late mismatch: flagged, run id kept, argument_mismatch
    let release = hanging(s);
    const a = s.request();
    s.engine.approve(a.approvalId);
    let p = s.engine.execute(a.approvalId);
    await ticks(3);
    swept(a.outgoingId);
    release({
      status: "failed",
      failure: "argument_mismatch",
      mismatch: true,
      runId: "run-late",
    });
    await p;
    expect(s.out(a.outgoingId)).toMatchObject({
      status: "needs_attention",
      failure: "argument_mismatch",
      claudeRunId: "run-late",
    });
    expect(s.db.select().from(schema.securityFlags).all()).toHaveLength(1);
    expect(
      s.notes().filter((n) => n.title === "Send blocked: arguments changed — check Slack"),
    ).toHaveLength(1);

    // late sent_unverified: recorded, verify queued, followup sent
    const t = setup();
    t.db
      .insert(schema.claudeRuns)
      .values({ id: "run-late", workerProfile: "collector", status: "completed", startedAt: NOW })
      .run();
    release = hanging(t);
    const b = t.request();
    t.engine.approve(b.approvalId);
    p = t.engine.execute(b.approvalId);
    await ticks(3);
    t.db
      .update(schema.outgoingMessages)
      .set({ status: "needs_attention", failure: "uncertain_outcome" })
      .where(eq(schema.outgoingMessages.id, b.outgoingId))
      .run();
    release({ status: "sent_unverified", runId: "run-late" });
    await p;
    expect(t.out(b.outgoingId)).toMatchObject({
      status: "sent_unverified",
      claudeRunId: "run-late",
    });
    expect(t.verifyJobs().map((j) => j.idempotencyKey)).toEqual([
      `outgoing.verify:${b.outgoingId}:1`,
    ]);
    expect(t.fu()?.status).toBe("sent");
    expect(t.eventsOf("followup.sent")).toHaveLength(1);
  });

  test("PROBE C (R7 e): a stranded pending row is returned to draft by the sweep", async () => {
    const { outgoingId, approvalId } = s.request();
    s.engine.approve(approvalId);
    // the engine claimed it, then the process died before the outgoing claim
    claimApproval(s, approvalId);
    s.clock.advance(8 * 24 * 3_600_000);
    s.engine.expireDue(); // a claimed approval is never expired
    s.dispatcher.dispatchOnce();
    expect(s.out(outgoingId)?.status).toBe("pending");
    s.db.transaction((tx) => s.outgoing.recoverySweep(tx));
    expect(s.out(outgoingId)).toMatchObject({ status: "failed", failure: "not_started" });
    expect(s.fu()?.status).toBe("draft");
    expect(s.request().outgoingId).not.toBe(outgoingId);
    expect(s.sink.sends).toHaveLength(0);
    s.expectNoContent();
  });

  test("R7 (e): stranded only when the approval is terminal or claimed, the row is old, and not in flight", () => {
    const rows = ["f2", "f3", "f4", "f5", "f6"].map((id) => {
      s.followup(id);
      return s.request({ followupId: id });
    });
    const [failedA, revokedA, approvedA, pendingA, young] = rows as [
      { outgoingId: string; approvalId: string },
      { outgoingId: string; approvalId: string },
      { outgoingId: string; approvalId: string },
      { outgoingId: string; approvalId: string },
      { outgoingId: string; approvalId: string },
    ];
    const setApproval = (id: string, status: "failed" | "revoked" | "approved") =>
      s.db.update(schema.approvals).set({ status }).where(eq(schema.approvals.id, id)).run();
    setApproval(failedA.approvalId, "failed");
    setApproval(revokedA.approvalId, "revoked"); // its decision consumer never ran
    setApproval(approvedA.approvalId, "approved"); // approved, not claimed: its job will run it
    s.clock.advance(10 * 60_000 + 1);
    const youngNow = s.request({ followupId: "f1" });
    setApproval(youngNow.approvalId, "failed");
    s.db.transaction((tx) => s.outgoing.recoverySweep(tx));
    expect(s.out(failedA.outgoingId)).toMatchObject({ status: "failed", failure: "not_started" });
    expect(s.out(revokedA.outgoingId)).toMatchObject({ status: "failed", failure: "revoked" });
    expect(s.out(approvedA.outgoingId)?.status).toBe("pending");
    expect(s.out(pendingA.outgoingId)?.status).toBe("pending");
    expect(s.out(young.outgoingId)?.status).toBe("pending");
    expect(s.out(youngNow.outgoingId)?.status).toBe("pending");
    expect(s.fu("f2")?.status).toBe("draft");
    expect(s.fu("f3")?.status).toBe("draft");
  });

  test("PROBE D (R7 f): the executor never sends for an unapproved or unclaimed approval", async () => {
    expect((s.outgoing as unknown as { execute?: unknown }).execute).toBeUndefined();
    const { outgoingId, approvalId } = s.request();
    expect(await runExecutor(s, toApproval(s, approvalId))).toMatchObject({
      status: "skipped",
      reason: "approval_not_claimed",
    });
    s.engine.approve(approvalId);
    expect(await runExecutor(s, toApproval(s, approvalId))).toMatchObject({
      status: "skipped",
      reason: "approval_not_claimed",
    });
    expect(s.sink.sends).toHaveLength(0);
    expect(s.out(outgoingId)?.status).toBe("pending");
  });

  test("R7 (g): a failure other than tool_error/no_send is uncertain, never back to draft", async () => {
    for (const failure of [undefined, "something_else", "uncertain_outcome"]) {
      const t = setup();
      t.sink.sendImpl = async () => ({ status: "failed", ...(failure ? { failure } : {}) });
      const { outgoingId, approvalId } = t.request();
      await t.approveAndRun(approvalId);
      expect(t.out(outgoingId)).toMatchObject({
        status: "needs_attention",
        failure: "uncertain_outcome",
      });
      expect(t.approval(approvalId)?.status).toBe("executed");
      expect(t.fu()?.status).toBe("needs_attention");
      expect(t.verifyJobs()).toHaveLength(1);
    }
  });

  test("R7 (g): an exhausted sent_unverified offers mark_sent and discard, not resend", async () => {
    s.settings.set("outgoing.verify.maxAttempts", 1);
    const { outgoingId, approvalId } = s.request();
    await s.approveAndRun(approvalId);
    await s.runVerify();
    expect(s.out(outgoingId)?.failure).toBe("unverified");
    expect(() => s.outgoing.resolveNeedsAttention(outgoingId, "resend")).toThrow(ResolveNotAllowed);
    s.outgoing.resolveNeedsAttention(outgoingId, "discard");
    expect(s.out(outgoingId)).toMatchObject({ status: "failed", failure: "discarded" });
    expect(s.sink.sends).toHaveLength(1);
  });

  test("R7 (g): the database allows one live outgoing message per followup", () => {
    s.request(); // f1 now has a live (pending) outgoing message
    // approval_id is unique too, so give each row its own approval
    const approvalFor = (key: string) =>
      s.engine.request(s.db, {
        action: "slack.send",
        targetIntegration: "slack",
        targetRef: CHANNEL,
        payload: {},
        riskLevel: "medium",
        idempotencyKey: key,
        requestedByModule: "test",
      }).id;
    const live = approvalFor("k-live");
    const dead = approvalFor("k-dead");
    expect(() =>
      s.db
        .insert(schema.outgoingMessages)
        .values({
          id: "o-live",
          approvalId: live,
          followupId: "f1",
          conversationExternalId: CHANNEL,
          text: "x",
          status: "pending",
          createdAt: NOW,
          updatedAt: NOW,
        })
        .run(),
    ).toThrow();
    s.db
      .insert(schema.outgoingMessages)
      .values({
        id: "o-dead",
        approvalId: dead,
        followupId: "f1",
        conversationExternalId: CHANNEL,
        text: "x",
        status: "failed",
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
    expect(s.out("o-dead")?.status).toBe("failed");
  });
});

describe("container wiring", () => {
  test("Container.outgoing, the executor, the verify job and the sweep are registered", () => {
    const sink = new FakeSink();
    const c = createContainer(loadConfig({ SYNAPSE_DB_PATH: ":memory:" }), {
      run: async () => "Linger=yes",
      provider: {
        execute: async () => {
          throw new Error("fake provider must not execute");
        },
        getHealth: async () => ({ status: "ok", version: "fake" }),
      },
      sink,
    });
    try {
      expect(c.outgoing).toBeInstanceOf(OutgoingService);
      expect((c.outgoing as unknown as { deps: { sink: unknown } }).deps.sink).toBe(sink);
      expect("messageSink" in c).toBe(false);
      expect(c.approvals.hasExecutor("slack.send")).toBe(true);
      expect(c.handlers.has(OUTGOING_VERIFY_JOB)).toBe(true);
      expect(c.recoverySweeps.map((x) => x.name)).toContain("outgoing.sending");
      // R7 (c): max(120 s, collector 180 s + 90 s)
      expect(c.handlers.get("approval.execute")?.timeoutMs).toBe(270_000);
    } finally {
      c.sqlite.close();
    }
  });

  test("R7 (c): the approval.execute timeout never drops below 120 s", () => {
    expect(approvalExecuteTimeoutMs()).toBe(120_000);
    expect(approvalExecuteTimeoutMs({ get: (() => 10) as never })).toBe(120_000);
    expect(approvalExecuteTimeoutMs({ get: (() => 600) as never })).toBe(690_000);
  });
});
