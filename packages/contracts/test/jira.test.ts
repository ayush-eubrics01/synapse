import { expect, test } from "bun:test";
import { JIRA_PROJECT_KEY_RE, repositoryRegisterInputSchema } from "../src";

test("JIRA_PROJECT_KEY_RE is the one Jira project key rule, shared with the web form", () => {
  for (const k of ["DEMO", "AB", "A1", "MY_PROJ"]) expect(JIRA_PROJECT_KEY_RE.test(k)).toBe(true);
  for (const k of ["demo", "A", "1AB", "AB-1", " AB", "AB "]) {
    expect(JIRA_PROJECT_KEY_RE.test(k)).toBe(false);
  }
  const base = { path: "/tmp/x/app", name: "app", trackedBranch: "main", environments: [] };
  expect(
    repositoryRegisterInputSchema.safeParse({ ...base, jiraProjectKeys: ["AB"] }).success,
  ).toBe(true);
  expect(
    repositoryRegisterInputSchema.safeParse({ ...base, jiraProjectKeys: ["ab"] }).success,
  ).toBe(false);
});
