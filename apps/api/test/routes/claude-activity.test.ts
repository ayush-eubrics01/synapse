import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import type { AIProvider, ClaudeActivityView, DashboardOverview } from "@synapse/contracts";
import { schema } from "@synapse/database";
import { createApp } from "../../src/app";
import { type Container, createContainer } from "../../src/container";
import { loadConfig } from "../../src/core/config/config";
import { encodeProjectDir } from "../../src/modules/claude-activity/session-meta";
import { SENTINEL, sessionLine, writeSession } from "../fixtures/claude-sessions";
import { tempDir } from "../fixtures/git-repo";

const fakeProvider: AIProvider = {
  execute: async () => {
    throw new Error("fake provider must not execute");
  },
  getHealth: async () => ({ status: "ok", version: "fake" }),
};
const NOW = "2026-11-06T12:00:00.000Z";
const nowMs = Date.parse(NOW);
const ago = (min: number) => new Date(nowMs - min * 60_000).toISOString();
const DAY = 1440;

const roots: string[] = [];
afterAll(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

let c: Container;
let app: ReturnType<typeof createApp>;
let projects: string;
let repoRoot: string;

beforeEach(() => {
  projects = tempDir("synapse-act-proj-");
  repoRoot = tempDir("synapse-act-repos-");
  roots.push(projects, repoRoot);
  c = createContainer(loadConfig({ SYNAPSE_DB_PATH: ":memory:" }), {
    run: async () => "Linger=no",
    provider: fakeProvider,
    clock: { now: () => new Date(NOW) },
    claudeProjectsDir: projects,
  });
  app = createApp(c);
});
afterEach(() => c.sqlite.close());

const get = (path: string) => app.request(`http://127.0.0.1:7400${path}`);

function addRepo(name: string): string {
  const path = join(repoRoot, name);
  mkdirSync(path, { recursive: true });
  c.db
    .insert(schema.repositories)
    .values({
      id: `repo-${name}`,
      name,
      localPath: path,
      upstreamPushDisabled: false,
      trackedBranch: "main",
      jiraProjectKeys: [],
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run();
  return `repo-${name}`;
}

let n = 0;
function addSession(repositoryId: string, minAgo: number, title = "Demo title") {
  n++;
  const sessionId = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  c.db
    .insert(schema.claudeSessions)
    .values({
      sessionId,
      repositoryId,
      cwd: "/x",
      gitBranch: "feature-x",
      title,
      firstAt: ago(minAgo + 5),
      lastAt: ago(minAgo),
      version: null,
      entrypoint: "cli",
      filePath: `/x/${sessionId}.jsonl`,
      fileOffset: 0,
      fileSize: 0,
      fileMtimeMs: 0,
      updatedAt: NOW,
    })
    .run();
  return sessionId;
}

function addPr(repositoryId: string, sessionId: string, num: number, minAgo: number) {
  const url = `https://github.com/demo-org/demo-app/pull/${num}`;
  c.db
    .insert(schema.claudeSessionPrs)
    .values({
      id: `pr-${num}`,
      sessionId,
      repositoryId,
      prUrl: url,
      prNumber: num,
      prRepository: "demo-org/demo-app",
      gitBranch: "feature-x",
      firstSeenAt: ago(minAgo),
    })
    .run();
  return url;
}

describe("GET /api/claude/activity", () => {
  test("returns the A11 shape: caps, 14-day window, task link, active now", async () => {
    const a = addRepo("demo-app");
    const b = addRepo("demo-api");
    for (let i = 0; i < 12; i++) addSession(a, 30 + i);
    const live = addSession(a, 3);
    addSession(a, 15 * DAY);
    const old = addSession(b, 20 * DAY);
    const url = addPr(a, live, 7, 10);
    addPr(b, old, 8, 20 * DAY);
    c.db
      .insert(schema.engineeringTasks)
      .values({
        id: "task-1",
        repositoryId: a,
        source: "manual",
        title: "Demo task",
        draftDescription: "d",
        status: "completed",
        prUrl: url,
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();

    const r = await get("/api/claude/activity");
    expect(r.status).toBe(200);
    const v = (await r.json()) as ClaudeActivityView;
    expect(v).toMatchObject({ enabled: true, active: true, yielding: true, lastActiveAt: ago(3) });
    expect(v.health).toEqual({ state: "ok", message: null });
    // demo-api has only a 20-day-old session and PR: no entry.
    expect(v.repositories.map((x) => x.name)).toEqual(["demo-app"]);
    const repo = v.repositories[0] as ClaudeActivityView["repositories"][number];
    expect(repo.sessions).toHaveLength(10);
    expect(repo.sessions[0]).toEqual({
      sessionId: live,
      title: "Demo title",
      branch: "feature-x",
      firstAt: ago(8),
      lastAt: ago(3),
      activeNow: true,
      entrypoint: "cli",
    });
    expect(repo.sessions[1]?.activeNow).toBe(false);
    expect(repo.prs).toEqual([
      {
        url,
        number: 7,
        repository: "demo-org/demo-app",
        branch: "feature-x",
        firstSeenAt: ago(10),
        engineeringTaskId: "task-1",
      },
    ]);
  });

  test("a PR with no matching task carries no engineeringTaskId", async () => {
    const a = addRepo("demo-app");
    addPr(a, addSession(a, 60), 9, 60);
    const v = (await (await get("/api/claude/activity")).json()) as ClaudeActivityView;
    expect(v.repositories[0]?.prs[0]).not.toHaveProperty("engineeringTaskId");
  });

  test("idle: nothing recent, not active, not yielding", async () => {
    const v = (await (await get("/api/claude/activity")).json()) as ClaudeActivityView;
    expect(v).toMatchObject({ active: false, yielding: false, lastActiveAt: null });
    expect(v.repositories).toEqual([]);
  });

  test("the response body never contains session content (sentinel)", async () => {
    const a = addRepo("demo-app");
    const path = join(repoRoot, "demo-app");
    const file = writeSession(
      join(projects, encodeProjectDir(path)),
      "00000000-0000-4000-8000-0000000000aa",
      [
        sessionLine("last-prompt", { lastPrompt: SENTINEL }),
        sessionLine("user", {
          cwd: path,
          gitBranch: "feature-x",
          timestamp: ago(4),
          message: { role: "user", content: SENTINEL },
        }),
        sessionLine("ai-title", { aiTitle: "Demo title" }),
        sessionLine("assistant", { timestamp: ago(3), message: SENTINEL }),
      ],
    );
    const t = new Date(nowMs - 3 * 60_000);
    utimesSync(file, t, t);
    await c.claudeActivity.scan();
    const text = await (await get("/api/claude/activity")).text();
    expect(text).toContain("Demo title");
    expect(text).not.toContain("SENTINEL");
    expect(a).toBeTruthy();
  });
});

describe("overview.claudeActivity", () => {
  const overview = async () =>
    (await (await get("/api/dashboard/overview")).json()) as DashboardOverview;

  test("counts today's sessions; yielding follows yieldWhenActive", async () => {
    const a = addRepo("demo-app");
    addSession(a, 2);
    addSession(a, 5);
    addSession(a, 3 * DAY);
    const o1 = await overview();
    expect(o1.claudeActivity).toEqual({ active: true, sessionsToday: 2, yielding: true });
    c.settings.set("claudeActivity.yieldWhenActive", false);
    const o2 = await overview();
    expect(o2.claudeActivity).toEqual({ active: true, sessionsToday: 2, yielding: false });
  });
});
