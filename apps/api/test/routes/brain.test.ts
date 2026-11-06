import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AIProvider,
  DashboardOverview,
  ProjectDetail,
  ProjectFactView,
  RepositoryView,
} from "@synapse/contracts";
import { schema } from "@synapse/database";
import { eq } from "drizzle-orm";
import { createApp } from "../../src/app";
import { type Container, createContainer } from "../../src/container";
import { loadConfig } from "../../src/core/config/config";
import { git, makeDemoRepo, tempDir } from "../fixtures/git-repo";

const fakeProvider: AIProvider = {
  execute: async () => {
    throw new Error("fake provider must not execute");
  },
  getHealth: async () => ({ status: "ok", version: "fake" }),
};
const NOW = "2026-11-06T12:00:00.000Z";

const roots: string[] = [];
const scratch = () => {
  const d = tempDir();
  roots.push(d);
  return d;
};
afterAll(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

let c: Container;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  c = createContainer(loadConfig({ SYNAPSE_DB_PATH: ":memory:" }), {
    run: async () => "Linger=no",
    provider: fakeProvider,
    clock: { now: () => new Date(NOW) },
  });
  app = createApp(c);
});
afterEach(() => c.sqlite.close());

const call = (path: string, init?: RequestInit) =>
  app.request(`http://127.0.0.1:7400${path}`, init);
