import { expect, test } from "bun:test";
import { openDatabase, runMigrations, schema } from "@synapse/database";
import { FakeClock } from "@synapse/shared";
import { AuditLogger } from "../../src/core/audit/audit.ts";

test("audit row written", () => {
  const { db } = openDatabase(":memory:");
  runMigrations(db);
  const audit = new AuditLogger(new FakeClock("2026-01-01T00:00:00.000Z"));
  const id = audit.record(db, { actor: "system", module: "test", action: "x", result: "ok" });
  const rows = db.select().from(schema.auditEvents).all();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.id).toBe(id);
  expect(rows[0]?.occurredAt).toBe("2026-01-01T00:00:00.000Z");
});
