import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  AIProvider,
  DashboardOverview,
  JiraIssueView,
  JiraStatusDto,
  SourceIssue,
} from "@synapse/contracts";
import { createApp } from "../../src/app";
import { type Container, createContainer } from "../../src/container";
import { loadConfig } from "../../src/core/config/config";
import { JiraStore } from "../../src/modules/jira-tracking/store";

const fakeProvider: AIProvider = {
  execute: async () => {
    throw new Error("fake provider must not execute");
  },
  getHealth: async () => ({ status: "ok", version: "fake" }),
};
const NOW = "2026-11-06T12:00:00.000Z";

let c: Container;
let app: ReturnType<typeof createApp>;
let store: JiraStore;

beforeEach(() => {
  c = createContainer(loadConfig({ SYNAPSE_DB_PATH: ":memory:" }), {
    run: async () => "Linger=no",
    provider: fakeProvider,
    clock: { now: () => new Date(NOW) },
  });
  app = createApp(c);
  store = new JiraStore({
    db: c.db,
    clock: c.clock,
    events: c.events,
    settings: c.settings,
    timeZone: "UTC",
  });
});
afterEach(() => c.sqlite.close());

const call = (path: string, init?: RequestInit) =>
  app.request(`http://127.0.0.1:7400${path}`, init);
const put = (body: unknown) =>
  call("/api/jira/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const issue = (n: number, over: Partial<SourceIssue> = {}): SourceIssue => ({
  key: `DEMO-${n}`,
  jiraId: `${10000 + n}`,
  projectKey: "DEMO",
  summary: `Synthetic issue ${n}`,
  statusName: "In Progress",
  statusCategory: "indeterminate",
  priority: "Medium",
  issueType: "Task",
  labels: [],
  dueDate: null,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-06T10:00:00.000Z",
  webUrl: `https://example.invalid/browse/DEMO-${n}`,
  ...over,
});
const keys = async (view: string) =>
  ((await (await call(`/api/jira/issues?view=${view}`)).json()) as JiraIssueView[])
    .map((i) => i.key)
    .sort();

function seed(): void {
  store.upsertPage(
    [
      issue(1, { dueDate: "2026-11-01" }), // overdue -> attention
      issue(2), // open, no attention
      issue(3, { statusName: "Done", statusCategory: "done" }), // done recently
      issue(4, {
        statusName: "Done",
        statusCategory: "done",
        updatedAt: "2026-06-01T00:00:00.000Z", // done, outside the window
      }),
    ],
    { setScope: true },
  );
}