const send = (method: string, path: string, body?: unknown) =>
  call(path, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const registerBody = (path: string, over: object = {}) => ({
  path,
  name: "app",
  trackedBranch: "main",
  environments: [{ name: "prod", branch: "prod", protected: true, autoDeploysOnMerge: false }],
  jiraProjectKeys: ["DEMO"],
  ...over,
});

async function register(over: object = {}): Promise<{ repo: RepositoryView; path: string }> {
  const path = makeDemoRepo(scratch());
  const res = await send("POST", "/api/repos", registerBody(path, over));
  expect(res.status).toBe(201);
  return { repo: (await res.json()) as RepositoryView, path };
}

describe("POST /api/repos/inspect", () => {
  test("returns the proposal for a temp repo and saves nothing", async () => {
    const path = makeDemoRepo(scratch());
    const res = await send("POST", "/api/repos/inspect", { path });
    expect(res.status).toBe(200);
    const p = (await res.json()) as { realpath: string; suggestedName: string; branches: string[] };
    expect(p.realpath).toBe(path);
    expect(p.suggestedName).toBe("app");
    expect(p.branches).toContain("prod");
    expect(c.db.select().from(schema.repositories).all()).toHaveLength(0);
  });

  test("a bad path is a 400 with the reason", async () => {
    const res = await send("POST", "/api/repos/inspect", { path: "relative/path" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "not_absolute", reason: "not_absolute" });
    const missing = await send("POST", "/api/repos/inspect", { path: "/nonexistent/synapse-x" });
    expect(await missing.json()).toMatchObject({ reason: "not_found" });
  });

  test("every path refusal class is a 400 with its reason", async () => {
    const spaced = join(scratch(), "a b");
    mkdirSync(spaced);
    const plain = join(scratch(), "plain");
    mkdirSync(plain);
    const file = join(scratch(), "file.txt");
    writeFileSync(file, "x");
    const cases: [string, string][] = [
      ["unsafe_chars", spaced],
      ["not_directory", file],
      ["not_git_root", plain],
      ["forbidden_location", process.env.HOME ?? "/home/nobody"],
    ];
    for (const [reason, path] of cases) {
      const res = await send("POST", "/api/repos/inspect", { path });
      expect([reason, res.status, await res.json()]).toEqual([
        reason,
        400,
        { error: reason, reason },
      ]);
    }
  });

  test("a body without a path is a 400", async () => {
    expect((await send("POST", "/api/repos/inspect", {})).status).toBe(400);
    expect((await call("/api/repos/inspect", { method: "POST", body: "not json" })).status).toBe(
      400,
    );
  });
});

describe("repositories", () => {
  test("POST /api/repos is a 201 with the view, environments and no drift", async () => {
    const { repo, path } = await register();
    expect(repo).toMatchObject({
      name: "app",
      localPath: path,
      trackedBranch: "main",
      jiraProjectKeys: ["DEMO"],
      drift: null,
    });
    expect(repo.environments.map((e) => e.name)).toEqual(["prod"]);
    expect(repo.projectId).toBeTruthy();
  });

  test("GET /api/repos and /api/repos/:id return the view; unknown id is 404", async () => {
    const { repo } = await register();
    const list = (await (await call("/api/repos")).json()) as RepositoryView[];
    expect(list.map((r) => r.id)).toEqual([repo.id]);
    expect(list[0]?.environments).toHaveLength(1);
    const one = await call(`/api/repos/${repo.id}`);
    expect(one.status).toBe(200);
    expect(((await one.json()) as RepositoryView).id).toBe(repo.id);
    expect((await call("/api/repos/nope")).status).toBe(404);
  });

  test("PUT updates; DELETE unregisters and keeps the project", async () => {
    const { repo } = await register();
    const put = await send("PUT", `/api/repos/${repo.id}`, { notes: "hello" });
    expect(put.status).toBe(200);
    expect(((await put.json()) as RepositoryView).notes).toBe("hello");
    const del = await call(`/api/repos/${repo.id}`, { method: "DELETE" });
    expect(del.status).toBe(204);
    expect(c.db.select().from(schema.repositories).all()).toHaveLength(0);
    expect(c.db.select().from(schema.projects).all()).toHaveLength(1);
  });

  test("POST accept-remotes returns the updated view; unknown id is 404", async () => {
    const { repo, path } = await register();
    git(path, "remote", "set-url", "origin", "https://example.com/other/app.git");
    const res = await send("POST", `/api/repos/${repo.id}/accept-remotes`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as RepositoryView).originUrl).toBe(
      "https://example.com/other/app.git",
    );
    expect((await send("POST", "/api/repos/nope/accept-remotes")).status).toBe(404);
  });

  test("POST /api/repos/:id/inspect is 202, then 409 while queued, 404 for an unknown id", async () => {
    const { repo } = await register();
    // Registration already queued the first inspection through the outbox; drain it first.
    c.db.delete(schema.jobs).run();
    const first = await send("POST", `/api/repos/${repo.id}/inspect`);
    expect(first.status).toBe(202);
    const { jobId } = (await first.json()) as { jobId: string };
    expect(jobId).toBeTruthy();
    const second = await send("POST", `/api/repos/${repo.id}/inspect`);
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "already_queued", jobId });
    expect((await send("POST", "/api/repos/nope/inspect")).status).toBe(404);
  });

  describe("registry errors map to HTTP", () => {
    test("400 for validation and path reasons", async () => {
      const home = process.env.HOME ?? "/home/nobody";
      const spaced = join(scratch(), "a b");
      mkdirSync(spaced);
      const plain = join(scratch(), "plain");
      mkdirSync(plain);
      const file = join(scratch(), "file.txt");
      writeFileSync(file, "x");
      const demo = makeDemoRepo(scratch());
      const outer = makeDemoRepo(scratch(), "outer");
      mkdirSync(join(outer, "inner"));
      const cases: [string, object][] = [
        ["invalid_input", registerBody("rel/path")],
        ["invalid_input", { path: "/tmp/x", name: "app" }],
        ["not_found", registerBody("/nonexistent/synapse-x")],
        ["not_directory", registerBody(file)],
        ["not_git_root", registerBody(plain)],
        ["invalid_input", registerBody(spaced)],
        ["forbidden_location", registerBody(home)],
        ["unknown_tracked_branch", registerBody(demo, { trackedBranch: "no-such-branch" })],
        [
          "unknown_environment_branch",
          registerBody(demo, {
            environments: [
              { name: "x", branch: "no-such", protected: false, autoDeploysOnMerge: false },
            ],
          }),
        ],
        [
          "duplicate_environment",
          registerBody(demo, {
            environments: [
              { name: "x", branch: "prod", protected: false, autoDeploysOnMerge: false },
              { name: "x", branch: "stage", protected: false, autoDeploysOnMerge: false },
            ],
          }),
        ],
      ];
      for (const [code, body] of cases) {
        const res = await send("POST", "/api/repos", body);
        expect([code, res.status, await res.json()]).toEqual([code, 400, { error: code }]);
      }
      // nested: registering inside an already registered repository
      expect(
        (await send("POST", "/api/repos", registerBody(outer, { name: "outer" }))).status,
      ).toBe(201);
      git(join(outer, "inner"), "init", "-q", "-b", "main");
      const nested = await send("POST", "/api/repos", registerBody(join(outer, "inner")));
      expect([nested.status, await nested.json()]).toEqual([400, { error: "nested" }]);
      expect(c.db.select().from(schema.repositories).all()).toHaveLength(1);
    });

    test("409 for already_registered and duplicate_name", async () => {
      const { path } = await register();
      const again = await send("POST", "/api/repos", registerBody(path, { name: "other" }));
      expect([again.status, await again.json()]).toEqual([409, { error: "already_registered" }]);
      const dup = await send("POST", "/api/repos", registerBody(makeDemoRepo(scratch())));
      expect([dup.status, await dup.json()]).toEqual([409, { error: "duplicate_name" }]);
    });

    test("id routes: unknown id is 404 (not_found), a bad update body is 400", async () => {
      const { repo } = await register();
      expect((await send("PUT", "/api/repos/nope", { notes: "x" })).status).toBe(404);
      expect((await call("/api/repos/nope", { method: "DELETE" })).status).toBe(404);
      const bad = await send("PUT", `/api/repos/${repo.id}`, { unknownField: 1 });
      expect([bad.status, await bad.json()]).toEqual([400, { error: "invalid_input" }]);
      const branch = await send("PUT", `/api/repos/${repo.id}`, { trackedBranch: "nope" });
      expect([branch.status, await branch.json()]).toEqual([
        400,
        { error: "unknown_tracked_branch" },
      ]);
      const dup = await send("PUT", `/api/repos/${repo.id}`, { name: "app" });
      expect(dup.status).toBe(200); // the same name is not a duplicate
    });

    test("responses never carry the repository path", async () => {
      const path = makeDemoRepo(scratch());
      const res = await send("POST", "/api/repos", registerBody(path, { trackedBranch: "nope" }));
      expect(await res.text()).not.toContain(path);
    });
  });
});

