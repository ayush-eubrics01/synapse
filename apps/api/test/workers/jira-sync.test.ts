import { beforeEach, describe, expect, test } from "bun:test";
import {
  type JiraIssueSource,
  type Job,
  JobError,
  retryDecision,
  type SourceIssue,
} from "@synapse/contracts";
import { openDatabase, runMigrations, schema } from "@synapse/database";
import { FakeClock } from "@synapse/shared";
import { eq } from "drizzle-orm";
import { AuditLogger } from "../../src/core/audit/audit";
import { SettingsService } from "../../src/core/config/settings";
import { EventPublisher } from "../../src/core/events/publisher";
import { JobQueue } from "../../src/core/jobs/queue";
import type { HandlerRegistration } from "../../src/core/jobs/worker";
import { SchedulerService } from "../../src/core/scheduler/scheduler";
import { SyncStateService } from "../../src/modules/inbox/sync-state";
import { JiraService } from "../../src/modules/jira-tracking/service";
import { JiraStore } from "../../src/modules/jira-tracking/store";
import { registerJiraJobs } from "../../src/workers/jira";

const CLOUD = "00000000-0000-4000-8000-000000000000";
const SCOPE = "assignee = currentUser() AND updated >= -60d";

type Page = { issues: SourceIssue[]; nextPageToken: string | null; total: number | null };
type SearchArgs = Parameters<JiraIssueSource["searchPage"]>[0];

let db: ReturnType<typeof openDatabase>["db"];
let clock: FakeClock;
let settings: SettingsService;
let sync: SyncStateService;
let store: JiraStore;
let queue: JobQueue;
let audit: AuditLogger;
let handlers: Map<string, HandlerRegistration>;
let searches: SearchArgs[];
let resolves: number;
let pages: (() => Promise<Page>)[];
let sites: (() => Promise<{ id: string; url: string; name: string }[]>)[];

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
  updatedAt: `2026-11-06T10:0${n % 10}:00.000Z`,
  webUrl: `https://example.invalid/browse/DEMO-${n}`,
  ...over,
});
const page =
  (issues: SourceIssue[], next: string | null = null): (() => Promise<Page>) =>
  async () => ({ issues, nextPageToken: next, total: null });
const boom = (e: JobError) => async (): Promise<Page> => {
  throw e;
};
const ctx = {
  signal: new AbortController().signal,
  checkpoint() {},
  getCheckpoint: () => undefined,
};
const run = (type: string, input: unknown = null, id = `job-${Math.random()}`) => {
  const h = handlers.get(type);
  if (!h) throw new Error(`no handler ${type}`);
  return h.handler(
    { id, type, input, attempts: 1, maxAttempts: 3 } as unknown as Job,
    ctx as never,
  );
};
const jobs = (type?: string) =>
  db
    .select()
    .from(schema.jobs)
    .all()
    .filter((j) => !type || j.type === type);
/** Runs the newest pending job of `type` the way the worker would. */
const runPending = async (type: string) => {
  const j = jobs(type).find((x) => x.status === "PENDING");
  if (!j) throw new Error(`no pending ${type}`);
  db.update(schema.jobs).set({ status: "RUNNING" }).where(eq(schema.jobs.id, j.id)).run();
  const out = await run(type, j.input, j.id);
  db.update(schema.jobs).set({ status: "COMPLETED" }).where(eq(schema.jobs.id, j.id)).run();
  return out;
};
const evts = (type: string) =>
  db
    .select()
    .from(schema.domainEvents)
    .all()
    .filter((e) => e.type === type);
const row = (key: string) =>
  db.select().from(schema.jiraIssues).where(eq(schema.jiraIssues.key, key)).get();

