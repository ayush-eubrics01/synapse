import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type {
  AIProvider,
  DashboardOverview,
  EngineeringTaskDetail,
  EngineeringTaskView,
  RepositoryView,
} from "@synapse/contracts";
import { schema } from "@synapse/database";
import { eq } from "drizzle-orm";
import { createApp } from "../../src/app";
import { type Container, createContainer } from "../../src/container";
import { loadConfig } from "../../src/core/config/config";
import { EngineeringTaskError } from "../../src/modules/engineering-tasks/service";
import { makeDemoRepo, tempDir } from "../fixtures/git-repo";

const fakeProvider: AIProvider = {
  execute: async () => {
    throw new Error("fake provider must not execute");
  },
  getHealth: async () => ({ status: "ok", version: "fake" }),
};
const NOW = "2026-11-06T12:00:00.000Z";
const DIFF_MARKER = "DIFF-MARKER-route-91";

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
let repo: RepositoryView;
let repoPath: string;
beforeEach(async () => {
  c = createContainer(loadConfig({ SYNAPSE_DB_PATH: ":memory:" }), {
    run: async () => "Linger=no",
    provider: fakeProvider,
    clock: { now: () => new Date(NOW) },
  });
  app = createApp(c);
  repoPath = makeDemoRepo(scratch());
  const res = await send("POST", "/api/repos", {
    path: repoPath,
    name: "app",
    trackedBranch: "main",
    environments: [{ name: "prod", branch: "prod", protected: true, autoDeploysOnMerge: false }],
    jiraProjectKeys: ["DEMO"],
  });
  expect(res.status).toBe(201);
  repo = (await res.json()) as RepositoryView;
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

async function createTask(over: object = {}): Promise<EngineeringTaskDetail> {
  const res = await send("POST", "/api/engineering/tasks", {
    repositoryId: repo.id,
    title: "Fix redirect",
    draftDescription: "draft text",
    ...over,
  });
  expect(res.status).toBe(201);
  return (await res.json()) as EngineeringTaskDetail;
}

const PLAN = {
  summary: "Fix the redirect.",
  plan: [{ step: "Change the handler" }],
  filesLikelyTouched: ["src/index.ts"],
  testCommand: "bun test",
  risk: "low",
  size: "s",
  unclear: [],
};
/** A task in `planned`, as the investigation leaves it. */
async function plannedTask(): Promise<string> {
  const t = await createTask();
  c.sqlite.run(
    "update engineering_tasks set status='planned', approved_description='ok', plan=? where id=?",
    [JSON.stringify(PLAN), t.id],
  );
  return t.id;
}
const approvePlanBody = (over: object = {}) => ({
  parentBranch: "main",
  testCommand: "bun test",
  ...over,
});

describe("create and read", () => {
  test("POST creates a proposed task; GET list filters by status and carries no description text", async () => {
    const t = await createTask();
    expect(t.status).toBe("proposed");
    const all = (await (await call("/api/engineering/tasks")).json()) as EngineeringTaskView[];
    expect(all.map((x) => x.id)).toEqual([t.id]);
    expect(JSON.stringify(all)).not.toContain("draft text");
    const none = await call("/api/engineering/tasks?status=queued");
    expect(await none.json()).toEqual([]);
    expect((await call("/api/engineering/tasks?status=bogus")).status).toBe(400);
  });

  test("GET :id returns the steps with their outputs; the list never does", async () => {
    const t = await createTask();
    c.engineering.approveDescription(t.id, "approved");
    c.sqlite.run(
      "update engineering_task_steps set output=? where task_id=? and step='investigate'",
      [JSON.stringify({ diff: DIFF_MARKER, testOutputTail: "TAIL-91" }), t.id],
    );
    const d = (await (
      await call(`/api/engineering/tasks/${t.id}`)
    ).json()) as EngineeringTaskDetail;
    expect(d.steps.map((s) => s.step)).toEqual(["investigate"]);
    expect(JSON.stringify(d.steps[0]?.output)).toContain(DIFF_MARKER);
    const list = await (await call("/api/engineering/tasks")).text();
    expect(list).not.toContain(DIFF_MARKER);
    expect(list).not.toContain("TAIL-91");
    expect((await call("/api/engineering/tasks/nope")).status).toBe(404);
  });

  test("create validates the body (400) and the repository (404)", async () => {
    expect((await send("POST", "/api/engineering/tasks", { title: "x" })).status).toBe(400);
    const bad = await send("POST", "/api/engineering/tasks", {
      repositoryId: "nope",
      title: "x",
      draftDescription: "y",
    });
    expect(bad.status).toBe(404);
    expect(await bad.json()).toEqual({ error: "not_found" });
  });
});

describe("from-jira and from-slack", () => {
  const jira = (key: string, project = "DEMO") =>
    c.db
      .insert(schema.jiraIssues)
      .values({
        key,
        jiraId: `id-${key}`,
        projectKey: project,
        summary: "Login redirect loops",
        statusName: "To Do",
        statusCategory: "new",
        issueType: "Bug",
        labels: [],
        jiraCreatedAt: NOW,
        jiraUpdatedAt: NOW,
        webUrl: `https://example.atlassian.net/browse/${key}`,
        inScope: true,
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      })
      .run();
  const slack = (id: string, text: string) => {
    c.db
      .insert(schema.slackConversations)
      .values({ id: "c1", externalId: "C1", type: "channel", name: "eng" })
      .onConflictDoNothing()
      .run();
    c.db
      .insert(schema.slackUsers)
      .values({ id: "u1", externalId: "U1", name: "Dee" })
      .onConflictDoNothing()
      .run();
    c.db
      .insert(schema.slackMessages)
      .values({
        id,
        conversationId: "c1",
        ts: `1700000000.${id}`,
        senderUserId: "u1",
        text,
        sentAt: NOW,
        collectedAt: NOW,
      })
      .run();
  };

  test("from-jira maps the project's repository; unknown key is 404", async () => {
    jira("DEMO-7");
    const res = await send("POST", "/api/engineering/tasks/from-jira", { key: "DEMO-7" });
    expect(res.status).toBe(201);
    const t = (await res.json()) as EngineeringTaskDetail;
    expect(t).toMatchObject({ source: "jira", sourceRef: "DEMO-7", repositoryId: repo.id });
    const nf = await send("POST", "/api/engineering/tasks/from-jira", { key: "NOPE-1" });
    expect(nf.status).toBe(404);
    expect((await send("POST", "/api/engineering/tasks/from-jira", {})).status).toBe(400);
  });

  test("from-slack copies the text; unknown message is 404", async () => {
    slack("m1", "please fix the redirect");
    const res = await send("POST", "/api/engineering/tasks/from-slack", { messageId: "m1" });
    expect(res.status).toBe(201);
    expect(((await res.json()) as EngineeringTaskDetail).source).toBe("slack");
    const nf = await send("POST", "/api/engineering/tasks/from-slack", { messageId: "nope" });
    expect(nf.status).toBe(404);
  });

  test("two repositories and no repositoryId: 400 ambiguous_repository; with one it works", async () => {
    const other = await send("POST", "/api/repos", {
      path: makeDemoRepo(scratch(), "other"),
      name: "other",
      trackedBranch: "main",
      environments: [],
      jiraProjectKeys: [],
    });
    expect(other.status).toBe(201);
    slack("m1", "do the thing");
    jira("ZZZ-1", "ZZZ");
    for (const [path, body] of [
      ["from-slack", { messageId: "m1" }],
      ["from-jira", { key: "ZZZ-1" }],
    ] as const) {
      const res = await send("POST", `/api/engineering/tasks/${path}`, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "ambiguous_repository" });
    }
    const ok = await send("POST", "/api/engineering/tasks/from-slack", {
      messageId: "m1",
      repositoryId: repo.id,
    });
    expect(ok.status).toBe(201);
    const nf = await send("POST", "/api/engineering/tasks/from-slack", {
      messageId: "m1",
      repositoryId: "nope",
    });
    expect(nf.status).toBe(404);
  });
});

describe("approve-description", () => {
  test("enqueues the investigation and moves the task to investigating", async () => {
    const t = await createTask();
    const res = await send("POST", `/api/engineering/tasks/${t.id}/approve-description`, {
      description: "Fix the redirect.",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as EngineeringTaskDetail).status).toBe("investigating");
    expect(
      c.db.select().from(schema.jobs).where(eq(schema.jobs.type, "engineering.investigate")).all(),
    ).toHaveLength(1);
  });

  test("empty description is 400, unknown id is 404, a wrong state is 400 invalid_state", async () => {
    const t = await createTask();
    const bad = await send("POST", `/api/engineering/tasks/${t.id}/approve-description`, {
      description: "",
    });
    expect(bad.status).toBe(400);
    const nf = await send("POST", "/api/engineering/tasks/nope/approve-description", {
      description: "x",
    });
    expect(nf.status).toBe(404);
    c.sqlite.run("update engineering_tasks set status='completed' where id=?", [t.id]);
    const st = await send("POST", `/api/engineering/tasks/${t.id}/approve-description`, {
      description: "x",
    });
    expect(st.status).toBe(400);
    expect(await st.json()).toEqual({ error: "invalid_state" });
  });
});

describe("approve-plan error mapping", () => {
  test("success queues the task with its branches", async () => {
    const id = await plannedTask();
    const res = await send("POST", `/api/engineering/tasks/${id}/approve-plan`, approvePlanBody());
    expect(res.status).toBe(200);
    const t = (await res.json()) as EngineeringTaskDetail;
    expect(t).toMatchObject({ status: "queued", parentBranch: "main" });
    expect(t.taskBranch).toBeTruthy();
  });

  test("400 for protected_branch, unknown_branch, unsafe_test_command, invalid_state, invalid_input", async () => {
    const id = await plannedTask();
    const post = (body: unknown, tid = id) =>
      send("POST", `/api/engineering/tasks/${tid}/approve-plan`, body);
    const expectErr = async (res: Response, status: number, error: string) => {
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error });
    };
    await expectErr(await post(approvePlanBody({ parentBranch: "prod" })), 400, "protected_branch");
    await expectErr(
      await post(approvePlanBody({ parentBranch: "nope-branch" })),
      400,
      "unknown_branch",
    );
    await expectErr(
      await post(approvePlanBody({ testCommand: "bun test && rm -rf /" })),
      400,
      "unsafe_test_command",
    );
    await expectErr(
      await post(approvePlanBody({ environmentId: "nope" })),
      400,
      "unknown_environment",
    );
    await expectErr(
      await post(approvePlanBody({ rememberAsTracked: "yes" })),
      400,
      "invalid_input",
    );
    const fresh = await createTask();
    await expectErr(await post(approvePlanBody(), fresh.id), 400, "invalid_state");
  });

  test("404 for an unknown task", async () => {
    const res = await send("POST", "/api/engineering/tasks/nope/approve-plan", approvePlanBody());
    expect(res.status).toBe(404);
  });

  test("400 registry_error:* when the registry refuses the tracked-branch update", async () => {
    const id = await plannedTask();
    c.engineering.approvePlan = async () => {
      throw new EngineeringTaskError("registry_error:invalid_tracked_branch");
    };
    const res = await send("POST", `/api/engineering/tasks/${id}/approve-plan`, approvePlanBody());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "registry_error:invalid_tracked_branch" });
  });

  test("409 when the repository path is no longer available", async () => {
    const id = await plannedTask();
    rmSync(repoPath, { recursive: true, force: true });
    const res = await send("POST", `/api/engineering/tasks/${id}/approve-plan`, approvePlanBody());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "path_unavailable" });
  });
});