describe("projects, facts and milestones", () => {
  async function project() {
    const { repo } = await register();
    return { repo, projectId: repo.projectId as string };
  }

  test("GET /api/projects, /api/projects/:id and PUT", async () => {
    const { projectId, repo } = await project();
    const list = (await (await call("/api/projects")).json()) as { id: string; name: string }[];
    expect(list.map((p) => p.id)).toEqual([projectId]);
    const detail = (await (await call(`/api/projects/${projectId}`)).json()) as ProjectDetail;
    expect(detail.repositories.map((r) => r.id)).toEqual([repo.id]);
    expect(detail.jira.byAttention).toEqual({ overdue: 0, blocked: 0, due_soon: 0, stale: 0 });
    expect((await call("/api/projects/nope")).status).toBe(404);
    const put = await send("PUT", `/api/projects/${projectId}`, { summary: "S" });
    expect(put.status).toBe(200);
    expect((await send("PUT", "/api/projects/nope", { summary: "S" })).status).toBe(404);
    expect((await send("PUT", `/api/projects/${projectId}`, { bogus: 1 })).status).toBe(400);
  });

  test("add a fact (201, approved), accept and reject", async () => {
    const { projectId } = await project();
    const add = await send("POST", `/api/projects/${projectId}/facts`, {
      kind: "note",
      content: "Deploys on Fridays are banned.",
    });
    expect(add.status).toBe(201);
    expect(((await add.json()) as ProjectFactView).status).toBe("approved");
    expect(
      (await send("POST", `/api/projects/${projectId}/facts`, { kind: "note", content: "" }))
        .status,
    ).toBe(400);
    expect(
      (await send("POST", "/api/projects/nope/facts", { kind: "note", content: "x" })).status,
    ).toBe(404);

    const mk = (content: string) => {
      const id = `f-${content}`;
      c.db
        .insert(schema.projectFacts)
        .values({
          id,
          projectId,
          kind: "stack",
          content,
          evidence: [],
          status: "needs_review",
          source: "inspection",
          claudeRunId: null,
          supersedesId: null,
          headSha: null,
          createdAt: NOW,
          decidedAt: null,
        })
        .run();
      return id;
    };
    const a = mk("one");
    const b = mk("two");
    const acc = await send("POST", `/api/brain/facts/${a}/accept`, { content: "uno" });
    expect(acc.status).toBe(200);
    expect(await acc.json()).toMatchObject({ status: "approved", content: "uno" });
    // accept without any body
    const plain = await call(`/api/brain/facts/${b}/accept`, { method: "POST" });
    expect(plain.status).toBe(200);
    const c3 = mk("three");
    expect(
      ((await (await send("POST", `/api/brain/facts/${c3}/reject`)).json()) as ProjectFactView)
        .status,
    ).toBe("rejected");
    // failure paths
    expect((await send("POST", `/api/brain/facts/${a}/accept`)).status).toBe(409);
    expect((await send("POST", `/api/brain/facts/${c3}/reject`)).status).toBe(409);
    expect((await send("POST", "/api/brain/facts/nope/accept")).status).toBe(404);
    expect((await send("POST", "/api/brain/facts/nope/reject")).status).toBe(404);
    const d = mk("four");
    expect((await send("POST", `/api/brain/facts/${d}/accept`, { content: " " })).status).toBe(400);
    expect(
      c.db.select().from(schema.projectFacts).where(eq(schema.projectFacts.id, d)).get()?.status,
    ).toBe("needs_review");
  });

  test("milestone CRUD with project-scoped environments; upcoming", async () => {
    const { projectId, repo } = await project();
    const env = repo.environments[0]?.id as string;
    const create = await send("POST", `/api/projects/${projectId}/milestones`, {
      name: "Beta",
      targetDate: "2026-11-01",
      environmentId: env,
    });
    expect(create.status).toBe(201);
    const m = (await create.json()) as { id: string; overdue: boolean; environmentName: string };
    expect(m).toMatchObject({ overdue: true, environmentName: "prod" });
    const up = (await (await call("/api/brain/upcoming")).json()) as { name: string }[];
    expect(up.map((x) => x.name)).toEqual(["Beta"]);
    const put = await send("PUT", `/api/projects/${projectId}/milestones/${m.id}`, {
      status: "done",
    });
    expect(await put.json()).toMatchObject({ status: "done", overdue: false });
    expect((await (await call("/api/brain/upcoming")).json()) as unknown[]).toEqual([]);
    const list = await call(`/api/projects/${projectId}/milestones`);
    expect(((await list.json()) as unknown[]).length).toBe(1);
    expect(
      (await call(`/api/projects/${projectId}/milestones/${m.id}`, { method: "DELETE" })).status,
    ).toBe(204);
    expect(
      (await call(`/api/projects/${projectId}/milestones/${m.id}`, { method: "DELETE" })).status,
    ).toBe(404);
  });

  test("a milestone with another project's environment is a 400", async () => {
    const a = await project();
    const second = await send(
      "POST",
      "/api/repos",
      registerBody(makeDemoRepo(scratch()), { name: "second" }),
    );
    const other = (await second.json()) as RepositoryView;
    const res = await send("POST", `/api/projects/${a.projectId}/milestones`, {
      name: "X",
      targetDate: "2026-12-01",
      environmentId: other.environments[0]?.id,
    });
    expect([res.status, await res.json()]).toEqual([400, { error: "invalid_environment" }]);
    const bad = await send("POST", `/api/projects/${a.projectId}/milestones`, {
      name: "X",
      targetDate: "tomorrow",
    });
    expect(bad.status).toBe(400);
    expect(
      (await send("POST", "/api/projects/nope/milestones", { name: "X", targetDate: "2026-12-01" }))
        .status,
    ).toBe(404);
  });
});

describe("overview", () => {
  test("counts.brainReview and the next three upcoming milestones", async () => {
    const { repo } = await register();
    const projectId = repo.projectId as string;
    c.db
      .insert(schema.projectFacts)
      .values({
        id: "f1",
        projectId,
        kind: "note",
        content: "x",
        evidence: [],
        status: "needs_review",
        source: "inspection",
        claudeRunId: null,
        supersedesId: null,
        headSha: null,
        createdAt: NOW,
        decidedAt: null,
      })
      .run();
    for (const [i, d] of ["2026-11-20", "2026-11-10", "2026-11-12", "2026-11-15"].entries()) {
      await send("POST", `/api/projects/${projectId}/milestones`, { name: `m${i}`, targetDate: d });
    }
    const o = (await (await call("/api/dashboard/overview")).json()) as DashboardOverview;
    expect(o.counts.brainReview).toBe(1);
    expect(o.upcoming.map((m) => m.name)).toEqual(["m1", "m2", "m3"]);
    expect(o.upcoming[0]?.projectName).toBe("app");
  });
});
