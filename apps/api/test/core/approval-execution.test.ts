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
  const jobs = () => db.select().from(schema.jobs).all();
  const request = (integration = "slack", action: Operation = "slack.send") =>
    engine.request(db, {
      action,
      targetIntegration: integration,
      targetRef: "ref",
      payload: { text: "SECRET-PAYLOAD" },
      riskLevel: "medium",
      idempotencyKey: `k-${Math.random()}`,
      requestedByModule: "test",
    });
  return { db, engine, dispatcher, worker, jobs, request };
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
  const { db, engine, dispatcher, worker, request } = setup();
  let ran = 0;
  registerIntegrationExecutor(engine, "slack.send", "slack", {
    execute: async () => void ran++,
  });
  const a = request();
  engine.approve(a.id);
  dispatcher.dispatchOnce();
  engine.revoke(a.id, "no");
  await worker.runOnce();
  expect(ran).toBe(0);
  expect(
    db.select().from(schema.approvals).where(eq(schema.approvals.id, a.id)).get()?.status,
  ).toBe("revoked");
});
