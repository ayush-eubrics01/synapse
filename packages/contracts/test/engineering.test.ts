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
import { isSafeTestCommand as fromPatterns, testResultLabel } from "../src/patterns.ts";

describe("isSafeTestCommand", () => {
  test.each([
    "bun test",
    "bun test src/x.test.ts",
    "npm test",
    "pnpm test",
    "yarn test",
    "npm test -- --watch=false",
    "npm run test",
    "npm run test:unit",
    "pnpm run test-e2e",
    "yarn run test:ci",
    "bun run test",
    "uv run pytest -q",
    "uv run python -m pytest tests",
    "uv run python -m unittest",
    "make test",
    "make check",
    "make test-unit",
    "make -j4 test",
    "python -m pytest tests/unit",
    "python3 -m unittest discover",
    "pytest",
    "pytest -q tests/unit",
    "npx vitest run",
    "npx jest",
    "npx mocha",
    "npx playwright test",
    "npx ava",
    "go test ./...",
    "cargo test",
    "cargo test --lib",
    "deno test",
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
    // Launchers and code evaluation (amended: final review).
    "bun -e x",
    "bun --eval x",
    "bun x cowsay",
    "bun exec x",
    "bun run build",
    "bun run deploy",
    "bun install",
    "bun add left-pad",
    "npm exec x",
    "npm install",
    "npm run build",
    "npm run pretest-x",
    "npm test -c x",
    "pnpm dlx x",
    "pnpm add x",
    "pnpm run lint",
    "yarn dlx x",
    "yarn add x",
    "yarn run build",
    "npx tsx script.ts",
    "npx cowsay",
    "npx playwright install",
    "python -c x",
    "python3 -c x",
    "python script.py",
    "python -m pip install x",
    "python -m http.server",
    "python3 -m venv x",
    "uv run script.py",
    "uv run python script.py",
    "uv run python -m pip",
    "uv pip install x",
    "uv run pytest -c x",
    "make",
    "make build",
    "make -f other.mk test",
    "make test deploy",
    "make test SHELL=/bin/x",
    "make --eval=x test",
    "make -C /tmp test",
    "go run ./cmd",
    "go build ./...",
    "go generate",
    "cargo run",
    "cargo build",
    "cargo install x",
    "deno run x.ts",
    "deno eval x",
    "deno task test",
    "pytest -c x",
  ])("refuses %j", (c) => expect(isSafeTestCommand(c)).toBe(false));
  test("is exported from the zod-free subpath", () => {
    expect(fromPatterns).toBe(isSafeTestCommand);
  });
});

describe("testResultLabel (M1)", () => {
  test.each([
    [true, "exact", "Tests passed"],
    [false, "exact", "Tests failed"],
    [true, "partial", "Partial test run (passed)"],
    [false, "partial", "Partial test run (failed)"],
    [false, "none", "Tests not run"],
    [true, "none", "Tests not run"],
  ] as const)("testsPassed=%p run=%s → %s", (passed, run, label) =>
    expect(testResultLabel(passed, run)).toBe(label),
  );
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
