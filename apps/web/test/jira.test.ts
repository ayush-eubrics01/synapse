import { expect, test } from "bun:test";
import {
  ApiError,
  getJiraIssue,
  getJiraIssues,
  getJiraStatus,
  requestJiraSync,
  updateJiraSettings,
} from "../lib/api";
import {
  attentionLabel,
  dueLabel,
  groupIssues,
  jiraPaletteItems,
  validateJiraSetup,
} from "../lib/jira";
import { sidebarItems } from "../lib/nav";
import { buildNeedsYou, type NeedsYouInput, needsYouCount } from "../lib/needs-you";
import { createNeedsYouActions } from "../lib/needs-you-actions";
import { issue } from "./jira-fixtures";

const NOW = new Date(2026, 10, 6, 12, 0, 0); // Fri 6 Nov 2026, local

test("groupIssues: attention first, then in progress, to do, done; done never needs attention", () => {
  const g = groupIssues([
    issue({ key: "DEMO-1" }),
    issue({ key: "DEMO-2", statusCategory: "indeterminate" }),
    issue({ key: "DEMO-3", attention: "overdue" }),
    issue({ key: "DEMO-4", statusCategory: "done", attention: "stale" }),
    issue({ key: "DEMO-5", statusCategory: "indeterminate", attention: "blocked" }),
    issue({ key: "DEMO-6", inScope: false }),
  ]);
  expect(g.map((x) => x.id)).toEqual(["attention", "progress", "todo", "done"]);
  expect(g.map((x) => x.label)).toEqual([
    "Needs attention",
    "In progress",
    "To do",
    "Done recently",
  ]);
  expect(g.map((x) => x.issues.map((i) => i.key))).toEqual([
    ["DEMO-3", "DEMO-5"],
    ["DEMO-2"],
    ["DEMO-1"],
    ["DEMO-4"],
  ]);
});

test("attentionLabel names each rule", () => {
  expect(attentionLabel(issue({ attention: "overdue" }), NOW)).toBe("Overdue");
  expect(attentionLabel(issue({ attention: "blocked" }), NOW)).toBe("Blocked");
  expect(attentionLabel(issue({ attention: "due_soon" }), NOW)).toBe("Due soon");
  const stale = issue({ attention: "stale", updatedAt: new Date(2026, 10, 1, 9).toISOString() });
  expect(attentionLabel(stale, NOW)).toBe("No update in 5 days");
  expect(attentionLabel(stale, null)).toBe("Stale");
  expect(attentionLabel(issue(), NOW)).toBeNull();
});

test("dueLabel: a date, or overdue by N days in red; done issues are never overdue", () => {
  expect(dueLabel(issue({ dueDate: "2026-11-07" }), NOW)).toEqual({
    text: "Due Sat 7 Nov",
    overdue: false,
  });
  expect(dueLabel(issue({ dueDate: "2026-11-04" }), NOW)).toEqual({
    text: "Overdue by 2 days",
    overdue: true,
  });
  expect(dueLabel(issue({ dueDate: "2026-11-05" }), NOW)?.text).toBe("Overdue by 1 day");
  expect(dueLabel(issue({ dueDate: "2026-11-06" }), NOW)?.overdue).toBe(false);
  expect(dueLabel(issue({ dueDate: "2026-11-04", statusCategory: "done" }), NOW)?.overdue).toBe(
    false,
  );
  expect(dueLabel(issue({ dueDate: "2026-11-04" }), null)).toEqual({
    text: "Due Wed 4 Nov",
    overdue: false,
  });
  expect(dueLabel(issue(), NOW)).toBeNull();
});

test("validateJiraSetup mirrors the server rules", () => {
  const ok = validateJiraSetup("assignee = currentUser()", "DEMO, OPS_1");
  expect(ok).toEqual({
    ok: true,
    scopeJql: "assignee = currentUser()",
    excludedProjects: ["DEMO", "OPS_1"],
  });
  expect(validateJiraSetup("x", "")).toMatchObject({ ok: true, excludedProjects: [] });
  const bad = validateJiraSetup("x", "DEMO, demo, A");
  expect(bad.ok).toBe(false);
  if (!bad.ok) expect(bad.excludedError).toContain("demo");
  const orderBy = validateJiraSetup("assignee = currentUser() order  by created", "");
  expect(orderBy.ok).toBe(false);
  if (!orderBy.ok) expect(orderBy.scopeError).toContain("ORDER BY");
  expect(validateJiraSetup("   ", "").ok).toBe(false);
  expect(validateJiraSetup("a\nb", "").ok).toBe(false);
  expect(validateJiraSetup("a".repeat(501), "").ok).toBe(false);
});

test("jiraPaletteItems: Sync Jira now and one entry per open issue", () => {
  const ran: string[] = [];
  const items = jiraPaletteItems(
    [
      issue(),
      issue({ key: "DEMO-2", statusCategory: "done" }),
      issue({ key: "DEMO-3", inScope: false }),
    ],
    true,
    { sync: () => ran.push("sync"), open: (k) => ran.push(`open ${k}`) },
  );
  expect(items.map((i) => i.label)).toEqual(["Sync Jira now", "DEMO-1 · Fix the demo"]);
  items[0]?.run();
  items[1]?.run();
  expect(ran).toEqual(["sync", "open DEMO-1"]);
  expect(jiraPaletteItems([issue()], false, { sync: () => {}, open: () => {} })).toEqual([]);
});