beforeEach(() => {
  db = openDatabase(":memory:").db;
  runMigrations(db);
  clock = new FakeClock("2026-11-06T12:00:00.000Z");
  const events = new EventPublisher(clock);
  settings = new SettingsService(db, clock, events.publish.bind(events));
  sync = new SyncStateService(db, clock);
  queue = new JobQueue(db, clock);
  audit = new AuditLogger(clock);
  store = new JiraStore({ db, clock, events, settings, timeZone: "UTC" });
  handlers = new Map();
  searches = [];
  resolves = 0;
  pages = [];
  sites = [];
  const source: JiraIssueSource = {
    resolveCloudId: async () => {
      resolves++;
      const n = sites.shift();
      if (!n) throw new Error("no scripted resolve");
      return n();
    },
    searchPage: async (args) => {
      searches.push(args);
      const n = pages.shift();
      if (!n) throw new Error("no scripted page");
      return n();
    },
  };
  registerJiraJobs({
    db,
    clock,
    settings,
    sync,
    store,
    queue,
    events,
    scheduler: new SchedulerService(db, clock, queue),
    handlers,
    source,
  });
  settings.set("jira.enabled", true);
  settings.set("jira.cloudId", CLOUD);
});

test("registration: handlers and coalesced schedules from settings", () => {
  for (const t of ["jira.resolve_cloud_id", "jira.sync_incremental", "jira.reconcile"]) {
    expect(handlers.get(t)?.timeoutMs).toBeGreaterThan(0);
  }
  const tasks = db.select().from(schema.scheduledTasks).all();
  expect(tasks.find((t) => t.name === "jira.sync_incremental")?.intervalSeconds).toBe(30 * 60);
  expect(tasks.find((t) => t.name === "jira.reconcile")?.intervalSeconds).toBe(24 * 3600);
  expect(tasks.find((t) => t.jobType === "jira.resolve_cloud_id")).toBeUndefined();
  const refresh = tasks.find((t) => t.name === "jira.refresh_attention");
  expect(refresh).toMatchObject({ jobType: "jira.refresh_attention", intervalSeconds: 3600 });
  expect(handlers.get("jira.refresh_attention")?.timeoutMs).toBeGreaterThan(0);
});

describe("refresh attention", () => {
  test("recomputes time-driven attention and publishes it, without Claude", async () => {
    store.upsertPage([issue(1, { updatedAt: "2026-11-06T11:00:00.000Z" })], { setScope: true });
    expect(row("DEMO-1")?.attention).toBeNull();
    clock.advance(6 * 86_400_000);
    expect(await run("jira.refresh_attention")).toEqual({ changed: 1 });
    expect(row("DEMO-1")?.attention).toBe("stale");
    expect(evts("jira.issue_attention").map((e) => e.payload)).toEqual([
      { key: "DEMO-1", attention: "stale" },
    ]);
    expect(await run("jira.refresh_attention")).toEqual({ changed: 0 });
    expect(evts("jira.issue_attention")).toHaveLength(1);
    expect(searches).toHaveLength(0);
    expect(resolves).toBe(0);
  });

  test("does nothing while disabled", async () => {
    store.upsertPage([issue(1, { updatedAt: "2026-11-06T11:00:00.000Z" })], { setScope: true });
    settings.set("jira.enabled", false);
    clock.advance(6 * 86_400_000);
    expect(await run("jira.refresh_attention")).toEqual({ skipped: "disabled" });
    expect(row("DEMO-1")?.attention).toBeNull();
  });
});

describe("disabled or unconfigured", () => {
  test("disabled: no handler calls the source", async () => {
    settings.set("jira.enabled", false);
    await run("jira.sync_incremental");
    await run("jira.reconcile");
    await run("jira.resolve_cloud_id");
    expect(searches).toHaveLength(0);
    expect(resolves).toBe(0);
    expect(jobs()).toHaveLength(0);
  });

  test("no cloudId: sync and reconcile skip and enqueue nothing", async () => {
    settings.clear("jira.cloudId");
    expect(await run("jira.sync_incremental")).toEqual({ skipped: "no_cloud_id" });
    expect(await run("jira.reconcile")).toEqual({ skipped: "no_cloud_id" });
    expect(searches).toHaveLength(0);
    expect(jobs()).toHaveLength(0);
  });
});

