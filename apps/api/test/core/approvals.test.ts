import { expect, test } from "bun:test";
import { ExecutorError, JobError, type Operation } from "@synapse/contracts";
import { openDatabase, runMigrations, schema } from "@synapse/database";
import { FakeClock } from "@synapse/shared";
import { eq } from "drizzle-orm";
import { ApprovalEngine, InvalidApprovalTransition } from "../../src/core/approvals/approvals";
import { AuditLogger } from "../../src/core/audit/audit";
import { LiveBus } from "../../src/core/events/live-bus";
import { EventPublisher } from "../../src/core/events/publisher";
import { NotificationService } from "../../src/core/notifications/notifications";
import { PermissionManager } from "../../src/core/permissions/permissions";

function setup() {
  const { db } = openDatabase(":memory:");
  runMigrations(db);
  const clock = new FakeClock("2026-01-01T00:00:00.000Z");
  const audit = new AuditLogger(clock);
  const perms = new PermissionManager(db, audit);
  const engine = new ApprovalEngine(db, clock, new EventPublisher(clock), audit, perms);
  return { db, clock, perms, engine };
}

let n = 0;
function req(action: Operation, extra: { expiresAt?: string } = {}) {
  n++;
  return {
    action,
    targetIntegration: "slack",
    targetRef: "C1/123",
    payload: { text: "hi" },
    riskLevel: "medium" as const,
    idempotencyKey: `k${n}`,
    requestedByModule: "inbox",
    ...extra,
  };
}

test("approval revoked before execution never executes", async () => {
  const { db, engine } = setup();
  let ran = 0;
  engine.registerExecutor("slack.send", {
    execute: async () => {
      ran++;
    },
  });
  const a = engine.request(db, req("slack.send"));
  engine.approve(a.id);
  engine.revoke(a.id, "changed my mind");
  expect((await engine.execute(a.id)).status).toBe("skipped");
  expect(ran).toBe(0);
});

test("expired approval is skipped", async () => {
  const { db, clock, engine } = setup();
  let ran = 0;
  engine.registerExecutor("slack.send", {
    execute: async () => {
      ran++;
    },
  });
  const a = engine.request(db, req("slack.send", { expiresAt: "2026-01-01T00:01:00.000Z" }));
  engine.approve(a.id);
  clock.advance(2 * 60_000);
  expect(engine.expireDue()).toBe(1);
  expect((await engine.execute(a.id)).status).toBe("skipped");
  expect(ran).toBe(0);
  expect(db.select().from(schema.approvals).get()?.status).toBe("expired");
});

test("past expiry is skipped even before expireDue runs", async () => {
  const { db, clock, engine } = setup();
  engine.registerExecutor("slack.send", { execute: async () => "x" });
  const a = engine.request(db, req("slack.send", { expiresAt: "2026-01-01T00:01:00.000Z" }));
  engine.approve(a.id);
  clock.advance(2 * 60_000);
  expect((await engine.execute(a.id)).status).toBe("skipped");
});

test("execute is idempotent", async () => {
  const { db, engine } = setup();
  let ran = 0;
  engine.registerExecutor("slack.send", { execute: async () => ({ n: ++ran }) });
  const a = engine.request(db, req("slack.send"));
  engine.approve(a.id);
  const r1 = await engine.execute(a.id);
  const r2 = await engine.execute(a.id);
  expect(ran).toBe(1);
  expect(r1).toEqual({ status: "executed", result: { n: 1 } });
  expect(r2).toEqual(r1);
});

test("concurrent execute runs the executor once", async () => {
  const { db, engine } = setup();
  let ran = 0;
  engine.registerExecutor("slack.send", {
    execute: async () => {
      ran++;
      await new Promise((r) => setTimeout(r, 10));
      return "done";
    },
  });
  const a = engine.request(db, req("slack.send"));
  engine.approve(a.id);
  const [x, y] = await Promise.all([engine.execute(a.id), engine.execute(a.id)]);
  expect(ran).toBe(1);
  expect([x.status, y.status].sort()).toEqual(["executed", "skipped"]);
});

