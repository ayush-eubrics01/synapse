import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { renameSync, rmSync } from "node:fs";
import type { RepositoryProvider } from "@synapse/contracts";
import { openDatabase, runMigrations, schema } from "@synapse/database";
import { FakeClock } from "@synapse/shared";
import { eq } from "drizzle-orm";
import { AuditLogger } from "../../src/core/audit/audit";
import { LiveBus } from "../../src/core/events/live-bus";
import { EventPublisher } from "../../src/core/events/publisher";
import { JobQueue } from "../../src/core/jobs/queue";
import type { HandlerRegistration } from "../../src/core/jobs/worker";
import { NotificationService } from "../../src/core/notifications/notifications";
import { SchedulerService } from "../../src/core/scheduler/scheduler";
import { LocalGitProvider } from "../../src/integrations/repository/local-git";
import { RepositoryRegistry } from "../../src/modules/engineering-brain/registry";
import { BRAIN_DRIFT_JOB, registerDriftCheck } from "../../src/workers/brain/drift";
import { git, makeDemoRepo, tempDir } from "../fixtures/git-repo";

const NOW = "2026-11-06T09:00:00.000Z";
const DAY = 86_400_000;
const roots: string[] = [];
const scratch = () => {
  const d = tempDir();
  roots.push(d);
  return d;
};
afterAll(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

const ctx = {
  signal: new AbortController().signal,
  checkpoint() {},
  getCheckpoint: () => undefined,
} as never;

let db: ReturnType<typeof openDatabase>["db"];
let clock: FakeClock;
let registry: RepositoryRegistry;
let handlers: Map<string, HandlerRegistration>;
let scheduler: SchedulerService;
let repo: string;
let repoId: string;

function setup(provider: RepositoryProvider) {
  handlers = new Map();
  const events = new EventPublisher(clock);
  const queue = new JobQueue(db, clock);
  scheduler = new SchedulerService(db, clock, queue);
  registry = new RepositoryRegistry({ db, clock, audit: new AuditLogger(clock), events, provider });
  registerDriftCheck({
    db,
    clock,
    events,
    notifications: new NotificationService(db, clock, new LiveBus()),
    provider,
    scheduler,
    handlers,
  });
}

const run = () => {
  const h = handlers.get(BRAIN_DRIFT_JOB);
  if (!h) throw new Error("drift handler not registered");
  return h.handler({} as never, ctx);
};
const row = () =>
  db.select().from(schema.repositories).where(eq(schema.repositories.id, repoId)).get();
const notes = () => db.select().from(schema.notifications).all();
const driftEvents = () =>
  db
    .select()
    .from(schema.domainEvents)
    .where(eq(schema.domainEvents.type, "repo.drift_detected"))
    .all();

beforeEach(async () => {
  db = openDatabase(":memory:").db;
  runMigrations(db);
  clock = new FakeClock(NOW);
  repo = makeDemoRepo(scratch());
  setup(new LocalGitProvider({ home: scratch() }));
  const view = await registry.register({
    path: repo,
    name: "app",
    trackedBranch: "main",
    environments: [
      { name: "stage", branch: "stage", protected: false, autoDeploysOnMerge: true },
      { name: "prod", branch: "prod", protected: true, autoDeploysOnMerge: false },
    ],
    jiraProjectKeys: [],
  });
  repoId = view.id;
});

describe("brain.drift_check", () => {
  test("is scheduled daily and coalesced", () => {
    const task = db
      .select()
      .from(schema.scheduledTasks)
      .where(eq(schema.scheduledTasks.name, BRAIN_DRIFT_JOB))
      .get();
    expect(task).toMatchObject({ jobType: BRAIN_DRIFT_JOB, intervalSeconds: 86_400 });
  });

  test("no drift: nothing stored, nothing notified", async () => {
    expect(await run()).toEqual({ checked: 1, drifted: 0, notified: 0, failed: 0 });
    expect(row()?.drift).toBeNull();
    expect(notes()).toHaveLength(0);
  });

  test("checking out another branch stores drift and notifies once; the registry is unchanged", async () => {
    const before = registry.get(repoId);
    git(repo, "checkout", "-q", "stage");
    expect(await run()).toEqual({ checked: 1, drifted: 1, notified: 1, failed: 0 });
    expect(row()?.drift).toEqual({ offTrackedBranch: "stage", detectedAt: NOW });
    const n = notes();
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({
      kind: "repo.drift",
      severity: "warning",
      title: "Repository drift: app",
      ref: `repo:${repoId}`,
    });
    expect(n[0]?.body ?? null).toBeNull();
    expect(driftEvents().map((e) => e.payload)).toEqual([{ repositoryId: repoId }]);
    const after = registry.get(repoId);
    expect(after ? { ...after, drift: null } : null).toEqual(before as never);
    expect(after?.trackedBranch).toBe("main");
  });

  test("running again with the same drift does not notify again or move detectedAt", async () => {
    git(repo, "checkout", "-q", "stage");
    await run();
    clock.advance(DAY);
    expect(await run()).toEqual({ checked: 1, drifted: 1, notified: 0, failed: 0 });
    expect(notes()).toHaveLength(1);
    expect(driftEvents()).toHaveLength(1);
    expect(row()?.drift?.detectedAt).toBe(NOW);
  });

  test("switching between off-track branches does not notify again; the name stays current", async () => {
    git(repo, "checkout", "-q", "stage");
    await run();
    git(repo, "checkout", "-q", "-b", "feature-a");
    clock.advance(DAY);
    expect(await run()).toEqual({ checked: 1, drifted: 1, notified: 0, failed: 0 });
    git(repo, "checkout", "-q", "-b", "feature-b");
    clock.advance(DAY);
    expect(await run()).toEqual({ checked: 1, drifted: 1, notified: 0, failed: 0 });
    expect(notes()).toHaveLength(1);
    expect(driftEvents()).toHaveLength(1);
    // The branch name is for display only: it follows the checkout, detectedAt does not move.
    expect(row()?.drift).toEqual({ offTrackedBranch: "feature-b", detectedAt: NOW });
  });

  test("fixing the problem clears the drift; a later drift notifies again", async () => {
    git(repo, "checkout", "-q", "stage");
    await run();
    git(repo, "checkout", "-q", "main");
    clock.advance(DAY);
    expect(await run()).toEqual({ checked: 1, drifted: 0, notified: 0, failed: 0 });
    expect(row()?.drift).toBeNull();
    git(repo, "checkout", "-q", "stage");
    await run();
    expect(notes()).toHaveLength(2);
  });

  test("deleting an environment branch is drift; a remote copy still counts as present", async () => {
    git(repo, "update-ref", "refs/remotes/origin/stage", "HEAD");
    git(repo, "branch", "-D", "stage", "prod");
    await run();
    expect(row()?.drift).toEqual({ missingEnvironmentBranches: ["prod"], detectedAt: NOW });
    expect(notes()).toHaveLength(1);
  });

  test("a changed drift notifies again", async () => {
    git(repo, "checkout", "-q", "stage");
    await run();
    git(repo, "branch", "-D", "prod");
    clock.advance(DAY);
    await run();
    expect(row()?.drift).toEqual({
      offTrackedBranch: "stage",
      missingEnvironmentBranches: ["prod"],
      detectedAt: new Date(Date.parse(NOW) + DAY).toISOString(),
    });
    expect(notes()).toHaveLength(2);
    expect(driftEvents()).toHaveLength(2);
  });

  test("changed remote URLs and re-enabled upstream pushes are drift", async () => {
    git(repo, "remote", "set-url", "origin", "https://example.com/other/app.git");
    await run();
    expect(row()?.drift).toEqual({ remotesChanged: true, detectedAt: NOW });

    git(repo, "remote", "set-url", "origin", "https://example.com/demo/app.git");
    await run();
    expect(row()?.drift).toBeNull();

    git(repo, "remote", "set-url", "--push", "upstream", "https://example.com/upstream/app.git");
    await run();
    expect(row()?.drift).toEqual({ remotesChanged: true, detectedAt: NOW });
  });

  test("adding credentials to the same remote is not drift", async () => {
    git(repo, "remote", "set-url", "origin", "https://user:tok@example.com/demo/app.git");
    await run();
    expect(row()?.drift).toBeNull();
  });

  test("a missing path is drift and the notification carries no path", async () => {
    renameSync(repo, `${repo}-moved`);
    roots.push(`${repo}-moved`);
    await run();
    expect(row()?.drift).toEqual({ pathMissing: true, detectedAt: NOW });
    expect(JSON.stringify(notes())).not.toContain(repo);
    expect(JSON.stringify(driftEvents())).not.toContain(repo);
  });

  test("a git failure leaves the stored drift alone and is counted", async () => {
    const failing: RepositoryProvider = {
      checkPath: async () => ({ ok: false, reason: "not_found" }),
      inspect: async () => ({ ok: false, reason: "git_failed" }),
    };
    git(repo, "checkout", "-q", "stage");
    await run();
    setup(failing);
    clock.advance(DAY);
    expect(await run()).toEqual({ checked: 1, drifted: 0, notified: 0, failed: 1 });
    expect(row()?.drift).toEqual({ offTrackedBranch: "stage", detectedAt: NOW });
    expect(notes()).toHaveLength(1);
  });

  test("git that cannot be spawned is a failure, not pathMissing", async () => {
    setup(new LocalGitProvider({ home: scratch(), binary: "/nonexistent/synapse-git" }));
    expect(await run()).toEqual({ checked: 1, drifted: 0, notified: 0, failed: 1 });
    expect(row()?.drift).toBeNull();
    expect(notes()).toHaveLength(0);
  });

  test("one repository throwing does not stop the others", async () => {
    const real = new LocalGitProvider({ home: scratch() });
    const second = makeDemoRepo(scratch(), "second");
    await registry.register({
      path: second,
      name: "second",
      trackedBranch: "main",
      environments: [],
      jiraProjectKeys: [],
    });
    git(second, "checkout", "-q", "stage");
    setup({
      checkPath: (p, r) => real.checkPath(p, r),
      inspect: async (p) => {
        if (p === repo) throw new Error("boom");
        return real.inspect(p);
      },
    });
    expect(await run()).toEqual({ checked: 2, drifted: 1, notified: 1, failed: 1 });
    expect(notes().map((n) => n.title)).toEqual(["Repository drift: second"]);
  });
});
