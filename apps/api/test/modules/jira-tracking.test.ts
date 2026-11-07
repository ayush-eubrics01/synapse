import { beforeEach, describe, expect, test } from "bun:test";
import type { SourceIssue } from "@synapse/contracts";
import { openDatabase, runMigrations, schema } from "@synapse/database";
import { FakeClock } from "@synapse/shared";
import { eq } from "drizzle-orm";
import { AuditLogger } from "../../src/core/audit/audit";
import { SettingsService } from "../../src/core/config/settings";
import { EventPublisher } from "../../src/core/events/publisher";
import { JobQueue } from "../../src/core/jobs/queue";
import { SyncStateService } from "../../src/modules/inbox/sync-state";
import {
  type AttentionInput,
  attentionOf,
  localDate,
} from "../../src/modules/jira-tracking/attention";
import {
  incrementalJql,
  reconcileJql,
  syncMinutes,
  withExclusions,
} from "../../src/modules/jira-tracking/jql";
import {
  JiraDisabled,
  JiraService,
  JiraUnknownSite,
} from "../../src/modules/jira-tracking/service";
import { JiraStore } from "../../src/modules/jira-tracking/store";

const SCOPE = "assignee = currentUser() AND updated >= -60d";
const CLOUD = "00000000-0000-4000-8000-000000000000";

describe("jql", () => {
  test("incremental JQL with an exclusion", () => {
    expect(incrementalJql(SCOPE, ["SKIP"], 17)).toBe(
      "(assignee = currentUser() AND updated >= -60d) AND project not in (SKIP) AND updated >= -17m ORDER BY updated ASC",
    );
  });

  test("no exclusions means no project clause", () => {
    expect(incrementalJql(SCOPE, [], 17)).toBe(
      "(assignee = currentUser() AND updated >= -60d) AND updated >= -17m ORDER BY updated ASC",
    );
    expect(reconcileJql(SCOPE, [])).toBe(
      "(assignee = currentUser() AND updated >= -60d) ORDER BY updated ASC",
    );
  });

  test("several exclusions; reconcile JQL keeps the guard", () => {
    expect(withExclusions(SCOPE, ["SKIP", "OTHER_1"])).toBe(
      `(${SCOPE}) AND project not in (SKIP, OTHER_1)`,
    );
    expect(reconcileJql(SCOPE, ["SKIP"])).toBe(
      `(${SCOPE}) AND project not in (SKIP) ORDER BY updated ASC`,
    );
  });

  test("an invalid project key is refused before it reaches JQL", () => {
    expect(() => withExclusions(SCOPE, ["skip) OR (x"])).toThrow();
    expect(() => withExclusions(SCOPE, ["A"])).toThrow();
  });

  test("minutes: full window first, then elapsed + 5 overlap, capped at windowDays*1440", () => {
    const now = new Date("2026-11-06T12:00:00.000Z");
    expect(syncMinutes(null, now, 60)).toBe(60 * 1440);
    expect(syncMinutes("2026-11-06T11:48:30.000Z", now, 60)).toBe(12 + 5); // ceil(11.5)=12
    expect(syncMinutes("2026-01-01T00:00:00.000Z", now, 60)).toBe(60 * 1440);
    expect(syncMinutes("2026-11-06T11:59:00.000Z", now, 0.0001)).toBe(1); // cap applies, never < 1
    expect(syncMinutes("2026-11-06T12:30:00.000Z", now, 60)).toBe(5); // checkpoint ahead (skew)
  });
});

