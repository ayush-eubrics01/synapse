import { describe, expect, test } from "bun:test";
import { DEFAULT_POLICIES, isSafeTestCommand, taskBranchName } from "../src/index.ts";
import { isSafeTestCommand as fromPatterns } from "../src/patterns.ts";

describe("isSafeTestCommand", () => {
  test.each([
    "bun test",
    "npm test",
    "uv run pytest -q",
    "make test",
    "python -m pytest tests/unit",
  ])("accepts %s", (c) => expect(isSafeTestCommand(c)).toBe(true));
  test.each([
    "bun test; rm -rf x",
    "bun test && x",
    "bun test | tee",
    "bun test $(x)",
    "bun test `x`",
    "bun test > f",
    "curl x",
    "rm -rf /",
    "",
    `bun test ${"a".repeat(120)}`,
    "bun test\nrm x",
  ])("refuses %j", (c) => expect(isSafeTestCommand(c)).toBe(false));
  test("is exported from the zod-free subpath", () => {
    expect(fromPatterns).toBe(isSafeTestCommand);
  });
});

test("taskBranchName", () => {
  expect(taskBranchName("0123456789abcdef", "Fix: CSV import!!")).toBe(
    "synapse/01234567-fix-csv-import",
  );
  const long = taskBranchName("0123456789abcdef", "a".repeat(80));
  expect(long.length).toBeLessThanOrEqual("synapse/01234567-".length + 32);
  expect(taskBranchName("0123456789abcdef", "!!!")).toBe("synapse/01234567-task");
});

test("engineering approval actions", () => {
  expect(DEFAULT_POLICIES["engineering.commit"]).toBe("approval_required");
  expect(DEFAULT_POLICIES["engineering.merge_local"]).toBe("approval_required");
  expect(DEFAULT_POLICIES["engineering.push_pr"]).toBe("approval_required");
  expect(DEFAULT_POLICIES["engineering.merge_pr"]).toBe("explicit_approval_required");
});