describe("cleanup in the list (H2)", () => {
  test("a cancelled task's cleanup has exactly the four fixed keys and no branch name", async () => {
    const t = await createTask();
    await send("POST", `/api/engineering/tasks/${t.id}/cancel`);
    c.db
      .update(schema.engineeringTasks)
      .set({ taskBranch: "synapse/BRANCH-MARKER" })
      .where(eq(schema.engineeringTasks.id, t.id))
      .run();
    c.db
      .insert(schema.engineeringTaskSteps)
      .values({
        id: "s-cleanup",
        taskId: t.id,
        step: "cleanup",
        status: "done",
        output: { git: true, deleted: false, outcome: "branch_kept" },
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
    const res = await send("GET", "/api/engineering/tasks");
    const body = (await res.json()) as EngineeringTaskView[];
    const cleanup = body.find((x) => x.id === t.id)?.cleanup;
    expect(Object.keys(cleanup ?? {}).sort()).toEqual([
      "branchKept",
      "dirtyTree",
      "priorStatus",
      "pushedNotPr",
    ]);
    expect(cleanup?.branchKept).toBe(true);
    expect(JSON.stringify(cleanup)).not.toContain("BRANCH-MARKER");
  });
});

describe("cancel, lock and overview", () => {
  test("cancel cancels; a second cancel is 400; unknown is 404", async () => {
    const t = await createTask();
    const res = await send("POST", `/api/engineering/tasks/${t.id}/cancel`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as EngineeringTaskDetail).status).toBe("cancelled");
    expect((await send("POST", `/api/engineering/tasks/${t.id}/cancel`)).status).toBe(400);
    expect((await send("POST", "/api/engineering/tasks/nope/cancel")).status).toBe(404);
  });

  test("GET /api/engineering/lock reports free, then held by the picked-up task", async () => {
    expect(await (await call("/api/engineering/lock")).json()).toEqual({ held: false });
    const id = await plannedTask();
    expect(c.engineeringLock.acquire(id)).toBe(true);
    const l = (await (await call("/api/engineering/lock")).json()) as {
      held: boolean;
      taskId?: string;
      since?: string;
    };
    expect(l).toMatchObject({ held: true, taskId: id });
    expect(l.since).toBeTruthy();
  });

  test("overview: engineeringAwaiting counts awaiting_approval plus needs_attention; the lock carries the title", async () => {
    const overview = async () =>
      (await (await call("/api/dashboard/overview")).json()) as DashboardOverview;
    expect((await overview()).counts.engineeringAwaiting).toBe(0);
    expect((await overview()).engineeringLock).toEqual({ held: false });
    const a = await createTask({ title: "Task A" });
    const b = await createTask({ title: "Task B" });
    const d = await createTask({ title: "Task D" });
    c.sqlite.run("update engineering_tasks set status='awaiting_approval' where id=?", [a.id]);
    c.sqlite.run("update engineering_tasks set status='needs_attention' where id=?", [b.id]);
    c.sqlite.run("update engineering_tasks set status='queued' where id=?", [d.id]);
    expect((await overview()).counts.engineeringAwaiting).toBe(2);
    c.engineeringLock.acquire(a.id);
    const o = await overview();
    expect(o.engineeringLock).toMatchObject({ held: true, taskId: a.id, taskTitle: "Task A" });
    expect(o.engineeringLock.since).toBeTruthy();
  });
});

describe("approval text edit and retry-merge routes (F2.1, F3.2)", () => {
  test("invalid bodies are 400 invalid_input; unknown approval or task is 404", async () => {
    const t = await createTask();
    const base = `/api/engineering/tasks/${t.id}/approvals/nope`;
    expect((await send("PUT", base, {})).status).toBe(404);
    expect((await send("PUT", base, { commitMessage: 5 })).status).toBe(400);
    expect((await send("PUT", base, { nope: "x" })).status).toBe(400);
    const res = await send("PUT", base, { commitMessage: "Fix add" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    const r = await send("POST", `/api/engineering/tasks/${t.id}/retry-merge`);
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "invalid_state" });
    expect((await send("POST", "/api/engineering/tasks/nope/retry-merge")).status).toBe(404);
  });
});
