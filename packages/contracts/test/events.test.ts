import { expect, test } from "bun:test";
import { eventCatalog, parseEventPayload } from "../src/index.ts";

test("event payload validation", () => {
  expect(() => parseEventPayload("approval.requested", { approvalId: "a" })).not.toThrow();
  expect(() => parseEventPayload("approval.requested", {})).toThrow();
  expect(() => parseEventPayload("no.such", {})).toThrow();
});

test("catalog covers the Phase 1 and 2 events", () => {
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
      "claude.job_started",
      "claude.job_completed",
      "claude.job_failed",
      "quota.threshold_reached",
      "auth.expiry_warning",
      "message.received",
      "message.thread_updated",
      "collection.completed",
      "collection.failed",
      "message.screened",
      "message.urgent_detected",
      "security.injection_suspected",
      "security.flag_reviewed",
      "urgency.status_changed",
      "person.discovered",
      "person.profile_recommendation_created",
      "person.profile_approved",
      "person.recommendation_decided",
      "commitment.detected",
      "commitment.reviewed",
      "commitment.status_changed",
      "commitment.stalled",
      "commitment.overdue",
      "followup.draft_created",
      "followup.status_changed",
      "followup.sent",
      "outgoing.status_changed",
      "autoreply.sent",
      "autoreply.held",
      "away.changed",
      "claude_session.activity_changed",
      "code_answer.status_changed",
      "jira.issue_updated",
      "jira.issue_attention",
      "repo.registered",
      "repo.drift_detected",
      "brain.facts_proposed",
      "brain.fact_decided",
      "engineering.task_created",
      "engineering.task_status_changed",
      "engineering.step_changed",
      "engineering.lock_changed",
    ].sort(),
  );
  expect(parseEventPayload("settings.changed", { key: "k" })).toEqual({ key: "k" });
  expect(() => parseEventPayload("system.heartbeat", { at: 1 })).toThrow();
});

test("message and collection events", () => {
  expect(parseEventPayload("message.received", { messageId: "m" })).toEqual({ messageId: "m" });
  expect(parseEventPayload("message.thread_updated", { messageId: "m" })).toEqual({
    messageId: "m",
  });
  expect(
    parseEventPayload("collection.completed", {
      stream: "slack",
      pages: 1,
      inserted: 2,
      duplicates: 0,
      rejected: 0,
    }),
  ).toBeDefined();
  expect(
    parseEventPayload("collection.failed", { stream: "slack", kind: "rate_limited" }),
  ).toBeDefined();
  for (const t of [
    "message.received",
    "message.thread_updated",
    "collection.completed",
    "collection.failed",
  ]) {
    expect(() => parseEventPayload(t, {})).toThrow();
  }
});

test("away-mode event payloads (A16) carry ids and fixed reasons only", () => {
  expect(parseEventPayload("autoreply.sent", { autoReplyId: "a" })).toEqual({ autoReplyId: "a" });
  expect(
    parseEventPayload("autoreply.held", { autoReplyId: "a", reason: "policy_disabled" }),
  ).toEqual({ autoReplyId: "a", reason: "policy_disabled" });
  expect(() =>
    parseEventPayload("autoreply.held", { autoReplyId: "a", reason: "free text" }),
  ).toThrow();
  expect(parseEventPayload("away.changed", { on: true })).toEqual({ on: true });
});