describe("sync", () => {
  test("first run uses the full window and commits the checkpoint", async () => {
    settings.set("jira.excludedProjects", ["SKIP"]);
    pages.push(page([issue(1), issue(2)]));
    const out = await run("jira.sync_incremental");
    expect(searches).toEqual([
      {
        cloudId: CLOUD,
        jql: `(${SCOPE}) AND project not in (SKIP) AND updated >= -86400m ORDER BY updated ASC`,
        maxResults: 20,
      },
    ]);
    expect(out).toMatchObject({ pages: 1, complete: true });
    const s = sync.get("jira.issues");
    expect(s.checkpoint).toBe("2026-11-06T10:02:00.000Z");
    expect(s.lastSuccessAt).toBe("2026-11-06T12:00:00.000Z");
    expect(s.lastError).toBeNull();
    expect(row("DEMO-1")?.inScope).toBe(true);
    expect(evts("collection.completed").map((e) => e.payload)).toEqual([
      { stream: "jira.issues", pages: 1, inserted: 2, duplicates: 0, rejected: 0 },
    ]);
  });

  test("a later run uses elapsed minutes + 5 from the checkpoint", async () => {
    db.transaction((tx) =>
      sync.update(tx, "jira.issues", { checkpoint: "2026-11-06T11:40:00.000Z" }),
    );
    pages.push(page([]));
    await run("jira.sync_incremental");
    expect(searches[0]?.jql).toBe(`(${SCOPE}) AND updated >= -25m ORDER BY updated ASC`);
    // No issues seen: the checkpoint stays where it was.
    expect(sync.get("jira.issues").checkpoint).toBe("2026-11-06T11:40:00.000Z");
  });

  test("three pages with maxPagesPerRun 2: continuation with the token; checkpoint only at the end", async () => {
    settings.set("jira.maxPagesPerRun", 2);
    pages.push(page([issue(1)], "tok-1"), page([issue(2)], "tok-2"), page([issue(3)]));
    const first = await run("jira.sync_incremental");
    expect(first).toMatchObject({ pages: 2, complete: false });
    expect(searches.map((s) => s.nextPageToken)).toEqual([undefined, "tok-1"]);
    // Issues are stored as pages arrive; the checkpoint is not.
    expect(row("DEMO-2")).toBeDefined();
    expect(sync.get("jira.issues").checkpoint).toBeNull();
    expect(sync.get("jira.issues").lastSuccessAt).toBeNull();
    const cont = jobs("jira.sync_incremental");
    expect(cont).toHaveLength(1);
    expect(cont[0]?.input).toMatchObject({ nextPageToken: "tok-2", pagesSoFar: 2 });

    await runPending("jira.sync_incremental");
    expect(searches).toHaveLength(3);
    expect(searches[2]).toEqual({ ...(searches[0] as SearchArgs), nextPageToken: "tok-2" });
    expect(sync.get("jira.issues").checkpoint).toBe("2026-11-06T10:03:00.000Z");
    expect(sync.get("jira.issues").lastSuccessAt).toBe("2026-11-06T12:00:00.000Z");
    expect(jobs("jira.sync_incremental").filter((j) => j.status === "PENDING")).toHaveLength(0);
  });

  test("a first-page failure leaves the checkpoint unchanged, records lastError (kind only) and status error", async () => {
    db.transaction((tx) =>
      sync.update(tx, "jira.issues", { checkpoint: "2026-11-06T11:40:00.000Z" }),
    );
    pages.push(
      boom(new JobError({ kind: "incomplete_ai_output", message: "summary text DEMO secret" })),
    );
    await expect(run("jira.sync_incremental")).rejects.toBeInstanceOf(JobError);
    const s = sync.get("jira.issues");
    expect(s.checkpoint).toBe("2026-11-06T11:40:00.000Z");
    expect(s.status).toBe("error");
    expect(s.lastError?.kind).toBe("incomplete_ai_output");
    expect(JSON.stringify(s.lastError)).not.toContain("secret");
    expect(evts("collection.failed").map((e) => e.payload)).toEqual([
      { stream: "jira.issues", kind: "incomplete_ai_output" },
    ]);
    expect(jobs()).toHaveLength(0);
  });

  test("a failure after a completed page resumes from the last good token; success clears the error", async () => {
    db.transaction((tx) =>
      sync.update(tx, "jira.issues", { checkpoint: "2026-11-06T11:40:00.000Z" }),
    );
    pages.push(
      page([issue(1, { updatedAt: "2026-11-06T11:59:00.000Z" })], "tok-1"),
      boom(new JobError({ kind: "incomplete_ai_output", message: "summary text DEMO secret" })),
    );
    const out = await run("jira.sync_incremental");
    expect(out).toMatchObject({ pages: 1, resumed: true, kind: "incomplete_ai_output" });
    const s = sync.get("jira.issues");
    // The failure is recorded; the checkpoint is not committed.
    expect(s.checkpoint).toBe("2026-11-06T11:40:00.000Z");
    expect(s.status).toBe("error");
    expect(s.lastError?.kind).toBe("incomplete_ai_output");
    expect(evts("collection.failed")).toHaveLength(1);
    const cont = jobs("jira.sync_incremental");
    expect(cont).toHaveLength(1);
    expect(cont[0]?.input).toMatchObject({
      generation: s.generation,
      nextPageToken: "tok-1",
      pagesSoFar: 1,
      maxUpdated: "2026-11-06T11:59:00.000Z",
    });

    pages.push(page([issue(2, { updatedAt: "2026-11-06T11:58:00.000Z" })]));
    expect(await runPending("jira.sync_incremental")).toMatchObject({ complete: true });
    expect(searches[2]?.nextPageToken).toBe("tok-1");
    const after = sync.get("jira.issues");
    expect(after.checkpoint).toBe("2026-11-06T11:59:00.000Z");
    expect(after.status).toBe("idle");
    expect(after.lastError).toBeNull();
  });

  test("an abandoned (aborted) run never resumes: the worker already settled the job", async () => {
    const ac = new AbortController();
    pages.push(page([issue(1)], "tok-1"), async () => {
      ac.abort();
      throw new JobError({ kind: "timeout", message: "aborted" });
    });
    const h = handlers.get("jira.sync_incremental");
    if (!h) throw new Error("no handler");
    await h
      .handler(
        {
          id: "job-abort",
          type: "jira.sync_incremental",
          input: null,
          attempts: 1,
          maxAttempts: 3,
        } as unknown as Job,
        { ...ctx, signal: ac.signal } as never,
      )
      .catch(() => undefined);
    expect(jobs("jira.sync_incremental")).toHaveLength(0);
  });

  test("a resume after a rate limit waits until retryAfter", async () => {
    pages.push(
      page([issue(1)], "tok-1"),
      boom(
        new JobError({
          kind: "rate_limited",
          message: "x",
          retryAfter: "2026-11-06T12:05:00.000Z",
        }),
      ),
    );
    expect(await run("jira.sync_incremental")).toMatchObject({ resumed: true });
    expect(jobs("jira.sync_incremental")[0]?.runAfter).toBe("2026-11-06T12:05:00.000Z");
  });

  test("a needs-attention failure after a completed page is not resumed", async () => {
    pages.push(
      page([issue(1)], "tok-1"),
      boom(new JobError({ kind: "output_too_large", message: "x" })),
    );
    await expect(run("jira.sync_incremental")).rejects.toMatchObject({
      classified: { kind: "output_too_large" },
    });
    expect(sync.get("jira.issues").lastError?.kind).toBe("output_too_large");
    expect(jobs()).toHaveLength(0);
  });

  test("a page whose next token equals the token that produced it fails as parse_failed; nothing committed", async () => {
    settings.set("jira.maxPagesPerRun", 5);
    pages.push(page([issue(1)], "tok-1"), page([issue(2)], "tok-1"), page([issue(3)]));
    const err = (await run("jira.sync_incremental").catch((e) => e)) as JobError;
    expect(err).toBeInstanceOf(JobError);
    expect(err.classified.kind).toBe("parse_failed");
    expect(searches).toHaveLength(2);
    expect(row("DEMO-2")).toBeUndefined();
    const s = sync.get("jira.issues");
    expect(s.checkpoint).toBeNull();
    expect(s.lastSuccessAt).toBeNull();
    expect(s.lastError).toEqual({ kind: "parse_failed", message: "jira sync failed" });
    expect(jobs()).toHaveLength(0);
  });

  test("a continuation whose first page repeats its own token fails as parse_failed", async () => {
    settings.set("jira.maxPagesPerRun", 1);
    pages.push(page([issue(1)], "tok-1"), page([issue(2)], "tok-1"));
    await run("jira.sync_incremental");
    await expect(runPending("jira.sync_incremental")).rejects.toMatchObject({
      classified: { kind: "parse_failed" },
    });
    expect(sync.get("jira.issues").checkpoint).toBeNull();
    expect(jobs("jira.sync_incremental").filter((j) => j.status === "PENDING")).toHaveLength(0);
  });

  test("a chain longer than jira.maxPagesPerChain fails as parse_failed; nothing committed", async () => {
    expect(settings.get("jira.maxPagesPerChain")).toBe(50);
    settings.set("jira.maxPagesPerChain", 3);
    settings.set("jira.maxPagesPerRun", 2);
    pages.push(
      page([issue(1)], "tok-1"),
      page([issue(2)], "tok-2"),
      page([issue(3)], "tok-3"),
      page([issue(4)]),
    );
    expect(await run("jira.sync_incremental")).toMatchObject({ complete: false });
    expect(jobs("jira.sync_incremental")[0]?.input).toMatchObject({ pagesSoFar: 2 });
    await expect(runPending("jira.sync_incremental")).rejects.toMatchObject({
      classified: { kind: "parse_failed" },
    });
    // Page 3 was the last one allowed; page 4 is never requested.
    expect(searches).toHaveLength(3);
    const s = sync.get("jira.issues");
    expect(s.checkpoint).toBeNull();
    expect(s.lastError?.kind).toBe("parse_failed");
    expect(jobs("jira.sync_incremental").filter((j) => j.status === "PENDING")).toHaveLength(0);
  });

  test("a chain of exactly jira.maxPagesPerChain pages completes", async () => {
    settings.set("jira.maxPagesPerChain", 2);
    pages.push(page([issue(1)], "tok-1"), page([issue(2)]));
    expect(await run("jira.sync_incremental")).toMatchObject({ complete: true });
  });

  test("jira.maxPagesPerChain is bounded 1..500", () => {
    expect(() => settings.set("jira.maxPagesPerChain", 0)).toThrow();
    expect(() => settings.set("jira.maxPagesPerChain", 501)).toThrow();
  });

  test("a non-JobError failure is recorded as unknown with a fixed message", async () => {
    pages.push(async () => {
      throw new Error("boom with DEMO-1 summary");
    });
    await expect(run("jira.sync_incremental")).rejects.toThrow();
    expect(sync.get("jira.issues").lastError?.kind).toBe("unknown");
    expect(JSON.stringify(sync.get("jira.issues").lastError)).not.toContain("summary");
  });

  test("a quota pause records no lastError", async () => {
    pages.push(boom(new JobError({ kind: "quota_exhausted", message: "later" })));
    await expect(run("jira.sync_incremental")).rejects.toBeInstanceOf(JobError);
    expect(sync.get("jira.issues").lastError).toBeNull();
    expect(evts("collection.failed")).toHaveLength(0);
  });

  test("a superseded continuation does nothing", async () => {
    settings.set("jira.maxPagesPerRun", 1);
    pages.push(page([issue(1)], "tok-1"));
    await run("jira.sync_incremental");
    db.transaction((tx) => sync.update(tx, "jira.issues", { generation: "newer" }));
    expect(await runPending("jira.sync_incremental")).toEqual({ skipped: "superseded" });
    expect(searches).toHaveLength(1);
  });

  test("a chain superseded mid-run stops before storing the next page", async () => {
    settings.set("jira.maxPagesPerRun", 3);
    pages.push(page([issue(1)], "tok-1"), async () => {
      db.transaction((tx) => sync.update(tx, "jira.issues", { generation: "newer" }));
      return { issues: [issue(2)], nextPageToken: "tok-2", total: null };
    });
    expect(await run("jira.sync_incremental")).toMatchObject({ superseded: true });
    expect(row("DEMO-1")).toBeDefined();
    expect(row("DEMO-2")).toBeUndefined();
    expect(searches).toHaveLength(2);
    expect(jobs()).toHaveLength(0);
  });

  test("a scope reset during a run stops that run from committing its checkpoint", async () => {
    pages.push(async () => {
      db.transaction((tx) =>
        sync.update(tx, "jira.issues", { generation: "reset", checkpoint: null }),
      );
      return { issues: [issue(1)], nextPageToken: null, total: null };
    });
    expect(await run("jira.sync_incremental")).toMatchObject({ superseded: true });
    expect(sync.get("jira.issues").checkpoint).toBeNull();
  });

  test("the checkpoint never moves backwards", async () => {
    db.transaction((tx) =>
      sync.update(tx, "jira.issues", { checkpoint: "2026-11-06T11:00:00.000Z" }),
    );
    pages.push(page([issue(1, { updatedAt: "2026-11-06T10:58:00.000Z" })]));
    await run("jira.sync_incremental");
    expect(sync.get("jira.issues").checkpoint).toBe("2026-11-06T11:00:00.000Z");
  });

  test("invalid continuation input fails as invalid_input", async () => {
    await expect(run("jira.sync_incremental", { nextPageToken: 5 })).rejects.toMatchObject({
      classified: { kind: "invalid_input" },
    });
  });
});

