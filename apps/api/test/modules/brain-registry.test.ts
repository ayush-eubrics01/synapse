import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { openDatabase, runMigrations, schema } from "@synapse/database";
import { FakeClock } from "@synapse/shared";
import { eq } from "drizzle-orm";
import { AuditLogger } from "../../src/core/audit/audit";
import { EventPublisher } from "../../src/core/events/publisher";
import { LocalGitProvider } from "../../src/integrations/repository/local-git";
import {
  RegistryError,
  type RegistryErrorCode,
  RepositoryRegistry,
} from "../../src/modules/engineering-brain/registry";
import { git, initRepo, makeDemoRepo, tempDir } from "../fixtures/git-repo";

const NOW = "2026-11-06T09:00:00.000Z";
const roots: string[] = [];
const scratch = () => {
  const d = tempDir();
  roots.push(d);
  return d;
};
afterAll(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

let db: ReturnType<typeof openDatabase>["db"];
let clock: FakeClock;
let events: EventPublisher;
let registry: RepositoryRegistry;
let repo: string;

function makeRegistry(ev: Pick<EventPublisher, "publish"> = events) {
  return new RepositoryRegistry({
    db,
    clock,
    audit: new AuditLogger(clock),
    events: ev,
    provider: new LocalGitProvider({ home: scratch() }),
  });
}

const counts = () => ({
  repos: db.select().from(schema.repositories).all().length,
  envs: db.select().from(schema.repositoryEnvironments).all().length,
  projects: db.select().from(schema.projects).all().length,
  links: db.select().from(schema.projectRepositories).all().length,
  audit: db.select().from(schema.auditEvents).all().length,
  events: db.select().from(schema.domainEvents).all().length,
});

const input = (over: Record<string, unknown> = {}) => ({
  path: repo,
  name: "app",
  trackedBranch: "main",
  environments: [
    { name: "stage", branch: "stage", protected: false, autoDeploysOnMerge: true },
    { name: "prod", branch: "prod", protected: true, autoDeploysOnMerge: false, notes: "manual" },
  ],
  jiraProjectKeys: ["DEMO"],
  ...over,
});

async function expectCode(p: Promise<unknown>, code: RegistryErrorCode) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(RegistryError);
  expect((err as RegistryError).code).toBe(code);
}

beforeEach(() => {
  db = openDatabase(":memory:").db;
  runMigrations(db);
  clock = new FakeClock(NOW);
  events = new EventPublisher(clock);
  repo = makeDemoRepo(scratch());
  registry = makeRegistry();
});

describe("propose", () => {
  test("returns the detected values and saves nothing", async () => {
    git(repo, "update-ref", "refs/remotes/origin/release", "HEAD");
    git(repo, "update-ref", "refs/remotes/origin/prod", "HEAD");
    const before = counts();
    const r = await registry.propose(repo);
    if (!r.ok) throw new Error(r.reason);
    expect(r.proposal).toEqual({
      realpath: repo,
      suggestedName: "app",
      currentBranch: "main",
      suggestedTrackedBranch: "main",
      headSha: git(repo, "rev-parse", "HEAD"),
      originUrl: "https://example.com/demo/app.git",
      upstreamUrl: "https://example.com/upstream/app.git",
      upstreamPushDisabled: true,
      branches: ["feature-x", "main", "prod", "release", "stage"],
      environmentCandidates: [
        { name: "main", branch: "main" },
        { name: "prod", branch: "prod" },
        { name: "release", branch: "release" },
        { name: "stage", branch: "stage" },
      ],
    });
    expect(counts()).toEqual(before);
  });

  test("strips credentials from the proposed remotes", async () => {
    git(repo, "remote", "set-url", "origin", "https://user:tok@example.com/demo/app.git");
    const r = await registry.propose(repo);
    expect(r.ok && r.proposal.originUrl).toBe("https://example.com/demo/app.git");
    expect(JSON.stringify(r)).not.toContain("tok@");
  });

  test("a bad path gives a reason and saves nothing", async () => {
    const plain = scratch();
    expect(await registry.propose(plain)).toEqual({ ok: false, reason: "not_git_root" });
    expect(await registry.propose("relative/app")).toEqual({ ok: false, reason: "not_absolute" });
    expect(await registry.propose("/tmp/has space")).toEqual({ ok: false, reason: "unsafe_chars" });
    expect(counts().repos).toBe(0);
  });

  test("an already registered path is refused", async () => {
    await registry.register(input());
    expect(await registry.propose(repo)).toEqual({ ok: false, reason: "already_registered" });
  });
});

