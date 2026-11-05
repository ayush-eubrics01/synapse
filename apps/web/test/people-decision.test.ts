import { expect, test } from "bun:test";
import { decisionFor } from "../lib/people-decision";

test("decisionFor targets the approval id, not the recommendation id", () => {
  const item = { id: "rec-1", approvalId: "appr-1" };
  expect(decisionFor(item, "approve")).toEqual({ approvalId: "appr-1", decision: "approve" });
  expect(decisionFor(item, "approve")?.approvalId).not.toBe("rec-1");
});

test("decisionFor passes the reject reason through", () => {
  const item = { id: "rec-1", approvalId: "appr-1" };
  expect(decisionFor(item, "reject", "not accurate")).toEqual({
    approvalId: "appr-1",
    decision: "reject",
    reason: "not accurate",
  });
});

test("decisionFor is null when there is no approval", () => {
  expect(decisionFor({ id: "rec-1", approvalId: null }, "approve")).toBeNull();
});