describe("reconcile", () => {
  const seed = () => {
    store.upsertPage([issue(1), issue(2), issue(3)], { setScope: true });
    db.update(schema.jiraIssues).set({ lastSeenAt: "2026-11-05T00:00:00.000Z" }).run();
    db.update(schema.jiraIssues)
      .set({ inScope: false })
      .where(eq(schema.jiraIssues.key, "DEMO-3"))
      .run();
  };

  test("a complete run marks unseen issues out of scope and seen ones in", async () => {
    seed();
    settings.set("jira.maxPagesPerRun", 1);
    pages.push(page([issue(1)], "tok-1"), page([issue(3)]));
    expect(await run("jira.reconcile")).toMatchObject({ pages: 1, complete: false });
    expect(searches[0]).toEqual({
      cloudId: CLOUD,
      jql: `(${SCOPE}) ORDER BY updated ASC`,
      maxResults: 20,
    });
    // Mid-run: no flags changed yet.
    expect(row("DEMO-2")?.inScope).toBe(true);
    expect(row("DEMO-3")?.inScope).toBe(false);
    await runPending("jira.reconcile");
    expect(searches[1]?.nextPageToken).toBe("tok-1");
    expect(row("DEMO-1")?.inScope).toBe(true);
    expect(row("DEMO-2")?.inScope).toBe(false);
    expect(row("DEMO-3")?.inScope).toBe(true);
    expect(sync.get("jira.reconcile").lastSuccessAt).toBe("2026-11-06T12:00:00.000Z");
  });

  test("a run failing on page 2 changes no flags and resumes from page 2 with the keys seen", async () => {
    seed();
    pages.push(
      page([issue(3, { updatedAt: "2026-11-06T11:00:00.000Z" })], "tok-1"),
      boom(new JobError({ kind: "transient_network", message: "x" })),
    );
    expect(await run("jira.reconcile")).toMatchObject({ resumed: true });
    expect(row("DEMO-1")?.inScope).toBe(true);
    expect(row("DEMO-2")?.inScope).toBe(true);
    expect(row("DEMO-3")?.inScope).toBe(false);
    const s = sync.get("jira.reconcile");
    expect(s.lastError?.kind).toBe("transient_network");
    expect(s.status).toBe("error");
    expect(s.lastSuccessAt).toBeNull();
    expect(jobs("jira.reconcile")[0]?.input).toMatchObject({
      nextPageToken: "tok-1",
      pagesSoFar: 1,
      seen: ["DEMO-3"],
    });
    pages.push(page([issue(1)]));
    await runPending("jira.reconcile");
    expect(row("DEMO-1")?.inScope).toBe(true);
    expect(row("DEMO-2")?.inScope).toBe(false);
    expect(row("DEMO-3")?.inScope).toBe(true);
    expect(sync.get("jira.reconcile")).toMatchObject({ status: "idle", lastError: null });
  });

  test("a reconcile longer than jira.maxPagesPerChain changes no flags", async () => {
    seed();
    settings.set("jira.maxPagesPerChain", 1);
    pages.push(page([issue(1)], "tok-1"));
    await expect(run("jira.reconcile")).rejects.toMatchObject({
      classified: { kind: "parse_failed" },
    });
    expect(row("DEMO-2")?.inScope).toBe(true);
    expect(row("DEMO-3")?.inScope).toBe(false);
    expect(sync.get("jira.reconcile").lastError?.kind).toBe("parse_failed");
  });

  test("a superseded reconcile changes no flags", async () => {
    seed();
    pages.push(async () => {
      db.transaction((tx) => sync.update(tx, "jira.reconcile", { generation: "newer" }));
      return { issues: [issue(1)], nextPageToken: null, total: null };
    });
    expect(await run("jira.reconcile")).toMatchObject({ superseded: true });
    expect(row("DEMO-2")?.inScope).toBe(true);
  });
});