const baseInput = (o: Partial<NeedsYouInput> = {}): NeedsYouInput => ({
  urgent: [],
  approvals: [],
  flags: [],
  followups: [],
  reviewQueue: [],
  recommendations: [],
  identity: null,
  people: [],
  candidates: null,
  slackStatus: null,
  hidden: new Set(),
  ...o,
});
const status = (o = {}) => ({
  enabled: true,
  cloudIdSet: true,
  lastSyncAt: null,
  lastReconcileAt: null,
  issueCount: 0,
  lastError: null,
  ...o,
});

test("Needs you: disabled Jira shows the setup card; enabled shows one attention card", () => {
  const off = buildNeedsYou(baseInput({ jiraStatus: status({ enabled: false }) }));
  expect(off.map((c) => c.kind)).toEqual(["setup-jira"]);
  expect(buildNeedsYou(baseInput({ jiraStatus: null })).length).toBe(0);
  const on = buildNeedsYou(
    baseInput({
      jiraStatus: status(),
      jiraIssues: [
        issue({ attention: "overdue" }),
        issue({ key: "DEMO-2", attention: "stale" }),
        issue({ key: "DEMO-3" }),
      ],
    }),
  );
  expect(on.map((c) => c.kind)).toEqual(["jira-attention"]);
  const card = on[0];
  expect(card?.kind === "jira-attention" && card.data.issues.map((i) => i.key)).toEqual([
    "DEMO-1",
    "DEMO-2",
  ]);
  expect(needsYouCount(on)).toBe(1);
});

test("jira-attention ranks after commitments and before profile recommendations; setup with setup", () => {
  const cards = buildNeedsYou(
    baseInput({
      jiraStatus: status({ enabled: true }),
      jiraIssues: [issue({ attention: "blocked" })],
      reviewQueue: [{ id: "c1", actions: ["accept"] } as never],
      recommendations: [{ id: "r1", approvalId: null } as never],
      identity: { selfUserId: null, suggestion: null, suggestionName: null } as never,
    }),
  );
  expect(cards.map((c) => c.kind)).toEqual([
    "commitment",
    "jira-attention",
    "recommendation",
    "setup-identity",
  ]);
  const setup = buildNeedsYou(
    baseInput({
      jiraStatus: status({ enabled: false }),
      identity: { selfUserId: null, suggestion: null, suggestionName: null } as never,
    }),
  );
  expect(setup.map((c) => c.kind)).toEqual(["setup-identity", "setup-jira"]);
});

test("nav: a Jira item sits between Commitments and People; its badge is jiraAttention, hidden at 0", () => {
  const counts = { jiraAttention: 3 } as never;
  const items = sidebarItems(counts, 0);
  expect(items.map((i) => i.id)).toEqual([
    "overview",
    "triage",
    "inbox",
    "commitments",
    "jira",
    "people",
    "system",
  ]);
  expect(items.find((i) => i.id === "jira")).toMatchObject({ label: "Jira", count: 3 });
  expect(sidebarItems({ jiraAttention: 0 } as never, 0).find((i) => i.id === "jira")?.count).toBe(
    0,
  );
});

function fakeFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

test("api: jira calls hit the right routes", async () => {
  const a = fakeFetch({});
  await getJiraStatus(a.f);
  await getJiraIssues("attention", a.f);
  await getJiraIssue("DEMO-1", a.f);
  await requestJiraSync(a.f);
  await updateJiraSettings({ enabled: true, scopeJql: "x", excludedProjects: ["DEMO"] }, a.f);
  expect(a.calls.map((c) => `${c.init?.method ?? "GET"} ${c.url}`)).toEqual([
    "GET /api/jira/status",
    "GET /api/jira/issues?view=attention",
    "GET /api/jira/issues/DEMO-1",
    "POST /api/jira/sync",
    "PUT /api/jira/settings",
  ]);
  expect(JSON.parse(String(a.calls[4]?.init?.body))).toEqual({
    enabled: true,
    scopeJql: "x",
    excludedProjects: ["DEMO"],
  });
});

test("api: a 409 on sync throws an ApiError with the server's reason", async () => {
  const a = fakeFetch({ error: "jira is disabled" }, 409);
  const err = await requestJiraSync(a.f).catch((e) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect(err.message).toContain("jira is disabled");
});

test("actions: sync and enable are immediate API calls; a 400 surfaces as the action error", async () => {
  const calls: string[] = [];
  const errors: Array<string | null> = [];
  const mk = (fail?: Error) =>
    createNeedsYouActions({
      api: new Proxy({} as never, {
        get:
          (_t, name: string) =>
          (...args: unknown[]) => {
            calls.push(`${name}(${args.map((x) => JSON.stringify(x)).join(",")})`);
            return fail ? Promise.reject(fail) : Promise.resolve({});
          },
      }),
      deferred: { schedule() {}, undo: () => false, cancel() {} } as never,
      toast: { show() {} },
      refresh: async () => null,
      setActionError: (e) => errors.push(e),
      setDeferredError: () => {},
      committing: { add() {}, delete() {} },
      toggleHistory: () => {},
      seeAllPeople: () => {},
      seeAllJira: () => calls.push("seeAllJira"),
    });
  const h = mk();
  h.syncJira();
  h.enableJira({ scopeJql: "x", excludedProjects: ["DEMO"] });
  h.seeAllJira();
  await new Promise((r) => setTimeout(r, 0));
  expect(calls).toEqual([
    "requestJiraSync()",
    'updateJiraSettings({"enabled":true,"scopeJql":"x","excludedProjects":["DEMO"]})',
    "seeAllJira",
  ]);
  errors.length = 0;
  mk(new Error("PUT /api/jira/settings failed with 400")).enableJira({
    scopeJql: "x",
    excludedProjects: [],
  });
  await new Promise((r) => setTimeout(r, 0));
  expect(errors).toContain("PUT /api/jira/settings failed with 400");
});
