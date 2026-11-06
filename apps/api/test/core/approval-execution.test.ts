import { expect, test } from "bun:test";
import type { Operation } from "@synapse/contracts";
import { openDatabase, runMigrations, schema } from "@synapse/database";
import { FakeClock } from "@synapse/shared";
import { eq } from "drizzle-orm";
import { ApprovalEngine } from "../../src/core/approvals/approvals";
import {
  registerApprovalExecution,
  registerIntegrationExecutor,
} from "../../src/core/approvals/execution";
import { AuditLogger } from "../../src/core/audit/audit";
import { OutboxDispatcher } from "../../src/core/events/dispatcher";
import { LiveBus } from "../../src/core/events/live-bus";
import { EventPublisher } from "../../src/core/events/publisher";
import { JobQueue } from "../../src/core/jobs/queue";
import { type HandlerRegistration, JobWorker } from "../../src/core/jobs/worker";
import { PermissionManager } from "../../src/core/permissions/permissions";

let keyCounter = 0;

function setup() {
  const { db } = openDatabase(":memory:");
  runMigrations(db);
  const clock = new FakeClock("2026-01-01T00:00:00.000Z");
  const audit = new AuditLogger(clock);
  const engine = new ApprovalEngine(
    db,
    clock,
    new EventPublisher(clock),
    audit,
    new PermissionManager(db, audit),
  );
  const dispatcher = new OutboxDispatcher(db, clock, new LiveBus());
  const queue = new JobQueue(db, clock, { random: () => 0.5 });
  const handlers = new Map<string, HandlerRegistration>();
  registerApprovalExecution({ dispatcher, queue, engine, handlers });
  const worker = new JobWorker(queue, handlers, { workerId: "w1" });
  const skipReasons = () =>
    db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, "approval.execution_skipped"))
      .all()
      .map((r) => (r.details as { reason: string }).reason);
  const jobs = () => db.select().from(schema.jobs).all();
  const request = (integration = "slack", action: Operation = "slack.send") =>
    engine.request(db, {
      action,
      targetIntegration: integration,
      targetRef: "ref",
      payload: { text: "SECRET-PAYLOAD" },
      riskLevel: "medium",
      idempotencyKey: `k-${++keyCounter}`,
      requestedByModule: "test",
    });
  return { db, clock, engine, dispatcher, worker, jobs, request, skipReasons, queue, handlers };
}

test("approve -> exactly one job (replay adds none) -> executor runs once -> executed", async () => {
  const { db, engine, dispatcher, worker, jobs, request } = setup();
  let ran = 0;
  registerIntegrationExecutor(engine, "slack.send", "slack", {
    execute: async () => {
      ran++;
      return { ok: true };
    },
  });
  const a = request();
  engine.approve(a.id);
  dispatcher.dispatchOnce();
  expect(jobs()).toHaveLength(1);
  expect(jobs()[0]?.priority).toBe(180);
  expect(jobs()[0]?.idempotencyKey).toBe(`approval.execute:${a.id}`);

  // re-deliver the same event
  db.update(schema.domainEvents).set({ dispatchedAt: null }).run();
  db.delete(schema.eventConsumptions).run();
  dispatcher.dispatchOnce();
  expect(jobs()).toHaveLength(1);

  expect(await worker.runOnce()).toBe(true);
  expect(ran).toBe(1);
  expect(
    db.select().from(schema.approvals).where(eq(schema.approvals.id, a.id)).get()?.status,
  ).toBe("executed");
  expect(jobs()[0]?.status).toBe("COMPLETED");

  // an already-executed approval is never executed again, even by a second job run
  expect((await engine.execute(a.id)).status).toBe("executed");
  expect(ran).toBe(1);
});

test("executor throws: approval failed once, never re-executed, no content in job or lastError", async () => {
  const { db, engine, dispatcher, worker, jobs, request } = setup();
  let ran = 0;
  registerIntegrationExecutor(engine, "slack.send", "slack", {
    execute: async () => {
      ran++;
      throw new Error("boom");
    },
  });
  const a = request();
  engine.approve(a.id);
  dispatcher.dispatchOnce();
  await worker.runOnce();
  const row = db.select().from(schema.approvals).where(eq(schema.approvals.id, a.id)).get();
  expect(row?.status).toBe("failed");
  expect(jobs()[0]?.status).toBe("COMPLETED");
  expect(jobs()[0]?.lastError ?? null).toBeNull();
  expect(JSON.stringify(jobs())).not.toContain("SECRET-PAYLOAD");
  // forced re-run does not execute again
  expect((await engine.execute(a.id)).status).toBe("skipped");
  expect(ran).toBe(1);
});

test("unknown integration: approval failed with 'no executor', job content-free", async () => {
  const { db, engine, dispatcher, worker, jobs, request } = setup();
  registerIntegrationExecutor(engine, "slack.send", "slack", { execute: async () => 1 });
  const a = request("jira");
  engine.approve(a.id);
  dispatcher.dispatchOnce();
  await worker.runOnce();
  const row = db.select().from(schema.approvals).where(eq(schema.approvals.id, a.id)).get();
  expect(row?.status).toBe("failed");
  expect(row?.executionResult).toEqual({ error: "no executor" });
  expect(JSON.stringify(jobs())).not.toContain("SECRET-PAYLOAD");
});