test("revalidate false skips", async () => {
  const { db, engine } = setup();
  let ran = 0;
  engine.registerExecutor("slack.send", {
    execute: async () => {
      ran++;
    },
    revalidate: async () => false,
  });
  const a = engine.request(db, req("slack.send"));
  engine.approve(a.id);
  expect((await engine.execute(a.id)).status).toBe("skipped");
  expect(ran).toBe(0);
  expect(db.select().from(schema.approvals).get()?.status).toBe("approved");
});

test("permission tightened to denied after approval blocks execution", async () => {
  const { db, perms, engine } = setup();
  let ran = 0;
  engine.registerExecutor("slack.send", {
    execute: async () => {
      ran++;
    },
  });
  const a = engine.request(db, req("slack.send"));
  engine.approve(a.id);
  perms.setOverride("slack.send", "denied");
  expect((await engine.execute(a.id)).status).toBe("skipped");
  expect(ran).toBe(0);
});

test("executor throw marks failed; missing executor skips", async () => {
  const { db, engine } = setup();
  engine.registerExecutor("slack.send", {
    execute: async () => {
      throw new Error("boom");
    },
  });
  const a = engine.request(db, req("slack.send"));
  engine.approve(a.id);
  expect((await engine.execute(a.id)).status).toBe("failed");
  expect(db.select().from(schema.approvals).get()?.status).toBe("failed");
  const b = engine.request(db, req("jira.write"));
  engine.approve(b.id);
  expect((await engine.execute(b.id)).status).toBe("skipped");
});

test("request emits approval.requested and an audit row; idempotent on key", () => {
  const { db, engine } = setup();
  const r = req("slack.send");
  const a = engine.request(db, r);
  const again = engine.request(db, r);
  expect(again.id).toBe(a.id);
  const evs = db.select().from(schema.domainEvents).all();
  expect(evs.map((e) => e.type)).toEqual(["approval.requested"]);
  expect(evs[0]?.payload).toEqual({ approvalId: a.id });
  const audits = db
    .select()
    .from(schema.auditEvents)
    .where(eq(schema.auditEvents.approvalId, a.id))
    .all();
  expect(audits.map((x) => x.action)).toEqual(["approval.requested"]);
  expect(a).toMatchObject({
    riskLevel: "medium",
    targetIntegration: "slack",
    targetRef: "C1/123",
    payload: { text: "hi" },
    requestedByModule: "inbox",
  });
  expect(engine.listPending()).toHaveLength(1);
});

test("request throws when the policy is denied", () => {
  const { db, perms, engine } = setup();
  perms.setOverride("slack.send", "denied");
  expect(() => engine.request(db, req("slack.send"))).toThrow();
});

test("invalid transitions throw InvalidApprovalTransition", () => {
  const { db, engine } = setup();
  const a = engine.request(db, req("slack.send"));
  expect(() => engine.revoke(a.id, "x")).toThrow(InvalidApprovalTransition);
  engine.reject(a.id, "no");
  expect(() => engine.approve(a.id)).toThrow(InvalidApprovalTransition);
  const types = db
    .select()
    .from(schema.domainEvents)
    .all()
    .map((e) => e.type);
  expect(types).toEqual(["approval.requested", "approval.rejected"]);
});

test("successful execution emits approval.executed and stores the result", async () => {
  const { db, engine } = setup();
  engine.registerExecutor("slack.send", { execute: async () => ({ ts: "1" }) });
  const a = engine.request(db, req("slack.send"));
  engine.approve(a.id);
  await engine.execute(a.id);
  expect(
    db
      .select()
      .from(schema.domainEvents)
      .all()
      .map((e) => e.type),
  ).toContain("approval.executed");
  expect(db.select().from(schema.approvals).get()?.executionResult).toEqual({ ts: "1" });
});

test("notification is stored and pushed to the live bus", () => {
  const { db, clock } = setup();
  const live = new LiveBus();
  const got: { type: string; data: unknown }[] = [];
  live.subscribe((m) => got.push(m));
  const svc = new NotificationService(db, clock, live);
  const id = svc.notify(db, { kind: "x", severity: "high", title: "T", body: "B", ref: "r" });
  const stored = svc.list();
  expect(stored).toHaveLength(1);
  expect(stored[0]?.id).toBe(id);
  expect(got).toEqual([{ type: "notification", data: stored[0] }]);
  svc.markRead(id);
  expect(svc.list({ unreadOnly: true })).toHaveLength(0);
});

