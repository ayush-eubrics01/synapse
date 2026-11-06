import { expect, test } from "bun:test";
import type { Operation } from "@synapse/contracts";
import { openDatabase, runMigrations, schema } from "@synapse/database";
import { FakeClock } from "@synapse/shared";
import { eq } from "drizzle-orm";
import {
  ApprovalEngine,
  AutoReplyDisabledByPermission,
  PolicyApprovalNotAllowed,
} from "../../src/core/approvals/approvals";
import { AuditLogger } from "../../src/core/audit/audit";
import { EventPublisher } from "../../src/core/events/publisher";
import { PermissionManager } from "../../src/core/permissions/permissions";

const SECRET = "SECRET-POLICY-TEXT";

function setup() {
  const { db } = openDatabase(":memory:");
  runMigrations(db);
  const clock = new FakeClock("2026-11-06T12:00:00.000Z");
  const audit = new AuditLogger(clock);
  const perms = new PermissionManager(db, audit);
  const engine = new ApprovalEngine(db, clock, new EventPublisher(clock), audit, perms);
  const row = (id: string) =>
    db.select().from(schema.approvals).where(eq(schema.approvals.id, id)).get();
  const auditFor = (id: string) =>
    db.select().from(schema.auditEvents).where(eq(schema.auditEvents.approvalId, id)).all();
  const eventsFor = (id: string) =>
    db
      .select()
      .from(schema.domainEvents)
      .where(eq(schema.domainEvents.aggregateId, id))
      .all()
      .map((e) => e.type);
  return { db, clock, perms, engine, row, auditFor, eventsFor };
}

let n = 0;
function req(action: Operation) {
  n++;
  return {
    action,
    targetIntegration: "slack",
    targetRef: "C0SYNTH01",
    payload: { outgoingId: `o${n}`, note: SECRET },
    riskLevel: "medium" as const,
    idempotencyKey: `policy-k${n}`,
    requestedByModule: "auto-reply",
  };
}

test("recordPolicyApproval refuses any action other than slack.auto_reply", () => {
  const { db, engine } = setup();
  for (const action of ["slack.send", "jira.write", "git.push"] as const) {
    expect(() => engine.recordPolicyApproval(db, req(action), "auto_reply_policy")).toThrow(
      PolicyApprovalNotAllowed,
    );
  }
  expect(db.select().from(schema.approvals).all()).toHaveLength(0);
});

test("request() refuses slack.auto_reply, so it can never pend for the user", () => {
  const { db, perms, engine } = setup();
  expect(() => engine.request(db, req("slack.auto_reply"))).toThrow();
  // Even tightened to approval_required, the action is never requestable.
  perms.setOverride("slack.auto_reply", "approval_required");
  expect(() => engine.request(db, req("slack.auto_reply"))).toThrow();
  expect(db.select().from(schema.approvals).all()).toHaveLength(0);
});

test("request() refuses any action whose effective policy is policy_gated", () => {
  const { db, perms, engine } = setup();
  // allowed -> policy_gated is a tightening, so it applies.
  perms.setOverride("slack.read", "policy_gated");
  expect(perms.check("slack.read")).toBe("policy_gated");
  expect(() => engine.request(db, req("slack.read"))).toThrow();
  expect(db.select().from(schema.approvals).all()).toHaveLength(0);
});

test("a policy approval is approved, decided_by policy, audited as system with ids only", () => {
  const { db, engine, row, auditFor, eventsFor } = setup();
  const a = engine.recordPolicyApproval(db, req("slack.auto_reply"), "auto_reply_policy");
  expect(a.status).toBe("approved");
  const r = row(a.id);
  expect(r?.status).toBe("approved");
  expect(r?.decidedBy).toBe("policy");
  expect(r?.decidedAt).not.toBeNull();
  const audits = auditFor(a.id);
  expect(audits).toHaveLength(1);
  expect(audits[0]?.actor).toBe("system");
  expect(audits[0]?.action).toBe("approval.policy_approved");
  expect(JSON.stringify(audits)).not.toContain(SECRET);
  // The normal execute path runs from approval.approved; it never pends (no approval.requested).
  expect(eventsFor(a.id)).toEqual(["approval.approved"]);
});

test("recordPolicyApproval is idempotent on its key", () => {
  const { db, engine } = setup();
  const r = req("slack.auto_reply");
  const a = engine.recordPolicyApproval(db, r, "auto_reply_policy");
  const b = engine.recordPolicyApproval(db, r, "auto_reply_policy");
  expect(b.id).toBe(a.id);
  expect(db.select().from(schema.approvals).all()).toHaveLength(1);
});

test("recordPolicyApproval throws AutoReplyDisabledByPermission once the user tightens the policy", () => {
  for (const policy of ["approval_required", "explicit_approval_required", "denied"] as const) {
    const { db, perms, engine } = setup();
    perms.setOverride("slack.auto_reply", policy);
    expect(() =>
      engine.recordPolicyApproval(db, req("slack.auto_reply"), "auto_reply_policy"),
    ).toThrow(AutoReplyDisabledByPermission);
    expect(db.select().from(schema.approvals).all()).toHaveLength(0);
  }
});

test("a user approval is recorded as decided_by user", () => {
  const { db, engine, row } = setup();
  const a = engine.request(db, req("slack.send"));
  expect(row(a.id)?.decidedBy).toBeNull();
  engine.approve(a.id);
  expect(row(a.id)?.decidedBy).toBe("user");
});

test("revokeAsSystem revokes an unclaimed approval with actor system, inside the caller's tx", () => {
  const { db, engine, row, auditFor } = setup();
  const a = engine.recordPolicyApproval(db, req("slack.auto_reply"), "auto_reply_policy");
  db.transaction((tx) => engine.revokeAsSystem(tx, a.id, "away_off"));
  expect(row(a.id)?.status).toBe("revoked");
  const revoke = auditFor(a.id).find((x) => x.action === "approval.revoked");
  expect(revoke?.actor).toBe("system");
});

test("a policy approval whose gate closes after approval is never executed", async () => {
  const { db, perms, engine, row } = setup();
  let ran = 0;
  engine.registerExecutor("slack.auto_reply", {
    execute: async () => {
      ran++;
    },
  });
  const a = engine.recordPolicyApproval(db, req("slack.auto_reply"), "auto_reply_policy");
  perms.setOverride("slack.auto_reply", "approval_required");
  expect((await engine.execute(a.id)).status).toBe("skipped");
  expect(ran).toBe(0);
  // It can never run later either: the engine revokes it (its consumers clean up).
  expect(row(a.id)?.status).toBe("revoked");
});