test("routes by integration for the same action", async () => {
  const { db, engine, dispatcher, worker, request } = setup();
  const seen: string[] = [];
  registerIntegrationExecutor(engine, "slack.send", "slack", {
    execute: async () => void seen.push("slack"),
  });
  registerIntegrationExecutor(engine, "slack.send", "people", {
    execute: async () => void seen.push("people"),
  });
  const a = request("people");
  engine.approve(a.id);
  dispatcher.dispatchOnce();
  await worker.runOnce();
  expect(seen).toEqual(["people"]);
  expect(
    db.select().from(schema.approvals).where(eq(schema.approvals.id, a.id)).get()?.status,
  ).toBe("executed");
});

test("a revoked approval is never executed", async () => {
  const { db, engine, dispatcher, worker, request, jobs, skipReasons } = setup();
  let ran = 0;
  registerIntegrationExecutor(engine, "slack.send", "slack", {
    execute: async () => void ran++,
  });
  const a = request();
  engine.approve(a.id);
  dispatcher.dispatchOnce();
  engine.revoke(a.id, "no");
  expect(await worker.runOnce()).toBe(true);
  expect(ran).toBe(0);
  expect(jobs()).toHaveLength(1);
  expect(jobs()[0]?.status).toBe("COMPLETED");
  expect(skipReasons()).toEqual(["status_revoked"]);
  expect(
    db.select().from(schema.approvals).where(eq(schema.approvals.id, a.id)).get()?.status,
  ).toBe("revoked");
});

test("an expired approval is never executed", async () => {
  const { engine, db, clock, dispatcher, worker, jobs, skipReasons } = setup();
  let ran = 0;
  registerIntegrationExecutor(engine, "slack.send", "slack", { execute: async () => void ran++ });
  const a = engine.request(db, {
    action: "slack.send",
    targetIntegration: "slack",
    targetRef: "ref",
    payload: {},
    riskLevel: "medium",
    idempotencyKey: `k-${++keyCounter}`,
    requestedByModule: "test",
    expiresAt: "2026-01-01T01:00:00.000Z",
  });
  engine.approve(a.id);
  dispatcher.dispatchOnce();
  clock.set("2026-01-01T02:00:00.000Z");
  expect(await worker.runOnce()).toBe(true);
  expect(ran).toBe(0);
  expect(jobs()).toHaveLength(1);
  expect(jobs()[0]?.status).toBe("COMPLETED");
  expect(skipReasons()).toEqual(["expired"]);
});

test("an approval already claimed (in progress) is skipped, executor runs 0 times", async () => {
  const { engine, db, dispatcher, worker, request, skipReasons } = setup();
  let ran = 0;
  registerIntegrationExecutor(engine, "slack.send", "slack", { execute: async () => void ran++ });
  const a = request();
  engine.approve(a.id);
  dispatcher.dispatchOnce();
  db.update(schema.approvals)
    .set({ executionStartedAt: "2026-01-01T00:00:00.000Z" })
    .where(eq(schema.approvals.id, a.id))
    .run();
  expect(await worker.runOnce()).toBe(true);
  expect(ran).toBe(0);
  expect(skipReasons()).toEqual(["already_in_progress"]);
});

test("bookkeeping failure parks the job in NEEDS_ATTENTION, content-free, one log line", async () => {
  const { db, queue } = setup();
  const handlers = new Map<string, HandlerRegistration>();
  const dispatcher = new OutboxDispatcher(
    db,
    new FakeClock("2026-01-01T00:00:00.000Z"),
    new LiveBus(),
  );
  registerApprovalExecution({
    dispatcher,
    queue,
    engine: {
      execute: async () => {
        throw new Error("db exploded SECRET-PAYLOAD");
      },
    },
    handlers,
  });
  queue.enqueue(db, { type: "approval.execute", idempotencyKey: "x", input: { approvalId: "A1" } });
  const logs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void logs.push(a.join(" "));
  try {
    await new JobWorker(queue, handlers, { workerId: "w" }).runOnce();
  } finally {
    console.error = orig;
  }
  const job = db.select().from(schema.jobs).get();
  expect(job?.status).toBe("NEEDS_ATTENTION");
  expect((job?.lastError as { kind?: string } | null)?.kind).toBe("needs_attention");
  expect(JSON.stringify(job?.lastError)).not.toContain("SECRET");
  expect(logs.filter((l) => l.includes("approval=A1"))).toHaveLength(1);
  expect(logs.join("")).not.toContain("SECRET");
});

test("invalid job input fails with invalid_input", async () => {
  const { db, queue, handlers } = setup();
  queue.enqueue(db, { type: "approval.execute", idempotencyKey: "bad", input: { approvalId: "" } });
  await new JobWorker(queue, handlers, { workerId: "w" }).runOnce();
  expect(db.select().from(schema.jobs).get()?.status).toBe("FAILED");
});

test("duplicate (action, integration) registration throws", () => {
  const { engine } = setup();
  registerIntegrationExecutor(engine, "slack.send", "slack", { execute: async () => 1 });
  expect(() =>
    registerIntegrationExecutor(engine, "slack.send", "slack", { execute: async () => 2 }),
  ).toThrow();
});

test("registering over a non-router executor throws", () => {
  const { engine } = setup();
  engine.registerExecutor("slack.send", { execute: async () => 1 });
  expect(() =>
    registerIntegrationExecutor(engine, "slack.send", "slack", { execute: async () => 2 }),
  ).toThrow();
});
