import { expect, test } from "bun:test";
import { openDatabase, runMigrations, schema } from "@synapse/database";
import { FakeClock } from "@synapse/shared";
import { AuditLogger } from "../../src/core/audit/audit";
import { PermissionManager } from "../../src/core/permissions/permissions";

function setup() {
  const { db } = openDatabase(":memory:");
  runMigrations(db);
  return {
    db,
    perms: new PermissionManager(db, new AuditLogger(new FakeClock("2026-01-01T00:00:00.000Z"))),
  };
}

test("defaults apply with no override", () => {
  const { perms } = setup();
  expect(perms.check("slack.read")).toBe("allowed");
  expect(perms.check("deploy")).toBe("explicit_approval_required");
});

test("looser override is ignored and audited", () => {
  const { db, perms } = setup();
  perms.setOverride("slack.send", "allowed");
  expect(perms.check("slack.send")).toBe("approval_required");
  const actions = db
    .select()
    .from(schema.auditEvents)
    .all()
    .map((r) => r.action);
  expect(actions).toEqual(["permission.override_ignored"]);
  expect(db.select().from(schema.permissions).all()).toHaveLength(1);
});

test("stricter override takes effect and can be replaced", () => {
  const { db, perms } = setup();
  perms.setOverride("slack.send", "denied");
  expect(perms.check("slack.send")).toBe("denied");
  perms.setOverride("slack.send", "explicit_approval_required");
  expect(perms.check("slack.send")).toBe("explicit_approval_required");
  expect(db.select().from(schema.permissions).all()).toHaveLength(1);
});

test("slack.auto_reply defaults to policy_gated; overrides can only tighten it", () => {
  const { perms } = setup();
  expect(perms.check("slack.auto_reply")).toBe("policy_gated");
  perms.setOverride("slack.auto_reply", "allowed");
  expect(perms.check("slack.auto_reply")).toBe("policy_gated");
  perms.setOverride("slack.auto_reply", "approval_required");
  expect(perms.check("slack.auto_reply")).toBe("approval_required");
  // An override replaces the previous one, and is never looser than the default.
  perms.setOverride("slack.auto_reply", "allowed");
  expect(perms.check("slack.auto_reply")).toBe("policy_gated");
});

test("policy_gated is never looser-overridable on other actions", () => {
  const { perms } = setup();
  perms.setOverride("slack.send", "policy_gated");
  expect(perms.check("slack.send")).toBe("approval_required");
});
