import { expect, test } from "bun:test";
import { claudeJobRequestSchema, parseEventPayload, workerProfileSchema } from "../src/index.ts";

const valid = {
  workerProfile: "collector",
  priorityClass: "collection",
  instructions: "do it",
  allowedTools: ["ToolSearch"],
  maxTurns: 5,
};

test("claudeJobRequestSchema accepts a minimal request", () => {
  expect(claudeJobRequestSchema.safeParse(valid).success).toBe(true);
});

test("claudeJobRequestSchema rejects bad maxTurns and empty allowedTools", () => {
  expect(claudeJobRequestSchema.safeParse({ ...valid, maxTurns: 0 }).success).toBe(false);
  expect(claudeJobRequestSchema.safeParse({ ...valid, maxTurns: 51 }).success).toBe(false);
  expect(claudeJobRequestSchema.safeParse({ ...valid, allowedTools: [] }).success).toBe(false);
});

test("new claude/quota/auth events parse and reject empty payloads", () => {
  const ok: Record<string, unknown> = {
    "claude.job_started": { runId: "r", jobId: null },
    "claude.job_completed": { runId: "r" },
    "claude.job_failed": { runId: "r", kind: "timeout" },
    "quota.threshold_reached": {
      window: "five_hour",
      level: "soft",
      resetsAt: "2026-01-01T00:00:00Z",
    },
    "auth.expiry_warning": { refreshExpiresAt: "2026-01-01T00:00:00Z" },
  };
  for (const [type, payload] of Object.entries(ok)) {
    expect(() => parseEventPayload(type, payload)).not.toThrow();
    expect(() => parseEventPayload(type, {})).toThrow();
  }
  expect(() => parseEventPayload("claude.job_failed", { runId: "r", kind: "bogus" })).toThrow();
});

test("workerProfileSchema accepts the reader profile (C1)", () => {
  expect(workerProfileSchema.parse("reader")).toBe("reader");
  expect(claudeJobRequestSchema.safeParse({ ...valid, workerProfile: "reader" }).success).toBe(
    true,
  );
  expect(workerProfileSchema.safeParse("writer").success).toBe(false);
});
