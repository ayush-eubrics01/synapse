import { expect, test } from "bun:test";
import { type ErrorKind, JobError, retryDecision } from "../src/index.ts";

test.each([
  ["transient_network", "retry"],
  ["connector_not_ready", "retry"],
  ["rate_limited", "retry"],
  ["incomplete_ai_output", "retry"],
  ["provider_error", "retry"],
  ["timeout", "retry"],
  ["unknown", "retry"],
  ["auth_failed", "needs_attention"],
  ["permission_denied", "needs_attention"],
  ["parse_failed", "needs_attention"],
  ["invalid_input", "fail"],
  ["quota_exhausted", "defer"],
])("%s -> %s", (k, d) => expect(retryDecision(k as ErrorKind)).toBe(d));

test("JobError carries the classified error", () => {
  const e = new JobError({ kind: "auth_failed", message: "bad token" });
  expect(e).toBeInstanceOf(Error);
  expect(e.message).toBe("bad token");
  expect(e.classified.kind).toBe("auth_failed");
});
