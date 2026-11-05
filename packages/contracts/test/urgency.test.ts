import { expect, test } from "bun:test";
import {
  parseEventPayload,
  suggestedResponseSchema,
  urgencyAssessmentSchema,
} from "../src/index.ts";

const inj = { detected: false, severity: "info", quote: "", reason: "" };

test("urgencyAssessmentSchema accepts a valid batch", () => {
  const ok = urgencyAssessmentSchema.safeParse({
    assessments: [{ messageId: "m", level: "high", reason: "blocked", suspectedInjection: inj }],
  });
  expect(ok.success).toBe(true);
});

test("urgencyAssessmentSchema rejects bad level, long reason and empty list", () => {
  const base = { messageId: "m", level: "high", reason: "r", suspectedInjection: inj };
  expect(
    urgencyAssessmentSchema.safeParse({ assessments: [{ ...base, level: "urgent" }] }).success,
  ).toBe(false);
  expect(
    urgencyAssessmentSchema.safeParse({ assessments: [{ ...base, reason: "x".repeat(301) }] })
      .success,
  ).toBe(false);
  expect(urgencyAssessmentSchema.safeParse({ assessments: [] }).success).toBe(false);
});

test("suggestedResponseSchema bounds confidence and draft", () => {
  const base = { draft: "ok", confidence: 0.5, suspectedInjection: inj };
  expect(suggestedResponseSchema.safeParse(base).success).toBe(true);
  expect(suggestedResponseSchema.safeParse({ ...base, confidence: 1.5 }).success).toBe(false);
  expect(suggestedResponseSchema.safeParse({ ...base, draft: "" }).success).toBe(false);
});

test("new urgency events parse and reject bad payloads", () => {
  const good: Record<string, unknown> = {
    "message.screened": { messageId: "m", candidate: true, score: 3, securityFlag: false },
    "message.urgent_detected": { messageId: "m", level: "critical", assessed: true },
    "security.injection_suspected": { flagId: "f", messageId: null, severity: "high" },
    "security.flag_reviewed": { flagId: "f", status: "dismissed" },
    "urgency.status_changed": { messageId: "m", status: "resolved" },
  };
  for (const [t, p] of Object.entries(good)) {
    expect(() => parseEventPayload(t, p)).not.toThrow();
    expect(() => parseEventPayload(t, {})).toThrow();
  }
  expect(() =>
    parseEventPayload("message.urgent_detected", { messageId: "m", level: "low", assessed: true }),
  ).toThrow();
});