describe("attention", () => {
  const now = new Date("2026-11-06T12:00:00.000Z");
  const s = { staleDays: 5, dueSoonDays: 2, blockedStatuses: ["On Hold"], timeZone: "UTC" };
  const base: AttentionInput = {
    inScope: true,
    statusCategory: "indeterminate",
    statusName: "In Progress",
    labels: [],
    dueDate: null,
    updatedAt: "2026-11-06T10:00:00.000Z",
  };
  const a = (over: Partial<AttentionInput>) => attentionOf({ ...base, ...over }, now, s);

  test("overdue wins over everything", () => {
    expect(
      a({
        dueDate: "2026-11-05",
        statusName: "Blocked",
        updatedAt: "2026-10-01T00:00:00.000Z",
      }),
    ).toBe("overdue");
  });

  test("blocked: status name, configured status (case-insensitive), or label", () => {
    expect(a({ statusName: "Blocked by vendor", dueDate: "2026-11-07" })).toBe("blocked");
    expect(a({ statusName: "on hold" })).toBe("blocked");
    expect(a({ labels: ["BLOCKED"] })).toBe("blocked");
    expect(a({ labels: ["blocked-ish"] })).toBeNull();
  });

  test("due_soon before stale; due today is due_soon, not overdue", () => {
    expect(a({ dueDate: "2026-11-08", updatedAt: "2026-10-01T00:00:00.000Z" })).toBe("due_soon");
    expect(a({ dueDate: "2026-11-06" })).toBe("due_soon");
    expect(a({ dueDate: "2026-11-09" })).toBeNull();
  });

  test("stale triggers at exactly stale.days", () => {
    expect(a({ updatedAt: "2026-11-01T12:00:00.000Z" })).toBe("stale");
    expect(a({ updatedAt: "2026-11-01T12:00:00.001Z" })).toBeNull();
  });

  test("done and out-of-scope issues give null", () => {
    expect(a({ statusCategory: "done", dueDate: "2026-01-01" })).toBeNull();
    expect(a({ inScope: false, dueDate: "2026-01-01" })).toBeNull();
  });

  test("today is the local calendar date in the injected time zone", () => {
    const late = new Date("2026-11-06T20:00:00.000Z"); // 01:30 on the 7th in Kolkata
    expect(localDate(late, "UTC")).toBe("2026-11-06");
    expect(localDate(late, "Asia/Kolkata")).toBe("2026-11-07");
    const issue = { ...base, dueDate: "2026-11-06" };
    expect(attentionOf(issue, late, { ...s, timeZone: "UTC" })).toBe("due_soon");
    expect(attentionOf(issue, late, { ...s, timeZone: "Asia/Kolkata" })).toBe("overdue");
  });
});

let db: ReturnType<typeof openDatabase>["db"];
let clock: FakeClock;
let settings: SettingsService;
let store: JiraStore;
let sync: SyncStateService;
let queue: JobQueue;
let service: JiraService;

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
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-11-06T10:00:00.000Z",
  webUrl: `https://example.invalid/browse/DEMO-${n}`,
  ...over,
});
const evts = (type: string) =>
  db
    .select()
    .from(schema.domainEvents)
    .all()
    .filter((e) => e.type === type);
const row = (key: string) =>
  db.select().from(schema.jiraIssues).where(eq(schema.jiraIssues.key, key)).get();
const jobs = (type?: string) =>
  db
    .select()
    .from(schema.jobs)
    .all()
    .filter((j) => !type || j.type === type);

let audit: AuditLogger;

beforeEach(() => {
  db = openDatabase(":memory:").db;
  runMigrations(db);
  clock = new FakeClock("2026-11-06T12:00:00.000Z");
  const events = new EventPublisher(clock);
  settings = new SettingsService(db, clock, events.publish.bind(events));
  sync = new SyncStateService(db, clock);
  queue = new JobQueue(db, clock);
  store = new JiraStore({ db, clock, events, settings, timeZone: "UTC" });
  audit = new AuditLogger(clock);
  service = new JiraService({ db, clock, settings, sync, store, queue, audit });
});

