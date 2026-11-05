import { expect, test } from "bun:test";
import { eventCatalog, parseEventPayload } from "../src/index.ts";

test("event payload validation", () => {
  expect(() => parseEventPayload("approval.requested", { approvalId: "a" })).not.toThrow();
  expect(() => parseEventPayload("approval.requested", {})).toThrow();
  expect(() => parseEventPayload("no.such", {})).toThrow();
});

test("catalog covers the Phase 1 events", () => {
  expect(Object.keys(eventCatalog).sort()).toEqual(
    [
      "approval.requested",
      "approval.approved",
      "approval.rejected",
      "approval.expired",
      "approval.revoked",
      "approval.executed",
      "settings.changed",
      "system.heartbeat",
    ].sort(),
  );
  expect(parseEventPayload("settings.changed", { key: "k" })).toEqual({ key: "k" });
  expect(() => parseEventPayload("system.heartbeat", { at: 1 })).toThrow();
});