describe("register", () => {
  test("saves the repo, its environments and a linked project, audited with ids only", async () => {
    const view = await registry.register(input());
    expect(view).toMatchObject({
      name: "app",
      localPath: repo,
      originUrl: "https://example.com/demo/app.git",
      upstreamUrl: "https://example.com/upstream/app.git",
      upstreamPushDisabled: true,
      trackedBranch: "main",
      jiraProjectKeys: ["DEMO"],
      notes: null,
      headSha: git(repo, "rev-parse", "HEAD"),
      inspectedHeadSha: null,
      drift: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(
      view.environments.map((e) => [e.name, e.branch, e.protected, e.autoDeploysOnMerge]),
    ).toEqual([
      ["prod", "prod", true, false],
      ["stage", "stage", false, true],
    ]);
    expect(counts()).toMatchObject({ repos: 1, envs: 2, projects: 1, links: 1 });

    const project = db.select().from(schema.projects).get();
    expect(project?.name).toBe("app");
    expect(view.projectId).toBe(project?.id ?? "");

    const audit = db.select().from(schema.auditEvents).all();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor: "user",
      module: "engineering-brain",
      action: "repo.registered",
      targetRef: view.id,
      result: "ok",
    });
    expect(audit[0]?.details).toEqual({ repositoryId: view.id, projectId: view.projectId });
    const auditText = JSON.stringify(audit);
    expect(auditText).not.toContain(repo);
    expect(auditText).not.toContain("example.com");

    const ev = db
      .select()
      .from(schema.domainEvents)
      .where(eq(schema.domainEvents.type, "repo.registered"))
      .all();
    expect(ev.map((e) => e.payload)).toEqual([{ repositoryId: view.id }]);
    expect(registry.get(view.id)).toEqual(view);
    expect(registry.list()).toEqual([view]);
  });

  test("accepts an environment branch that exists only on a remote, and a symlinked path", async () => {
    git(repo, "update-ref", "refs/remotes/origin/release", "HEAD");
    const link = join(scratch(), "linked");
    symlinkSync(repo, link);
    const view = await registry.register(
      input({
        path: link,
        environments: [
          { name: "rel", branch: "release", protected: true, autoDeploysOnMerge: false },
        ],
      }),
    );
    expect(view.localPath).toBe(repo);
    expect(view.environments[0]?.branch).toBe("release");
  });

  test("rejects a tracked branch that does not exist, saving nothing", async () => {
    await expectCode(registry.register(input({ trackedBranch: "nope" })), "unknown_tracked_branch");
    expect(counts()).toMatchObject({ repos: 0, envs: 0, projects: 0, audit: 0 });
  });

  test("rejects an environment branch that does not exist, saving nothing", async () => {
    await expectCode(
      registry.register(
        input({
          environments: [{ name: "qa", branch: "qa", protected: false, autoDeploysOnMerge: false }],
        }),
      ),
      "unknown_environment_branch",
    );
    expect(counts()).toMatchObject({ repos: 0, envs: 0, projects: 0, audit: 0 });
  });

  test("validates names, environment names and Jira keys", async () => {
    await expectCode(registry.register(input({ name: "bad name" })), "invalid_input");
    await expectCode(registry.register(input({ name: "x".repeat(65) })), "invalid_input");
    await expectCode(
      registry.register(
        input({
          environments: [
            { name: "stage", branch: "stage", protected: false, autoDeploysOnMerge: false },
            { name: "stage", branch: "prod", protected: false, autoDeploysOnMerge: false },
          ],
        }),
      ),
      "duplicate_environment",
    );
    await expectCode(
      registry.register(
        input({
          environments: [
            { name: "a/b", branch: "stage", protected: false, autoDeploysOnMerge: false },
          ],
        }),
      ),
      "invalid_input",
    );
    await expectCode(registry.register(input({ jiraProjectKeys: ["demo"] })), "invalid_input");
    expect(counts().repos).toBe(0);
  });

  test("refuses a duplicate name and a bad path", async () => {
    await registry.register(input());
    const other = makeDemoRepo(scratch(), "other");
    await expectCode(registry.register(input({ path: other })), "duplicate_name");
    await expectCode(registry.register(input({ path: scratch(), name: "x" })), "not_git_root");
    await expectCode(registry.register(input({ name: "again" })), "already_registered");
    expect(counts().repos).toBe(1);
  });

  test("stores credential-stripped remotes", async () => {
    git(repo, "remote", "set-url", "origin", "https://user:tok@example.com/demo/app.git");
    const view = await registry.register(input());
    expect(view.originUrl).toBe("https://example.com/demo/app.git");
    const row = db.select().from(schema.repositories).get();
    expect(JSON.stringify(row)).not.toContain("tok");
  });

  test("is one transaction: a failure while publishing leaves nothing behind", async () => {
    const failing = makeRegistry({
      publish: () => {
        throw new Error("boom");
      },
    });
    await expect(failing.register(input())).rejects.toThrow("boom");
    expect(counts()).toMatchObject({ repos: 0, envs: 0, projects: 0, links: 0, audit: 0 });
  });

  test("re-registering after unregister relinks the surviving project of the same name", async () => {
    const first = await registry.register(input());
    registry.unregister(first.id);
    const again = await registry.register(input());
    expect(again.projectId).toBe(first.projectId);
    expect(counts()).toMatchObject({ repos: 1, projects: 1, links: 1 });
  });
});