describe("jira routes", () => {
  test("GET status has the documented shape", async () => {
    const r = await call("/api/jira/status");
    expect(r.status).toBe(200);
    expect((await r.json()) as JiraStatusDto).toEqual({
      enabled: false,
      cloudIdSet: false,
      lastSyncAt: null,
      lastReconcileAt: null,
      issueCount: 0,
      lastError: null,
    });
  });

  test("list views filter as specified", async () => {
    seed();
    expect(await keys("attention")).toEqual(["DEMO-1"]);
    expect(await keys("open")).toEqual(["DEMO-1", "DEMO-2"]);
    expect(await keys("done")).toEqual(["DEMO-3"]);
    expect(await keys("all")).toEqual(["DEMO-1", "DEMO-2", "DEMO-3", "DEMO-4"]);
  });

  test("an unknown view is 400; a missing view means all", async () => {
    seed();
    expect((await call("/api/jira/issues?view=bogus")).status).toBe(400);
    const r = (await (await call("/api/jira/issues")).json()) as JiraIssueView[];
    expect(r).toHaveLength(4);
  });

  test("GET issue by key; unknown is 404", async () => {
    seed();
    const r = await call("/api/jira/issues/DEMO-2");
    expect(r.status).toBe(200);
    expect(((await r.json()) as JiraIssueView).key).toBe("DEMO-2");
    expect((await call("/api/jira/issues/DEMO-99")).status).toBe(404);
  });

  test("POST sync is 409 while disabled, and queues once enabled", async () => {
    expect((await call("/api/jira/sync", { method: "POST" })).status).toBe(409);
    expect((await put({ enabled: true })).status).toBe(200);
    const r = await call("/api/jira/sync", { method: "POST" });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { jobId: string }).jobId).toBeTruthy();
  });

  test("PUT settings validates", async () => {
    expect((await put({ excludedProjects: ["lower"] })).status).toBe(400);
    expect((await put({ scopeJql: "a = b\nOR c = d" })).status).toBe(400);
    expect((await put({ scopeJql: "x".repeat(501) })).status).toBe(400);
    expect((await put({ scopeJql: "" })).status).toBe(400);
    expect((await put({ unknownKey: 1 })).status).toBe(400);
  });

  test("PUT settings rejects a scope with ORDER BY in any case or spacing", async () => {
    for (const jql of [
      "assignee = currentUser() ORDER BY created",
      "assignee = currentUser() order by created",
      "assignee = currentUser() Order   By created",
      "assignee = currentUser() order\tby created",
    ]) {
      expect((await put({ scopeJql: jql })).status).toBe(400);
    }
    expect(c.settings.get("jira.scope.jql")).toBe("assignee = currentUser() AND updated >= -60d");
  });

  test("PUT settings rejects unbalanced parentheses and unterminated quotes", async () => {
    for (const jql of [
      "assignee = currentUser()) OR (project = OTHER",
      "(assignee = currentUser()",
      "assignee = currentUser())",
      ") OR (",
      'summary ~ "open',
    ]) {
      expect((await put({ scopeJql: jql })).status).toBe(400);
    }
    expect(c.settings.get("jira.scope.jql")).toBe("assignee = currentUser() AND updated >= -60d");
  });

  test("parentheses inside double-quoted strings are ignored", async () => {
    for (const jql of [
      'summary ~ "a (b" AND assignee = currentUser()',
      'summary ~ "x) OR (y"',
      'summary ~ "say \\"(\\" twice" AND (status = Open)',
    ]) {
      const r = await put({ scopeJql: jql });
      expect(r.status).toBe(200);
      expect(c.settings.get("jira.scope.jql")).toBe(jql);
    }
  });

  test("the settings schema itself rejects unbalanced parentheses", () => {
    expect(() => c.settings.set("jira.scope.jql", "a = b) OR (c = d")).toThrow();
    expect(() => c.settings.set("jira.scope.jql", "a in (b")).toThrow();
    c.settings.set("jira.scope.jql", "project in (A, B) AND (status = Open OR status = Done)");
  });

  test("the settings schema itself rejects ORDER BY", () => {
    expect(() => c.settings.set("jira.scope.jql", "project = DEMO order by key")).toThrow();
    // A field merely named like it is fine.
    c.settings.set("jira.scope.jql", "labels = border");
    expect(c.settings.get("jira.scope.jql")).toBe("labels = border");
  });

  test("PUT settings applies and returns the status", async () => {
    const r = await put({
      enabled: true,
      scopeJql: "project = DEMO AND updated >= -30d",
      excludedProjects: ["SKIP"],
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as JiraStatusDto).enabled).toBe(true);
    expect(c.settings.get("jira.scope.jql")).toBe("project = DEMO AND updated >= -30d");
    expect(c.settings.get("jira.excludedProjects")).toEqual(["SKIP"]);
  });
});

describe("overview", () => {
  test("counts.jiraAttention counts in-scope issues with attention", async () => {
    seed();
    const o = (await (await call("/api/dashboard/overview")).json()) as DashboardOverview;
    expect(o.counts.jiraAttention).toBe(1);
  });

  test("is 0 with no issues", async () => {
    const o = (await (await call("/api/dashboard/overview")).json()) as DashboardOverview;
    expect(o.counts.jiraAttention).toBe(0);
  });
});