describe("store", () => {
  test("insert publishes issue_updated; an unchanged re-upsert publishes nothing", () => {
    expect(store.upsertPage([issue(1)], { setScope: true })).toMatchObject({
      inserted: 1,
      updated: 0,
      unchanged: 0,
      dropped: 0,
      keys: ["DEMO-1"],
      maxUpdated: "2026-11-06T10:00:00.000Z",
    });
    expect(evts("jira.issue_updated").map((e) => e.payload)).toEqual([{ key: "DEMO-1" }]);
    clock.advance(60_000);
    expect(store.upsertPage([issue(1)], { setScope: true })).toMatchObject({ unchanged: 1 });
    expect(evts("jira.issue_updated")).toHaveLength(1);
    expect(evts("jira.issue_attention")).toHaveLength(0);
    expect(row("DEMO-1")?.lastSeenAt).toBe("2026-11-06T12:01:00.000Z");
  });

  test("a status change publishes jira.issue_updated", () => {
    store.upsertPage([issue(1)], { setScope: true });
    store.upsertPage(
      [issue(1, { statusName: "In Review", updatedAt: "2026-11-06T11:00:00.000Z" })],
      { setScope: true },
    );
    expect(evts("jira.issue_updated")).toHaveLength(2);
    expect(row("DEMO-1")?.statusName).toBe("In Review");
  });

  test("a change to a field that is not tracked updates the row without an event", () => {
    store.upsertPage([issue(1)], { setScope: true });
    const r = store.upsertPage(
      [issue(1, { labels: ["x"], updatedAt: "2026-11-06T11:00:00.000Z" })],
      { setScope: true },
    );
    expect(r.updated).toBe(1);
    expect(evts("jira.issue_updated")).toHaveLength(1);
    expect(row("DEMO-1")?.labels).toEqual(["x"]);
  });

  test("older data never overwrites newer stored data", () => {
    store.upsertPage([issue(1, { updatedAt: "2026-11-06T11:00:00.000Z" })], { setScope: true });
    const r = store.upsertPage(
      [issue(1, { statusName: "Old", updatedAt: "2026-11-06T09:00:00.000Z" })],
      {
        setScope: true,
      },
    );
    expect(r.unchanged).toBe(1);
    expect(row("DEMO-1")?.statusName).toBe("In Progress");
  });

  test("an attention change to non-null publishes jira.issue_attention", () => {
    store.upsertPage([issue(1)], { setScope: true });
    store.upsertPage([issue(1, { statusName: "Blocked", updatedAt: "2026-11-06T11:00:00.000Z" })], {
      setScope: true,
    });
    expect(evts("jira.issue_attention").map((e) => e.payload)).toEqual([
      { key: "DEMO-1", attention: "blocked" },
    ]);
    expect(row("DEMO-1")).toMatchObject({
      attention: "blocked",
      attentionSince: "2026-11-06T12:00:00.000Z",
    });
    // Back to null: stored, no attention event.
    store.upsertPage([issue(1, { updatedAt: "2026-11-06T11:30:00.000Z" })], { setScope: true });
    expect(evts("jira.issue_attention")).toHaveLength(1);
    expect(row("DEMO-1")).toMatchObject({ attention: null, attentionSince: null });
  });

  test("an excluded project is dropped before storage", () => {
    settings.set("jira.excludedProjects", ["SKIP"]);
    const r = store.upsertPage([issue(1), issue(2, { key: "SKIP-2", projectKey: "SKIP" })], {
      setScope: true,
    });
    expect(r).toMatchObject({ inserted: 1, dropped: 1, keys: ["DEMO-1"] });
    expect(row("SKIP-2")).toBeUndefined();
  });

  test("setScope false leaves an existing row's scope flag alone", () => {
    store.upsertPage([issue(1)], { setScope: true });
    db.update(schema.jiraIssues).set({ inScope: false }).run();
    store.upsertPage([issue(1, { updatedAt: "2026-11-06T11:00:00.000Z" })], { setScope: false });
    expect(row("DEMO-1")?.inScope).toBe(false);
  });

  test("a project move (same jira id, new key) renames the row instead of duplicating it", () => {
    store.upsertPage([issue(1)], { setScope: true });
    const before = evts("jira.issue_updated").length;
    const r = store.upsertPage(
      [
        issue(1, {
          key: "OTHER-7",
          projectKey: "OTHER",
          updatedAt: "2026-11-06T11:00:00.000Z",
        }),
      ],
      { setScope: true },
    );
    expect(r).toMatchObject({ inserted: 0, updated: 1, keys: ["OTHER-7"] });
    const rows = db.select().from(schema.jiraIssues).all();
    expect(rows.map((x) => [x.key, x.jiraId, x.projectKey])).toEqual([
      ["OTHER-7", "10001", "OTHER"],
    ]);
    expect(
      evts("jira.issue_updated")
        .slice(before)
        .map((e) => e.payload),
    ).toEqual([{ key: "OTHER-7" }]);
    expect(store.get("DEMO-1")).toBeNull();
    expect(store.get("OTHER-7")?.projectKey).toBe("OTHER");
  });

  test("an older read of a moved issue keeps the stored key", () => {
    store.upsertPage([issue(1, { key: "OTHER-7", projectKey: "OTHER" })], { setScope: true });
    const r = store.upsertPage([issue(1, { updatedAt: "2026-11-06T09:00:00.000Z" })], {
      setScope: true,
    });
    expect(r.keys).toEqual(["OTHER-7"]);
    expect(
      db
        .select()
        .from(schema.jiraIssues)
        .all()
        .map((x) => x.key),
    ).toEqual(["OTHER-7"]);
  });

  test("a missing webUrl is stored without one and read back as null", () => {
    store.upsertPage([issue(1, { webUrl: null })], { setScope: true });
    expect(store.get("DEMO-1")?.webUrl).toBeNull();
    // A stored value that is not https (written before the rule) never reaches the UI.
    db.update(schema.jiraIssues).set({ webUrl: "javascript:alert(1)" }).run();
    expect(store.get("DEMO-1")?.webUrl).toBeNull();
    expect(store.list("all")[0]?.webUrl).toBeNull();
  });

  test("markScope: seen in, unseen out (unless seen since the run started)", () => {
    store.upsertPage([issue(1), issue(2), issue(3)], { setScope: true });
    db.update(schema.jiraIssues)
      .set({ inScope: false })
      .where(eq(schema.jiraIssues.key, "DEMO-1"))
      .run();
    const startedAt = "2026-11-06T12:00:00.000Z";
    clock.advance(60_000);
    store.upsertPage([issue(3)], { setScope: true }); // an incremental sighting after the start
    db.update(schema.jiraIssues)
      .set({ lastSeenAt: "2026-11-06T11:00:00.000Z" })
      .where(eq(schema.jiraIssues.key, "DEMO-2"))
      .run();
    const before = evts("jira.issue_updated").length;
    expect(store.markScope(["DEMO-1"], startedAt)).toEqual({ in: 1, out: 1 });
    expect(row("DEMO-1")?.inScope).toBe(true);
    expect(row("DEMO-2")?.inScope).toBe(false);
    expect(row("DEMO-3")?.inScope).toBe(true);
    expect(evts("jira.issue_updated").length).toBe(before + 2);
  });

  test("refreshAttention picks up time-based changes", () => {
    store.upsertPage([issue(1, { dueDate: "2026-11-07" })], { setScope: true });
    expect(row("DEMO-1")?.attention).toBe("due_soon");
    clock.set("2026-11-08T12:00:00.000Z");
    expect(store.refreshAttention()).toBe(1);
    expect(row("DEMO-1")?.attention).toBe("overdue");
    expect(evts("jira.issue_attention").map((e) => e.payload)).toEqual([
      { key: "DEMO-1", attention: "due_soon" },
      { key: "DEMO-1", attention: "overdue" },
    ]);
  });

  test("list views and get", () => {
    store.upsertPage(
      [
        issue(1, { statusName: "Blocked" }),
        issue(2),
        issue(3, { statusCategory: "done", statusName: "Done" }),
        issue(4, {
          statusCategory: "done",
          statusName: "Done",
          updatedAt: "2026-08-01T00:00:00.000Z",
        }),
        issue(5),
      ],
      { setScope: true },
    );
    db.update(schema.jiraIssues)
      .set({ inScope: false })
      .where(eq(schema.jiraIssues.key, "DEMO-5"))
      .run();
    const keys = (v: "attention" | "open" | "done" | "all") =>
      store
        .list(v)
        .map((i) => i.key)
        .sort();
    expect(keys("attention")).toEqual(["DEMO-1"]);
    expect(keys("open")).toEqual(["DEMO-1", "DEMO-2"]);
    expect(keys("done")).toEqual(["DEMO-3"]);
    expect(keys("all")).toEqual(["DEMO-1", "DEMO-2", "DEMO-3", "DEMO-4"]);
    const v = store.get("DEMO-1");
    expect(v).toMatchObject({ key: "DEMO-1", attention: "blocked", inScope: true });
    expect(v?.slackMentions).toEqual({ count: 0, latest: [] });
    expect(store.get("DEMO-99")).toBeNull();
    expect(store.inScopeCount()).toBe(4);
  });
});

