import { expect, test } from "bun:test";
import { DEFAULT_POLICIES, stricterOf } from "../src/index.ts";

test("overrides can only tighten", () => {
  expect(stricterOf("approval_required", "allowed")).toBe("approval_required");
  expect(stricterOf("allowed", "denied")).toBe("denied");
  expect(stricterOf("user_only", "allowed")).toBe("user_only");
  expect(stricterOf("allowed", "user_only")).toBe("user_only");
  expect(DEFAULT_POLICIES.deploy).toBe("explicit_approval_required");
  expect(DEFAULT_POLICIES["slack.read"]).toBe("allowed");
  expect(DEFAULT_POLICIES["person.priority.set"]).toBe("user_only");
  expect(DEFAULT_POLICIES["git.merge"]).toBe("approval_required");
});
