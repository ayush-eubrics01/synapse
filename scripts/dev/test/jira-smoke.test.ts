import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SourceIssue } from "@synapse/contracts";
import { cleanupDir, parseArgs, summarize, UsageError } from "../jira-smoke";

const issue = (over: Partial<SourceIssue>): SourceIssue => ({
  key: "AAA-1",
  jiraId: "1",
  projectKey: "AAA",
  summary: "SECRET SUMMARY",
  statusName: "To Do",
  statusCategory: "new",
  priority: null,
  issueType: "Task",
  labels: [],
  dueDate: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  webUrl: "https://example.invalid/browse/AAA-1",
  ...over,
});

test("parseArgs: no arguments, --cloud-id and --jql in both forms", () => {
  expect(parseArgs([])).toEqual({});
  expect(parseArgs(["--cloud-id", "abc-12345"])).toEqual({ cloudId: "abc-12345" });
  expect(parseArgs(["--jql=project = X", "--cloud-id=abc-12345"])).toEqual({
    cloudId: "abc-12345",
    jql: "project = X",
  });
});

test("parseArgs: missing values and unknown arguments are usage errors", () => {
  for (const argv of [
    ["--jql"],
    ["--cloud-id"],
    ["--cloud-id", "not a uuid!"],
    ["--x"],
    ["--jql="],
  ]) {
    expect(() => parseArgs(argv)).toThrow(UsageError);
  }
});

test("summarize: counts only, distinct projects, no keys or text", () => {
  const lines = summarize(
    [
      issue({ key: "AAA-1" }),
      issue({ key: "AAA-2", statusCategory: "indeterminate" }),
      issue({ key: "BBB-1", projectKey: "BBB", statusCategory: "done" }),
      issue({ key: "BBB-2", projectKey: "BBB", statusCategory: "done" }),
    ],
    { sites: 1, hasNextPage: true },
  );
  expect(lines).toEqual([
    "sites: 1",
    "issues: 4",
    "hasNextPage: true",
    "statusCategory: new=1 indeterminate=1 done=2",
    "projects: 2",
  ]);
  const text = lines.join("\n");
  for (const leak of ["AAA", "BBB", "SECRET", "example.invalid"]) expect(text).not.toContain(leak);
});

test("summarize: empty page", () => {
  expect(summarize([], { sites: 1, hasNextPage: false })).toEqual([
    "sites: 1",
    "issues: 0",
    "hasNextPage: false",
    "statusCategory: new=0 indeterminate=0 done=0",
    "projects: 0",
  ]);
});

test("cleanupDir removes the directory and its contents", () => {
  const dir = mkdtempSync(join(tmpdir(), "jira-smoke-test-"));
  writeFileSync(join(dir, "x.db"), "x");
  cleanupDir(dir);
  expect(existsSync(dir)).toBe(false);
});