describe("slack mentions", () => {
  const seedMessage = (id: string, text: string | null, sentAt: string) => {
    db.insert(schema.slackMessages)
      .values({
        id,
        conversationId: "conv1",
        ts: `${Date.parse(sentAt) / 1000}.000100`,
        senderUserId: "user1",
        text,
        permalink: `https://example.slack.com/archives/C1/p${id}`,
        sentAt,
        collectedAt: sentAt,
      })
      .run();
  };
  beforeEach(() => {
    db.insert(schema.slackConversations)
      .values({ id: "conv1", externalId: "C1", type: "channel", name: "general" })
      .run();
    db.insert(schema.slackUsers).values({ id: "user1", externalId: "U1", name: "A" }).run();
  });

  test("whole-token, case-sensitive match; no text returned", () => {
    seedMessage("m1", "fixing DEMO-12 now", "2026-11-06T10:00:00.000Z");
    seedMessage("m2", "see DEMO-123", "2026-11-06T10:01:00.000Z");
    seedMessage("m3", "demo-12 lower case", "2026-11-06T10:02:00.000Z");
    seedMessage("m4", "(DEMO-12)", "2026-11-06T10:03:00.000Z");
    seedMessage("m5", "XDEMO-12 and DEMO-12a", "2026-11-06T10:04:00.000Z");
    seedMessage("m6", null, "2026-11-06T10:05:00.000Z");
    const r = store.slackMentions("DEMO-12");
    expect(r.count).toBe(2);
    expect(r.latest).toEqual([
      {
        messageId: "m4",
        conversationLabel: "#general",
        sentAt: "2026-11-06T10:03:00.000Z",
        permalink: "https://example.slack.com/archives/C1/pm4",
      },
      {
        messageId: "m1",
        conversationLabel: "#general",
        sentAt: "2026-11-06T10:00:00.000Z",
        permalink: "https://example.slack.com/archives/C1/pm1",
      },
    ]);
    expect(JSON.stringify(r)).not.toContain("fixing");
  });

  test("an underscore key is matched literally, not as a LIKE wildcard", () => {
    seedMessage("m1", "about A_B-1 today", "2026-11-06T10:00:00.000Z");
    seedMessage("m2", "about AXB-1 today", "2026-11-06T10:01:00.000Z");
    expect(store.slackMentions("A_B-1").latest.map((m) => m.messageId)).toEqual(["m1"]);
  });

  test("counts every match and returns the newest 20", () => {
    for (let i = 0; i < 25; i++) {
      seedMessage(
        `m${i}`,
        `DEMO-12 #${i}`,
        new Date(Date.parse("2026-11-01T00:00:00.000Z") + i * 60_000).toISOString(),
      );
    }
    const r = store.slackMentions("DEMO-12");
    expect(r.count).toBe(25);
    expect(r.latest).toHaveLength(20);
    expect(r.latest[0]?.messageId).toBe("m24");
  });

  test("an unsafe permalink becomes null", () => {
    db.insert(schema.slackMessages)
      .values({
        id: "bad",
        conversationId: "conv1",
        ts: "1.000100",
        senderUserId: "user1",
        text: "DEMO-12",
        permalink: "javascript:alert(1)",
        sentAt: "2026-11-06T10:00:00.000Z",
        collectedAt: "2026-11-06T10:00:00.000Z",
      })
      .run();
    expect(store.slackMentions("DEMO-12").latest[0]?.permalink).toBeNull();
  });
});

