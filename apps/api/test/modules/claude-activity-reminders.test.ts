import { beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, runMigrations, schema } from "@synapse/database";
import { FakeClock } from "@synapse/shared";
import { eq } from "drizzle-orm";
import { SettingsService } from "../../src/core/config/settings";
import { EventPublisher } from "../../src/core/events/publisher";
import { REMINDER_KIND, WipReminders } from "../../src/modules/claude-activity/reminders";

const NOW = "2026-11-06T09:00:00.000Z";
const nowMs = Date.parse(NOW);
const daysAgo = (d: number) => new Date(nowMs - d * 86_400_000).toISOString();
const REPO = "repo-demo-app";
const URL7 = "https://github.com/demo-org/demo-app/pull/7";

let db: ReturnType<typeof openDatabase>["db"];
let clock: FakeClock;
let settings: SettingsService;
let local: { date: string; minutes: number };
let views: string[];
let viewImpl: (url: string) => Promise<{ state: string }>;
let sid = 0;

function build() {
  return new WipReminders({
    db,
    clock,
    settings,
    notifications: {
      notify: (tx, n) => {
        const row = tx
          .insert(schema.notifications)
          .values({ id: `n${++nid}`, ...n, createdAt: clock.now().toISOString() })
          .returning()
          .get();
        return row.id;
      },
    },
    prs: {
      view: (url) => {
        views.push(url);
        return viewImpl(url);
      },
    },
    localTime: () => local,
  });
}
let nid = 0;

function session(branch: string | null, firstDays: number, lastDays: number) {
  sid++;
  db.insert(schema.claudeSessions)
    .values({
      sessionId: `00000000-0000-4000-8000-${String(sid).padStart(12, "0")}`,
      repositoryId: REPO,
      cwd: "/x/demo-app",
      gitBranch: branch,
      firstAt: daysAgo(firstDays),
      lastAt: daysAgo(lastDays),
      filePath: `/f/${sid}.jsonl`,
      fileOffset: 0,
      fileSize: 0,
      fileMtimeMs: 0,
      updatedAt: NOW,
    })
    .run();
  return `00000000-0000-4000-8000-${String(sid).padStart(12, "0")}`;
}

function pr(sessionId: string, branch: string | null, seenDays: number, url = URL7) {
  db.insert(schema.claudeSessionPrs)
    .values({
      id: `pr${++sid}`,
      sessionId,
      repositoryId: REPO,
      prUrl: url,
      prNumber: 7,
      prRepository: "demo-org/demo-app",
      gitBranch: branch,
      firstSeenAt: daysAgo(seenDays),
    })
    .run();
}

const notes = () => db.select().from(schema.notifications).all();

