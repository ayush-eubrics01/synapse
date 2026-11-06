import { expect, test } from "bun:test";
import {
  commitmentCandidateSchema,
  commitmentExtractionOutputSchema,
  followupDraftOutputSchema,
  parseEventPayload,
  specClarityOutputSchema,
  strictSuspectedInjectionSchema,
} from "../src/index.ts";

const noInjection = { detected: false, severity: "info", quote: "", reason: "" };
const candidate = {
  description: "Send the report",
  owner: "U1",
  counterparty: null,
  dueAt: null,
  evidence: ["m1"],
  kind: "promise",
  confidence: "high",
};

test("candidate and extraction output are strict", () => {
  expect(commitmentCandidateSchema.safeParse(candidate).success).toBe(true);
  expect(commitmentCandidateSchema.safeParse({ ...candidate, priority: "high" }).success).toBe(
    false,
  );
  const out = { candidates: [candidate], suspectedInjection: noInjection };
  expect(commitmentExtractionOutputSchema.safeParse(out).success).toBe(true);
  expect(commitmentExtractionOutputSchema.safeParse({ ...out, extra: 1 }).success).toBe(false);
  expect(
    commitmentExtractionOutputSchema.safeParse({
      ...out,
      suspectedInjection: { ...noInjection, priority: "high" },
    }).success,
  ).toBe(false);
});

test("candidate bounds", () => {
  expect(commitmentCandidateSchema.safeParse({ ...candidate, owner: "bob" }).success).toBe(false);
  expect(commitmentCandidateSchema.safeParse({ ...candidate, evidence: [] }).success).toBe(false);
  expect(
    commitmentCandidateSchema.safeParse({ ...candidate, description: "x".repeat(501) }).success,
  ).toBe(false);
  expect(
    commitmentCandidateSchema.safeParse({ ...candidate, dueAt: "2026-11-06T10:00:00+05:30" })
      .success,
  ).toBe(true);
  expect(commitmentCandidateSchema.safeParse({ ...candidate, dueAt: "tomorrow" }).success).toBe(
    false,
  );
});

test("draft max is 4000 and output is strict", () => {
  const ok = { draft: "x".repeat(4000), confidence: 0.5, suspectedInjection: noInjection };
  expect(followupDraftOutputSchema.safeParse(ok).success).toBe(true);
  expect(followupDraftOutputSchema.safeParse({ ...ok, draft: "x".repeat(4001) }).success).toBe(
    false,
  );
  expect(followupDraftOutputSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
});

test("spec clarity output is strict", () => {
  const ok = {
    clear: false,
    missing: ["steps"],
    questions: ["What are the steps?"],
    suspectedInjection: noInjection,
  };
  expect(specClarityOutputSchema.safeParse(ok).success).toBe(true);
  expect(specClarityOutputSchema.safeParse({ ...ok, missing: ["vibes"] }).success).toBe(false);
  expect(specClarityOutputSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
});

test("shared strict injection schema rejects extra keys", () => {
  expect(strictSuspectedInjectionSchema.safeParse(noInjection).success).toBe(true);
  expect(strictSuspectedInjectionSchema.safeParse({ ...noInjection, x: 1 }).success).toBe(false);
});

test.each([
  ["commitment.detected", { commitmentId: "c" }],
  ["commitment.reviewed", { commitmentId: "c", reviewStatus: "accepted" }],
  ["commitment.status_changed", { commitmentId: "c", status: "completed" }],
  ["commitment.stalled", { commitmentId: "c" }],
  ["commitment.overdue", { commitmentId: "c" }],
  ["followup.draft_created", { followupId: "f" }],
  ["followup.status_changed", { followupId: "f", status: "sent" }],
  ["followup.sent", { followupId: "f", outgoingId: "o" }],
  ["outgoing.status_changed", { outgoingId: "o", status: "sent" }],
])("event %s parses", (type, payload) => {
  expect(() => parseEventPayload(type, payload)).not.toThrow();
  expect(() => parseEventPayload(type, {})).toThrow();
});