describe("service", () => {
  test("status reflects settings, sync state and the in-scope count", () => {
    expect(service.status()).toEqual({
      enabled: false,
      cloudIdSet: false,
      lastSyncAt: null,
      lastReconcileAt: null,
      issueCount: 0,
      lastError: null,
      scopeJql: SCOPE,
      excludedProjects: [],
      sites: [],
    });
    store.upsertPage([issue(1)], { setScope: true });
    db.transaction((tx) => {
      sync.update(tx, "jira.issues", {
        lastSuccessAt: "2026-11-06T11:00:00.000Z",
        lastError: { kind: "parse_failed", message: "jira sync failed" },
      });
      sync.update(tx, "jira.reconcile", { lastSuccessAt: "2026-11-06T10:00:00.000Z" });
    });
    expect(service.status()).toMatchObject({
      lastSyncAt: "2026-11-06T11:00:00.000Z",
      lastReconcileAt: "2026-11-06T10:00:00.000Z",
      issueCount: 1,
      lastError: "parse_failed",
    });
    db.transaction((tx) =>
      sync.update(tx, "jira.issues", {
        lastError: { kind: "needs_attention", message: "multiple_sites" },
      }),
    );
    expect(service.status().lastError).toBe("multiple_sites");
  });

  test("requestSync throws JiraDisabled when disabled and enqueues nothing", () => {
    expect(() => service.requestSync()).toThrow(JiraDisabled);
    expect(jobs()).toHaveLength(0);
  });

  test("requestSync: no cloudId -> resolve; with cloudId -> one sync, deduplicated while live", () => {
    settings.set("jira.enabled", true);
    expect(service.requestSync()).toMatchObject({ type: "jira.resolve_cloud_id", created: true });
    expect(service.requestSync()).toMatchObject({ type: "jira.resolve_cloud_id", created: false });
    expect(jobs("jira.resolve_cloud_id")).toHaveLength(1);
    settings.set("jira.cloudId", CLOUD);
    const a = service.requestSync();
    expect(a).toMatchObject({ type: "jira.sync_incremental", created: true });
    clock.advance(1000);
    expect(service.requestSync()).toMatchObject({ jobId: a.jobId, created: false });
    expect(jobs("jira.sync_incremental")).toHaveLength(1);
  });

  test("enabling with no cloudId enqueues resolve; disabling enqueues nothing", () => {
    service.updateSettings({ enabled: false });
    expect(jobs()).toHaveLength(0);
    service.updateSettings({ enabled: true });
    expect(jobs().map((j) => j.type)).toEqual(["jira.resolve_cloud_id"]);
    expect(settings.get("jira.enabled")).toBe(true);
  });

  test("enabling with a cloudId and no checkpoint enqueues a sync and a reconcile", () => {
    settings.set("jira.cloudId", CLOUD);
    service.updateSettings({ enabled: true });
    expect(jobs().map((j) => j.type)).toEqual(["jira.sync_incremental", "jira.reconcile"]);
  });

  test("enabling with a cloudId and a checkpoint enqueues only a sync", () => {
    settings.set("jira.cloudId", CLOUD);
    db.transaction((tx) =>
      sync.update(tx, "jira.issues", { checkpoint: "2026-11-06T10:00:00.000Z" }),
    );
    service.updateSettings({ enabled: true });
    expect(jobs().map((j) => j.type)).toEqual(["jira.sync_incremental"]);
  });

  test("enabling coalesces with a reconcile that is already waiting", () => {
    settings.set("jira.cloudId", CLOUD);
    queue.enqueue(db, { type: "jira.reconcile", idempotencyKey: "r-waiting" });
    service.updateSettings({ enabled: true });
    expect(jobs("jira.reconcile")).toHaveLength(1);
  });

  test("a forced reconcile cancels waiting fresh reconciles instead of duplicating them", () => {
    settings.set("jira.enabled", true);
    settings.set("jira.cloudId", CLOUD);
    const pending = queue.enqueue(db, { type: "jira.reconcile", idempotencyKey: "r-pending" });
    const retry = queue.enqueue(db, { type: "jira.reconcile", idempotencyKey: "r-retry" });
    db.update(schema.jobs).set({ status: "RETRY" }).where(eq(schema.jobs.id, retry.id)).run();
    const cont = queue.enqueue(db, {
      type: "jira.reconcile",
      input: { generation: "old" },
      idempotencyKey: "r-cont",
    });
    service.updateSettings({ scopeJql: "assignee = currentUser()" });
    service.updateSettings({ scopeJql: "assignee = currentUser() AND updated >= -30d" });
    const status = (id: string) => jobs().find((j) => j.id === id)?.status;
    expect(status(pending.id)).toBe("CANCELLED");
    expect(status(retry.id)).toBe("CANCELLED");
    // A continuation is left to its generation check (superseded when it runs).
    expect(status(cont.id)).toBe("PENDING");
    const live = jobs("jira.reconcile").filter(
      (j) => j.input === null && (j.status === "PENDING" || j.status === "RETRY"),
    );
    expect(live).toHaveLength(1);
  });

  test("a scope edit resets the checkpoint, supersedes chains and enqueues a reconcile", () => {
    settings.set("jira.enabled", true);
    settings.set("jira.cloudId", CLOUD);
    db.transaction((tx) =>
      sync.update(tx, "jira.issues", { checkpoint: "2026-11-06T10:00:00.000Z", generation: "g1" }),
    );
    service.updateSettings({ scopeJql: "assignee = currentUser()" });
    expect(settings.get("jira.scope.jql")).toBe("assignee = currentUser()");
    const s = sync.get("jira.issues");
    expect(s.checkpoint).toBeNull();
    expect(s.generation).not.toBe("g1");
    expect(jobs().map((j) => j.type)).toEqual(["jira.reconcile"]);
  });

  test("excluding a project resets the checkpoint and takes its stored issues out of scope", () => {
    settings.set("jira.enabled", true);
    settings.set("jira.cloudId", CLOUD);
    store.upsertPage(
      [issue(1), issue(2, { key: "SKIP-2", projectKey: "SKIP", statusName: "Blocked" })],
      {
        setScope: true,
      },
    );
    db.transaction((tx) =>
      sync.update(tx, "jira.issues", { checkpoint: "2026-11-06T10:00:00.000Z" }),
    );
    service.updateSettings({ excludedProjects: ["SKIP"] });
    expect(row("SKIP-2")).toMatchObject({ inScope: false, attention: null });
    expect(row("DEMO-1")?.inScope).toBe(true);
    expect(sync.get("jira.issues").checkpoint).toBeNull();
    expect(jobs().map((j) => j.type)).toEqual(["jira.reconcile"]);
  });

  test("an unchanged scope value does not reset anything", () => {
    settings.set("jira.enabled", true);
    settings.set("jira.cloudId", CLOUD);
    db.transaction((tx) =>
      sync.update(tx, "jira.issues", { checkpoint: "2026-11-06T10:00:00.000Z" }),
    );
    service.updateSettings({ scopeJql: SCOPE, excludedProjects: [] });
    expect(sync.get("jira.issues").checkpoint).toBe("2026-11-06T10:00:00.000Z");
    expect(jobs()).toHaveLength(0);
  });

  test("a scope edit while disabled resets the checkpoint but enqueues nothing", () => {
    db.transaction((tx) =>
      sync.update(tx, "jira.issues", { checkpoint: "2026-11-06T10:00:00.000Z" }),
    );
    service.updateSettings({ scopeJql: "assignee = currentUser()" });
    expect(sync.get("jira.issues").checkpoint).toBeNull();
    expect(jobs()).toHaveLength(0);
  });

  test("invalid settings are refused and nothing is written", () => {
    expect(() =>
      service.updateSettings({ enabled: true, excludedProjects: ["bad key"] }),
    ).toThrow();
    expect(() => service.updateSettings({ scopeJql: "a\nb" })).toThrow();
    expect(settings.get("jira.enabled")).toBe(false);
    expect(jobs()).toHaveLength(0);
  });
});