describe("cloudId", () => {
  beforeEach(() => settings.clear("jira.cloudId"));

  test("exactly one site is stored; a sync and (no checkpoint yet) a reconcile are enqueued", async () => {
    sites.push(async () => [{ id: CLOUD, url: "https://example.invalid", name: "site" }]);
    await run("jira.resolve_cloud_id");
    expect(settings.get("jira.cloudId")).toBe(CLOUD);
    expect(jobs().map((j) => j.type)).toEqual(["jira.sync_incremental", "jira.reconcile"]);
  });

  test("with a checkpoint already stored only a sync is enqueued", async () => {
    db.transaction((tx) =>
      sync.update(tx, "jira.issues", { checkpoint: "2026-11-06T10:00:00.000Z" }),
    );
    sites.push(async () => [{ id: CLOUD, url: "https://example.invalid", name: "site" }]);
    await run("jira.resolve_cloud_id");
    expect(jobs().map((j) => j.type)).toEqual(["jira.sync_incremental"]);
  });

  test("two sites: NEEDS_ATTENTION with multiple_sites; nothing stored", async () => {
    sites.push(async () => [
      { id: CLOUD, url: "https://a.invalid", name: "a" },
      { id: "11111111-1111-4111-8111-111111111111", url: "https://b.invalid", name: "b" },
    ]);
    const err = (await run("jira.resolve_cloud_id").catch((e) => e)) as JobError;
    expect(err).toBeInstanceOf(JobError);
    expect(err.classified).toMatchObject({ kind: "needs_attention", message: "multiple_sites" });
    expect(retryDecision(err.classified.kind)).toBe("needs_attention");
    expect(settings.get("jira.cloudId")).toBeNull();
    expect(sync.get("jira.issues").lastError).toEqual({
      kind: "needs_attention",
      message: "multiple_sites",
    });
    expect(jobs()).toHaveLength(0);
  });

  test("zero sites: NEEDS_ATTENTION with no_sites", async () => {
    sites.push(async () => []);
    const err = (await run("jira.resolve_cloud_id").catch((e) => e)) as JobError;
    expect(err.classified).toMatchObject({ kind: "needs_attention", message: "no_sites" });
  });

  describe("candidate sites", () => {
    const ID2 = "11111111-1111-4111-8111-111111111111";
    const park = async () => (await run("jira.resolve_cloud_id").catch((e) => e)) as JobError;
    const status = () =>
      new JiraService({ db, clock, settings, sync, store, queue, audit }).status();

    test("several sites are stored as { id, name } and exposed by status", async () => {
      sites.push(async () => [
        { id: CLOUD, url: "https://a.invalid", name: "Demo site" },
        { id: ID2, url: "https://b.invalid", name: "Demo site 2" },
      ]);
      await park();
      const both = [
        { id: CLOUD, name: "Demo site" },
        { id: ID2, name: "Demo site 2" },
      ];
      expect(settings.get("jira.cloudIdCandidates")).toEqual(both);
      expect(status().sites).toEqual(both);
      expect(status().lastError).toBe("multiple_sites");
      expect(db.select().from(schema.auditEvents).all()).toHaveLength(0);
    });

    test("an invalid id is dropped; a long name is clipped to 200", async () => {
      sites.push(async () => [
        { id: "bad id!", url: "https://a.invalid", name: "Demo site" },
        { id: CLOUD, url: "https://b.invalid", name: "x".repeat(250) },
      ]);
      await park();
      expect(settings.get("jira.cloudIdCandidates")).toEqual([
        { id: CLOUD, name: "x".repeat(200) },
      ]);
    });

    test("zero sites stores an empty list; one site stores the id and an empty list", async () => {
      settings.set("jira.cloudIdCandidates", [{ id: CLOUD, name: "Demo site" }]);
      sites.push(async () => []);
      await park();
      expect(settings.get("jira.cloudIdCandidates")).toEqual([]);
      settings.set("jira.cloudIdCandidates", [{ id: CLOUD, name: "Demo site" }]);
      sites.push(async () => [{ id: CLOUD, url: "https://a.invalid", name: "Demo site" }]);
      await run("jira.resolve_cloud_id");
      expect(settings.get("jira.cloudId")).toBe(CLOUD);
      expect(settings.get("jira.cloudIdCandidates")).toEqual([]);
    });
  });

  test("duplicate candidate ids are collapsed before slicing", async () => {
    const ID2 = "11111111-1111-4111-8111-111111111111";
    sites.push(async () => [
      { id: CLOUD, url: "https://a.invalid", name: "Demo site" },
      { id: CLOUD, url: "https://a.invalid", name: "Demo site" },
      { id: ID2, url: "https://b.invalid", name: "Demo site 2" },
    ]);
    await run("jira.resolve_cloud_id").catch((e) => e);
    expect(settings.get("jira.cloudIdCandidates")).toEqual([
      { id: CLOUD, name: "Demo site" },
      { id: ID2, name: "Demo site 2" },
    ]);
  });

  test("a choice made while the lookup ran is not overwritten (park and success)", async () => {
    const ID2 = "11111111-1111-4111-8111-111111111111";
    sites.push(async () => {
      settings.set("jira.cloudId", ID2);
      return [
        { id: CLOUD, url: "https://a.invalid", name: "a" },
        { id: "22222222-2222-4222-8222-222222222222", url: "https://b.invalid", name: "b" },
      ];
    });
    expect(await run("jira.resolve_cloud_id")).toEqual({ skipped: "already_set" });
    expect(settings.get("jira.cloudId")).toBe(ID2);
    expect(settings.get("jira.cloudIdCandidates")).toEqual([]);
    expect(sync.get("jira.issues").lastError).toBeNull();

    settings.clear("jira.cloudId");
    sites.push(async () => {
      settings.set("jira.cloudId", ID2);
      return [{ id: CLOUD, url: "https://a.invalid", name: "a" }];
    });
    expect(await run("jira.resolve_cloud_id")).toEqual({ skipped: "already_set" });
    expect(settings.get("jira.cloudId")).toBe(ID2);
    expect(jobs()).toHaveLength(0);
  });

  test("already set: skipped without a run", async () => {
    settings.set("jira.cloudId", CLOUD);
    expect(await run("jira.resolve_cloud_id")).toEqual({ skipped: "already_set" });
    expect(resolves).toBe(0);
  });
});