test("concurrent execute with async revalidate: the claim transaction stops the second", async () => {
  const { db, engine } = setup();
  let ran = 0;
  engine.registerExecutor("slack.send", {
    execute: async () => {
      ran++;
      await Bun.sleep(10);
      return "done";
    },
    revalidate: async () => {
      await Bun.sleep(5);
      return true;
    },
  });
  const a = engine.request(db, req("slack.send"));
  engine.approve(a.id);
  const [x, y] = await Promise.all([engine.execute(a.id), engine.execute(a.id)]);
  expect(ran).toBe(1);
  expect([x.status, y.status].sort()).toEqual(["executed", "skipped"]);
});

test("non-canonical or unparseable expiresAt is rejected", () => {
  const { db, engine } = setup();
  for (const expiresAt of ["2026-01-01T01:00:00+01:00", "2026-01-01T00:01:00Z", "tomorrow"]) {
    expect(() => engine.request(db, req("slack.send", { expiresAt }))).toThrow();
  }
  expect(db.select().from(schema.approvals).all()).toHaveLength(0);
});

test("a result that cannot be stored never marks a performed execution failed", async () => {
  const { db, engine } = setup();
  let ran = 0;
  engine.registerExecutor("slack.send", {
    execute: async () => {
      ran++;
      return { n: 1n };
    },
  });
  const a = engine.request(db, req("slack.send"));
  engine.approve(a.id);
  await expect(engine.execute(a.id)).rejects.toThrow();
  const row = db.select().from(schema.approvals).get();
  expect(row?.status).toBe("approved");
  expect(row?.executionStartedAt).not.toBeNull();
  expect(ran).toBe(1);
  expect((await engine.execute(a.id)).status).toBe("skipped");
  expect(ran).toBe(1);
});

test("user_only operations cannot be requested", () => {
  const { db, engine } = setup();
  expect(() => engine.request(db, req("person.priority.set"))).toThrow();
});

test("updatePendingPayload changes a pending payload only", () => {
  const { db, engine } = setup();
  const a = db.transaction((tx) => engine.request(tx, req("slack.send")));
  const upd = db.transaction((tx) => engine.updatePendingPayload(tx, a.id, { text: "new" }));
  expect(upd?.payload).toEqual({ text: "new" });
  engine.approve(a.id);
  const again = db.transaction((tx) => engine.updatePendingPayload(tx, a.id, { text: "late" }));
  expect(again).toBeNull();
  const row = db.select().from(schema.approvals).where(eq(schema.approvals.id, a.id)).get();
  expect(row?.payload).toEqual({ text: "new" });
  expect(db.transaction((tx) => engine.updatePendingPayload(tx, "missing", {}))).toBeNull();
});

test("a failed executor stores only a fixed code, never the error text", async () => {
  const cases: [Error, string][] = [
    [new Error("token SECRET-TEXT"), "executor_failed"],
    [new JobError({ kind: "timeout", message: "SECRET" }), "timeout"],
    [new ExecutorError("protected_branch"), "protected_branch"],
    [Object.assign(new Error("SECRET"), { code: "Bad Code!" }), "executor_failed"],
  ];
  for (const [err, code] of cases) {
    const { db, engine } = setup();
    engine.registerExecutor("slack.send", {
      execute: async () => {
        throw err;
      },
    });
    const a = engine.request(db, req("slack.send"));
    engine.approve(a.id);
    const out = await engine.execute(a.id);
    expect(out).toEqual({ status: "failed", result: { error: code } });
    const row = db.select().from(schema.approvals).where(eq(schema.approvals.id, a.id)).get();
    expect(row?.executionResult).toEqual({ error: code });
    const failed = db
      .select()
      .from(schema.auditEvents)
      .all()
      .filter((e) => e.action === "approval.failed");
    expect(failed).toHaveLength(1);
    expect(JSON.stringify(failed[0]?.details)).toBe(JSON.stringify({ error: code }));
    expect(JSON.stringify([row, failed])).not.toContain("SECRET");
  }
});