describe("choosing the site", () => {
  const ID1 = "11111111-1111-4111-8111-111111111111";
  const ID2 = "22222222-2222-4222-8222-222222222222";
  const audits = () => db.select().from(schema.auditEvents).all();
  const parked = () => {
    settings.set("jira.enabled", true);
    settings.set("jira.cloudIdCandidates", [
      { id: ID1, name: "Demo site" },
      { id: ID2, name: "Demo site 2" },
    ]);
    db.transaction((tx) =>
      sync.update(tx, "jira.issues", {
        lastError: { kind: "needs_attention", message: "multiple_sites" },
      }),
    );
  };

  test("a candidate is stored, the parked state cleared, jobs queued and one audit row written", () => {
    parked();
    expect(service.status().sites).toHaveLength(2);
    const s = service.updateSettings({ cloudId: ID1 });
    expect(settings.get("jira.cloudId")).toBe(ID1);
    expect(settings.get("jira.cloudIdCandidates")).toEqual([]);
    expect(s.lastError).toBeNull();
    expect(s.sites).toEqual([]);
    expect(jobs().map((j) => j.type)).toEqual(["jira.sync_incremental", "jira.reconcile"]);
    const rows = audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      module: "jira",
      action: "settings.updated",
      details: { keys: ["jira.cloudId"] },
    });
    expect(JSON.stringify(rows)).not.toContain("Demo site");
  });

  test("an id outside the stored candidates is refused and nothing is written", () => {
    parked();
    expect(() =>
      service.updateSettings({ cloudId: "0f0f0f0f-0000-0000-0000-00000000dead" }),
    ).toThrow(JiraUnknownSite);
    expect(settings.get("jira.cloudId")).toBeNull();
    expect(settings.get("jira.cloudIdCandidates")).toHaveLength(2);
    expect(service.status().lastError).toBe("multiple_sites");
    expect(jobs()).toHaveLength(0);
    expect(audits()).toHaveLength(0);
  });

  test("with no stored candidates any well-formed id is accepted", () => {
    settings.set("jira.enabled", true);
    service.updateSettings({ cloudId: ID1 });
    expect(settings.get("jira.cloudId")).toBe(ID1);
  });

  test("changing a set cloudId resets the checkpoint and queues a fresh reconcile", () => {
    settings.set("jira.enabled", true);
    settings.set("jira.cloudId", ID1);
    db.transaction((tx) =>
      sync.update(tx, "jira.issues", { checkpoint: "2026-11-06T10:00:00.000Z" }),
    );
    service.updateSettings({ cloudId: ID2 });
    expect(settings.get("jira.cloudId")).toBe(ID2);
    expect(sync.get("jira.issues").checkpoint).toBeNull();
    expect(jobs("jira.reconcile")).toHaveLength(1);
  });

  test("the same id is a no-op", () => {
    settings.set("jira.enabled", true);
    settings.set("jira.cloudId", ID1);
    service.updateSettings({ cloudId: ID1 });
    expect(audits()).toHaveLength(0);
    expect(jobs()).toHaveLength(0);
  });
});
