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