describe("update and unregister", () => {
  test("update changes the tracked branch, notes, keys and environments, and is audited", async () => {
    const view = await registry.register(input());
    const stageId = view.environments.find((e) => e.name === "stage")?.id;
    clock.advance(60_000);
    const next = await registry.update(view.id, {
      trackedBranch: "stage",
      notes: "stage deploys on merge",
      jiraProjectKeys: ["DEMO", "OPS"],
      environments: [
        { name: "stage", branch: "stage", protected: true, autoDeploysOnMerge: true },
        { name: "hotfix", branch: "feature-x", protected: false, autoDeploysOnMerge: false },
      ],
    });
    expect(next.trackedBranch).toBe("stage");
    expect(next.notes).toBe("stage deploys on merge");
    expect(next.jiraProjectKeys).toEqual(["DEMO", "OPS"]);
    expect(next.environments.map((e) => e.name)).toEqual(["hotfix", "stage"]);
    // Kept environments keep their id (milestones reference it).
    expect(next.environments.find((e) => e.name === "stage")?.id).toBe(stageId ?? "");
    expect(next.environments.find((e) => e.name === "stage")?.protected).toBe(true);
    expect(next.updatedAt).not.toBe(view.updatedAt);
    const audit = db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, "repo.updated"))
      .all();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.details).toEqual({
      repositoryId: view.id,
      fields: ["environments", "jiraProjectKeys", "notes", "trackedBranch"],
    });
  });

  test("update rejects an unknown branch and leaves the repo unchanged", async () => {
    const view = await registry.register(input());
    await expectCode(registry.update(view.id, { trackedBranch: "nope" }), "unknown_tracked_branch");
    await expectCode(
      registry.update(view.id, {
        environments: [{ name: "qa", branch: "qa", protected: false, autoDeploysOnMerge: false }],
      }),
      "unknown_environment_branch",
    );
    expect(registry.get(view.id)).toEqual(view);
  });

  test("update of an unknown id and a duplicate rename are refused", async () => {
    await expectCode(registry.update("missing", { notes: "x" }), "not_found");
    const view = await registry.register(input());
    const other = await registry.register(
      input({ path: makeDemoRepo(scratch(), "o"), name: "other" }),
    );
    await expectCode(registry.update(other.id, { name: "app" }), "duplicate_name");
    const renamed = await registry.update(view.id, { name: "app-renamed" });
    expect(renamed.name).toBe("app-renamed");
  });

  test("unregister removes the repo and environments but keeps the project; audited", async () => {
    const view = await registry.register(input());
    registry.unregister(view.id);
    expect(registry.get(view.id)).toBeNull();
    expect(counts()).toMatchObject({ repos: 0, envs: 0, projects: 1, links: 0 });
    const audit = db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, "repo.unregistered"))
      .all();
    expect(audit[0]?.details).toEqual({ repositoryId: view.id });
    expect(() => registry.unregister(view.id)).toThrow(RegistryError);
  });

  test("an unregistered path can be proposed again", async () => {
    const view = await registry.register(input());
    registry.unregister(view.id);
    const r = await registry.propose(repo);
    expect(r.ok).toBe(true);
  });

  test("a second repo nested in a registered one is refused", async () => {
    await registry.register(input());
    const inner = initRepo(join(repo, "vendor", "lib"));
    expect(await registry.propose(inner)).toEqual({ ok: false, reason: "nested" });
  });
});
