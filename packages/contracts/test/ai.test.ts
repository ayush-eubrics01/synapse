import { describe, expect, test } from "bun:test";
import {
  claudeJobRequestSchema,
  parseEventPayload,
  SANDBOX_MASKED_ROOTS,
  workerProfileSchema,
} from "../src/index.ts";

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

describe("sandbox (F1.1, ADR-040)", () => {
  const SANDBOX = { tmpDir: "/home/u/s/runs/j1/tmp", denyRead: ["/home/u/.ssh"] };
  const eng = { ...valid, workerProfile: "engineering", priorityClass: "engineering" };

  test("claudeJobRequestSchema accepts a sandbox", () => {
    const r = claudeJobRequestSchema.safeParse({ ...eng, sandbox: SANDBOX });
    expect(r.success).toBe(true);
    expect(r.data?.sandbox).toEqual(SANDBOX);
  });

  test("an extra key, a string denyRead and 65 entries are rejected", () => {
    for (const sandbox of [
      { ...SANDBOX, extra: true },
      { ...SANDBOX, denyRead: "x" },
      { ...SANDBOX, denyRead: Array.from({ length: 65 }, (_, i) => `/home/u/d${i}`) },
      { ...SANDBOX, tmpDir: "" },
      { ...SANDBOX, denyRead: [""] },
    ]) {
      expect(claudeJobRequestSchema.safeParse({ ...eng, sandbox }).success).toBe(false);
    }
    expect(
      claudeJobRequestSchema.safeParse({
        ...eng,
        sandbox: { ...SANDBOX, denyRead: Array.from({ length: 64 }, (_, i) => `/home/u/d${i}`) },
      }).success,
    ).toBe(true);
  });

  test("the masked roots are the three the sandbox settings list", () => {
    expect([...SANDBOX_MASKED_ROOTS]).toEqual(["/run", "/var/run", "/tmp"]);
  });
});
