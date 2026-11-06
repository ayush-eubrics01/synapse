import { describe, expect, test } from "bun:test";
import {
  DEFAULT_POLICIES,
  developOutputSchema,
  engineeringTaskCreateInputSchema,
  investigationOutputSchema,
  isSafeTestCommand,
  parentBranchSchema,
  planApprovalInputSchema,
  taskBranchName,
} from "../src/index.ts";
import { isSafeTestCommand as fromPatterns } from "../src/patterns.ts";

describe("isSafeTestCommand", () => {
  test.each([
    "bun test",
    "npm test",
    "uv run pytest -q",
    "make test",
    "python -m pytest tests/unit",
    "pytest",
    "make",
    "npx vitest run",
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
    "bun",
    "npx",
    "python",
    "node test",
    "cargo",
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

describe("planApprovalInputSchema", () => {
  const ok = { parentBranch: "main", testCommand: "bun test" };
  test("accepts optional fields", () => {
    expect(
      planApprovalInputSchema.parse({ ...ok, environmentId: "e1", rememberAsTracked: true }),
    ).toMatchObject({ environmentId: "e1", rememberAsTracked: true });
    expect(() => planApprovalInputSchema.parse({ ...ok, environmentId: "" })).toThrow();
  });
  test.each(["main", "release/1.2", "feat_x-1.0"])("branch %s ok", (b) =>
    expect(parentBranchSchema.safeParse(b).success).toBe(true),
  );
  test.each(["", "-x", "a..b", "a//b", "a/", "a.lock", "a b", "a;b", "a".repeat(101)])(
    "branch %j refused",
    (b) => expect(parentBranchSchema.safeParse(b).success).toBe(false),
  );
});

test("caps", () => {
  const inv = {
    summary: "s",
    plan: [{ step: "x" }],
    filesLikelyTouched: [],
    risk: "low",
    size: "s",
    unclear: [],
  };
  expect(investigationOutputSchema.safeParse(inv).success).toBe(true);
  expect(
    investigationOutputSchema.safeParse({ ...inv, testCommand: "a".repeat(121) }).success,
  ).toBe(false);
  expect(
    investigationOutputSchema.safeParse({ ...inv, filesLikelyTouched: ["a".repeat(301)] }).success,
  ).toBe(false);
  expect(investigationOutputSchema.safeParse({ ...inv, unclear: ["a".repeat(301)] }).success).toBe(
    false,
  );
  const dev = { summary: "s", testsPassed: true, testOutputTail: "", notes: "n" };
  expect(developOutputSchema.safeParse(dev).success).toBe(true);
  expect(developOutputSchema.safeParse({ ...dev, summary: "a".repeat(2001) }).success).toBe(false);
  expect(developOutputSchema.safeParse({ ...dev, notes: "a".repeat(2001) }).success).toBe(false);
  const c = { repositoryId: "r", title: "t", draftDescription: "a".repeat(8000) };
  expect(engineeringTaskCreateInputSchema.safeParse(c).success).toBe(true);
  expect(
    engineeringTaskCreateInputSchema.safeParse({ ...c, draftDescription: "a".repeat(8001) })
      .success,
  ).toBe(false);
});
