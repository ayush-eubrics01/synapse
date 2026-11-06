import { describe, expect, test } from "bun:test";
import {
  JiraParseError,
  parseResources,
  parseSearchResult,
} from "../../src/integrations/jira/parse";

const CLOUD = "00000000-0000-4000-8000-000000000000";

const node = (key: string, over: Record<string, unknown> = {}) => ({
  expand: "",
  id: key === "DEMO-1" ? "10001" : "10002",
  key,
  self: `https://example.atlassian.net/rest/api/3/issue/${key}`,
  webUrl: `https://example.atlassian.net/browse/${key}`,
  fields: {
    summary: `synthetic summary ${key}`,
    status: { name: "In Progress", statusCategory: { key: "indeterminate", name: "In Progress" } },
    priority: { name: "High" },
    issuetype: { name: "Task", subtask: false },
    project: { key: "DEMO", name: "Demo" },
    labels: ["alpha"],
    duedate: "2026-10-01",
    created: "2026-09-14T10:49:18.071+0530",
    updated: "2026-09-15T08:00:00.000+0000",
    ...over,
  },
});

const page = (nodes: unknown[], hasNextPage: boolean, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    issues: {
      ...extra,
      nodes,
      webUrl: "https://example.atlassian.net/issues/?jql=x",
      pageInfo: { hasNextPage, endCursor: hasNextPage ? "cursor-2" : null },
    },
    context: { atlassianAccountId: "acc-1", cloudId: CLOUD },
  });

describe("jira parseSearchResult", () => {
  test("two issues with a next page", () => {
    const r = parseSearchResult(page([node("DEMO-1"), node("DEMO-2")], true));
    expect(r.issues).toHaveLength(2);
    expect(r.nextPageToken).toBe("cursor-2");
    expect(r.total).toBeNull();
    expect(r.issues[0]).toEqual({
      key: "DEMO-1",
      jiraId: "10001",
      projectKey: "DEMO",
      summary: "synthetic summary DEMO-1",
      statusName: "In Progress",
      statusCategory: "indeterminate",
      priority: "High",
      issueType: "Task",
      labels: ["alpha"],
      dueDate: "2026-10-01",
      createdAt: "2026-09-14T05:19:18.071Z",
      updatedAt: "2026-09-15T08:00:00.000Z",
      webUrl: "https://example.atlassian.net/browse/DEMO-1",
    });
  });

  test("last page has a null token; totalCount is read when present", () => {
    const r = parseSearchResult(page([node("DEMO-1")], false, { totalCount: 7 }));
    expect(r.nextPageToken).toBeNull();
    expect(r.total).toBe(7);
  });

  test("webUrl is kept only when it starts with https://", () => {
    const r = parseSearchResult(
      page(
        [
          node("DEMO-1"),
          { ...node("DEMO-2"), webUrl: "javascript:alert(1)" },
          { ...node("DEMO-3"), webUrl: "http://example.atlassian.net/browse/DEMO-3" },
        ],
        false,
      ),
    );
    expect(r.issues.map((i) => i.webUrl)).toEqual([
      "https://example.atlassian.net/browse/DEMO-1",
      null,
      null,
    ]);
  });

  test("null priority and due date stay null", () => {
    const r = parseSearchResult(page([node("DEMO-2", { priority: null, duedate: null })], false));
    expect(r.issues[0]?.priority).toBeNull();
    expect(r.issues[0]?.dueDate).toBeNull();
  });

  test("accepts MCP text-block wrapping", () => {
    const wrapped = JSON.stringify([{ type: "text", text: page([node("DEMO-1")], false) }]);
    expect(parseSearchResult(wrapped).issues).toHaveLength(1);
  });

  test("missing issues.nodes throws JiraParseError", () => {
    expect(() => parseSearchResult(JSON.stringify({ issues: {} }))).toThrow(JiraParseError);
    expect(() => parseSearchResult("not json")).toThrow(JiraParseError);
  });

  test("a node without key throws JiraParseError", () => {
    const bad = node("DEMO-1") as Record<string, unknown>;
    delete bad.key;
    expect(() => parseSearchResult(page([bad], false))).toThrow(JiraParseError);
  });
});

describe("jira parse hardening", () => {
  test("a malformed duedate throws a content-free JiraParseError", () => {
    const bad = node("DEMO-1", { duedate: "01/10/2026" });
    try {
      parseSearchResult(page([bad], false));
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(JiraParseError);
      const m = (e as Error).message;
      expect(m).not.toContain("synthetic summary");
      expect(m).not.toContain("DEMO-1");
    }
  });

  test("a timestamp without an offset or Z is rejected", () => {
    const bad = node("DEMO-1", { created: "2026-09-14T10:49:18.071" });
    expect(() => parseSearchResult(page([bad], false))).toThrow(JiraParseError);
  });
});

describe("jira parseResources", () => {
  test("one site", () => {
    const content = JSON.stringify([
      {
        id: CLOUD,
        url: "https://example.atlassian.net",
        name: "example",
        scopes: ["read:jira-work"],
        avatarUrl: "x",
      },
    ]);
    expect(parseResources(content)).toEqual([
      { id: CLOUD, url: "https://example.atlassian.net", name: "example" },
    ]);
  });
  test("bad shape throws", () => {
    expect(() => parseResources(JSON.stringify({ nope: 1 }))).toThrow(JiraParseError);
  });
});