beforeEach(() => {
  ({ db } = openDatabase(":memory:"));
  runMigrations(db);
  clock = new FakeClock(NOW);
  const events = new EventPublisher(clock);
  settings = new SettingsService(db, clock, events.publish.bind(events));
  local = { date: "2026-11-06", minutes: 10 * 60 };
  views = [];
  nid = 0;
  sid = 0;
  viewImpl = async () => ({ state: "OPEN" });
  db.insert(schema.repositories)
    .values({
      id: REPO,
      name: "demo-app",
      localPath: "/x/demo-app",
      upstreamPushDisabled: false,
      trackedBranch: "develop",
      jiraProjectKeys: [],
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run();
  db.insert(schema.repositoryEnvironments)
    .values({
      id: "env-stage",
      repositoryId: REPO,
      name: "stage",
      branch: "stage",
      protected: false,
      autoDeploysOnMerge: false,
    })
    .run();
});

describe("stale branches", () => {
  test("a branch worked on for days with no PR is reminded once", async () => {
    session("feature-x", 4, 1);
    const r = await build().run();
    expect(r).toEqual({ staleBranches: 1, openPrs: 0, skippedDedupe: 0, prErrors: 0 });
    const n = notes();
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({
      kind: REMINDER_KIND,
      severity: "info",
      ref: `wip:${REPO}:feature-x`,
      title: "Branch without a PR in demo-app",
      body: "You worked on feature-x in Claude Code for 4 days and no pull request was seen.",
    });
    const again = await build().run();
    expect(again.skippedDedupe).toBe(1);
    expect(again.staleBranches).toBe(0);
    expect(notes()).toHaveLength(1);
  });

  test("a dedupe older than 7 days no longer blocks", async () => {
    session("feature-x", 4, 1);
    await build().run();
    clock.advance(8 * 86_400_000);
    session("feature-x", 4, 0);
    expect((await build().run()).staleBranches).toBe(1);
  });

  test("a branch with a session PR gets no branch reminder", async () => {
    const s = session("feature-x", 4, 1);
    pr(s, "feature-x", 0);
    expect((await build().run()).staleBranches).toBe(0);
    expect(notes()).toHaveLength(0);
  });

  test("main, HEAD, the tracked branch, an environment branch and null are excluded", async () => {
    for (const b of ["main", "HEAD", "develop", "stage", null]) session(b, 4, 1);
    expect((await build().run()).staleBranches).toBe(0);
    expect(notes()).toHaveLength(0);
  });

  test("a branch first seen 2 days ago, or idle for 20 days, is not reminded", async () => {
    session("fresh", 2, 1);
    session("idle", 30, 20);
    expect((await build().run()).staleBranches).toBe(0);
  });

  test("min first_at and max last_at are taken across sessions of the branch", async () => {
    session("feature-x", 1, 1);
    session("feature-x", 5, 4);
    expect((await build().run()).staleBranches).toBe(1);
  });
});

describe("open PRs", () => {
  test("an open PR seen 4 days ago is reminded and marked", async () => {
    const s = session("feature-x", 5, 1);
    pr(s, "feature-x", 4);
    const r = await build().run();
    expect(r.openPrs).toBe(1);
    expect(views).toEqual([URL7]);
    const n = notes();
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({
      ref: `pr:${URL7}`,
      title: "Pull request still open in demo-app",
      body: "#7 (demo-org/demo-app) has been open for 4 days.",
    });
    const row = db.select().from(schema.claudeSessionPrs).get();
    expect(row?.remindedAt).not.toBeNull();
    await build().run();
    expect(views).toHaveLength(1);
  });

  test("a PR seen 2 days ago is not checked", async () => {
    pr(session("f", 1, 1), "f", 2);
    await build().run();
    expect(views).toEqual([]);
  });

  test("a merged PR notifies nothing and stays unreminded", async () => {
    viewImpl = async () => ({ state: "MERGED" });
    pr(session("f", 5, 1), "f", 4);
    const r = await build().run();
    expect(r.openPrs).toBe(0);
    expect(notes()).toHaveLength(0);
    expect(db.select().from(schema.claudeSessionPrs).get()?.remindedAt).toBeNull();
  });

  test("a provider error is counted and skipped without throwing", async () => {
    viewImpl = async () => {
      throw new Error("boom https://github.com/secret");
    };
    pr(session("f", 5, 1), "f", 4);
    const r = await build().run();
    expect(r).toMatchObject({ prErrors: 1, openPrs: 0 });
    expect(notes()).toHaveLength(0);
    expect(db.select().from(schema.claudeSessionPrs).get()?.remindedAt).toBeNull();
  });
});

describe("runIfDue", () => {
  test("not due before 09:30 local, runs after, then done_today", async () => {
    session("feature-x", 4, 1);
    local = { date: "2026-11-06", minutes: 9 * 60 + 29 };
    expect(await build().runIfDue()).toEqual({ skipped: "not_due" });
    local = { date: "2026-11-06", minutes: 9 * 60 + 31 };
    expect(await build().runIfDue()).toMatchObject({ staleBranches: 1 });
    expect(settings.get("claudeActivity.reminders.lastRunDate")).toBe("2026-11-06");
    expect(await build().runIfDue()).toEqual({ skipped: "done_today" });
    local = { date: "2026-11-07", minutes: 10 * 60 };
    expect(await build().runIfDue()).toMatchObject({ skippedDedupe: 1 });
  });

  test("disabled", async () => {
    settings.set("claudeActivity.enabled", false);
    expect(await build().runIfDue()).toEqual({ skipped: "disabled" });
  });

  test("nothing is sent to anyone", async () => {
    session("feature-x", 4, 1);
    pr(session("g", 5, 1), "g", 4);
    await build().run();
    expect(db.select().from(schema.outgoingMessages).all()).toEqual([]);
    expect(db.select().from(schema.approvals).all()).toEqual([]);
    expect(
      db
        .select()
        .from(schema.notifications)
        .where(eq(schema.notifications.kind, REMINDER_KIND))
        .all(),
    ).toHaveLength(2);
  });
});
