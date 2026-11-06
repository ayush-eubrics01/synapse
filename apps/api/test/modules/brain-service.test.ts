import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AIProvider } from "@synapse/contracts";
import { schema } from "@synapse/database";
import { eq } from "drizzle-orm";
import { type Container, createContainer } from "../../src/container";
import { loadConfig } from "../../src/core/config/config";
import { BrainError, BrainService } from "../../src/modules/engineering-brain/service";

const fakeProvider: AIProvider = {
  execute: async () => {
    throw new Error("fake provider must not execute");
  },
  getHealth: async () => ({ status: "ok", version: "fake" }),
};
const NOW = "2026-11-06T12:00:00.000Z";

let c: Container;
beforeEach(() => {
  c = createContainer(loadConfig({ SYNAPSE_DB_PATH: ":memory:" }), {
    run: async () => "Linger=no",
    provider: fakeProvider,
    clock: { now: () => new Date(NOW) },
  });
});
afterEach(() => c.sqlite.close());

let n = 0;
const uid = (p: string) => `${p}-${++n}`;

/** A project with one repository (and optionally environments and Jira keys), inserted directly. */
function seedProject(name: string, opts: { jiraKeys?: string[]; envs?: string[] } = {}) {
  const projectId = uid("p");
  const repoId = uid("r");
  c.db
    .insert(schema.projects)
    .values({ id: projectId, name, summary: null, createdAt: NOW, updatedAt: NOW })
    .run();
  c.db
    .insert(schema.repositories)
    .values({
      id: repoId,
      name,
      localPath: `/srv/demo/${name}`,
      originUrl: null,
      upstreamUrl: null,
      upstreamPushDisabled: false,
      trackedBranch: "main",
      jiraProjectKeys: opts.jiraKeys ?? [],
      notes: null,
      headSha: null,
      inspectedHeadSha: null,
      drift: null,
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run();
  c.db.insert(schema.projectRepositories).values({ projectId, repositoryId: repoId }).run();
  const envIds: Record<string, string> = {};
  for (const e of opts.envs ?? []) {
    const id = uid("e");
    envIds[e] = id;
    c.db
      .insert(schema.repositoryEnvironments)
      .values({
        id,
        repositoryId: repoId,
        name: e,
        branch: e,
        protected: false,
        autoDeploysOnMerge: false,
        notes: null,
      })
      .run();
  }
  return { projectId, repoId, envIds };
}

function seedFact(projectId: string, over: Partial<typeof schema.projectFacts.$inferInsert> = {}) {
  const id = uid("f");
  c.db
    .insert(schema.projectFacts)
    .values({
      id,
      projectId,
      kind: "stack",
      content: "Written in TypeScript.",
      evidence: [{ path: "package.json" }],
      status: "needs_review",
      source: "inspection",
      claudeRunId: null,
      supersedesId: null,
      headSha: null,
      createdAt: NOW,
      decidedAt: null,
      ...over,
    })
    .run();
  return id;
}

const factRow = (id: string) =>
  c.db.select().from(schema.projectFacts).where(eq(schema.projectFacts.id, id)).get();
const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return e instanceof BrainError ? e.code : `other:${String(e)}`;
  }
  return undefined;
};

describe("fact review (C9)", () => {
  test("accept approves, and the older approved equivalent becomes outdated with supersedes_id", () => {
    const { projectId } = seedProject("app");
    const old = seedFact(projectId, { status: "approved", decidedAt: NOW });
    const fresh = seedFact(projectId, { content: "  written in  TYPESCRIPT. " });
    const view = c.brain.acceptFact(fresh);
    expect(view.status).toBe("approved");
    expect(view.supersedesId).toBe(old);
    expect(view.decidedAt).toBe(NOW);
    expect(factRow(old)?.status).toBe("outdated");
    expect(factRow(fresh)?.supersedesId).toBe(old);
  });

  test("a different kind with the same content is not superseded", () => {
    const { projectId } = seedProject("app");
    const other = seedFact(projectId, { kind: "note", status: "approved" });
    const fresh = seedFact(projectId);
    expect(c.brain.acceptFact(fresh).supersedesId).toBeNull();
    expect(factRow(other)?.status).toBe("approved");
  });

  test("accept with edited content stores the edit", () => {
    const { projectId } = seedProject("app");
    const id = seedFact(projectId);
    const view = c.brain.acceptFact(id, { content: "Written in Bun and TypeScript." });
    expect(view.content).toBe("Written in Bun and TypeScript.");
    expect(factRow(id)?.content).toBe("Written in Bun and TypeScript.");
  });

  test("an edit that now matches an approved fact supersedes it", () => {
    const { projectId } = seedProject("app");
    const old = seedFact(projectId, { content: "Uses SQLite.", status: "approved" });
    const id = seedFact(projectId, { content: "Uses a database." });
    expect(c.brain.acceptFact(id, { content: "uses sqlite." }).supersedesId).toBe(old);
    expect(factRow(old)?.status).toBe("outdated");
  });

  test("reject sets rejected", () => {
    const { projectId } = seedProject("app");
    const id = seedFact(projectId);
    expect(c.brain.rejectFact(id).status).toBe("rejected");
    expect(factRow(id)?.decidedAt).toBe(NOW);
  });

  test("failure paths: unknown fact, already decided, empty or oversized edit", () => {
    const { projectId } = seedProject("app");
    const decided = seedFact(projectId, { status: "approved" });
    const pending = seedFact(projectId, { content: "Another." });
    expect(codeOf(() => c.brain.acceptFact("nope"))).toBe("not_found");
    expect(codeOf(() => c.brain.rejectFact("nope"))).toBe("not_found");
    expect(codeOf(() => c.brain.acceptFact(decided))).toBe("invalid_state");
    expect(codeOf(() => c.brain.rejectFact(decided))).toBe("invalid_state");
    expect(codeOf(() => c.brain.acceptFact(pending, { content: "   " }))).toBe("invalid_input");
    expect(codeOf(() => c.brain.acceptFact(pending, { content: "x".repeat(401) }))).toBe(
      "invalid_input",
    );
    expect(factRow(pending)?.status).toBe("needs_review");
  });

  test("the event and audit row carry ids only, never fact text", () => {
    const { projectId } = seedProject("app");
    const old = seedFact(projectId, { content: "SECRETWORD one", status: "approved" });
    const id = seedFact(projectId, { content: "secretword ONE" });
    c.brain.acceptFact(id);
    const ev = c.db
      .select()
      .from(schema.domainEvents)
      .where(eq(schema.domainEvents.type, "brain.fact_decided"))
      .all();
    expect(ev).toHaveLength(1);
    expect(ev[0]?.payload).toEqual({ factId: id, status: "approved" });
    const audit = c.db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, "fact.accepted"))
      .all();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.details).toMatchObject({ factId: id, projectId, supersededId: old });
    expect(JSON.stringify([ev, audit]).toLowerCase()).not.toContain("secretword");
  });

  test("a user-added fact is approved immediately and skips review", () => {
    const { projectId } = seedProject("app");
    const view = c.brain.addFact(projectId, { kind: "convention", content: "Squash merges." });
    expect(view).toMatchObject({ status: "approved", source: "user", decidedAt: NOW });
    expect(c.brain.reviewCount()).toBe(0);
    expect(c.brain.getProject(projectId)?.factsNeedingReview).toBe(0);
  });

  test("addFact failure paths: unknown project, bad kind, empty content", () => {
    const { projectId } = seedProject("app");
    expect(codeOf(() => c.brain.addFact("nope", { kind: "note", content: "x" }))).toBe("not_found");
    expect(codeOf(() => c.brain.addFact(projectId, { kind: "bogus" as never, content: "x" }))).toBe(
      "invalid_input",
    );
    expect(codeOf(() => c.brain.addFact(projectId, { kind: "note", content: " " }))).toBe(
      "invalid_input",
    );
  });

  test("reviewCount spans projects", () => {
    const a = seedProject("a");
    const b = seedProject("b");
    seedFact(a.projectId);
    seedFact(b.projectId);
    seedFact(b.projectId, { content: "x", status: "rejected" });
    expect(c.brain.reviewCount()).toBe(2);
  });
});

describe("milestones (C10)", () => {
  test("create with an environment of the project's repository, update and delete", () => {
    const { projectId, envIds } = seedProject("app", { envs: ["stage", "prod"] });
    const m = c.brain.createMilestone(projectId, {
      name: "Beta",
      targetDate: "2026-11-20",
      environmentId: envIds.prod,
      status: "planned",
    });
    expect(m).toMatchObject({ environmentName: "prod", overdue: false, status: "planned" });
    const u = c.brain.updateMilestone(projectId, m.id, {
      name: "Beta 2",
      environmentId: envIds.stage,
      notes: "moved",
    });
    expect(u).toMatchObject({ name: "Beta 2", environmentName: "stage", notes: "moved" });
    expect(c.brain.updateMilestone(projectId, m.id, { environmentId: null }).environmentName).toBe(
      null,
    );
    c.brain.deleteMilestone(projectId, m.id);
    expect(c.brain.listMilestones(projectId)).toEqual([]);
  });

  test("an environment from another project is refused, on create and on update", () => {
    const a = seedProject("a", { envs: ["prod"] });
    const b = seedProject("b", { envs: ["prod"] });
    expect(
      codeOf(() =>
        c.brain.createMilestone(a.projectId, {
          name: "X",
          targetDate: "2026-12-01",
          environmentId: b.envIds.prod,
          status: "planned",
        }),
      ),
    ).toBe("invalid_environment");
    const m = c.brain.createMilestone(a.projectId, {
      name: "X",
      targetDate: "2026-12-01",
      status: "planned",
    });
    expect(
      codeOf(() => c.brain.updateMilestone(a.projectId, m.id, { environmentId: b.envIds.prod })),
    ).toBe("invalid_environment");
    expect(
      codeOf(() => c.brain.updateMilestone(a.projectId, m.id, { environmentId: "missing" })),
    ).toBe("invalid_environment");
  });

  test("failure paths: bad date, unknown project, milestone of another project", () => {
    const a = seedProject("a");
    const b = seedProject("b");
    expect(
      codeOf(() =>
        c.brain.createMilestone(a.projectId, { name: "X", targetDate: "soon", status: "planned" }),
      ),
    ).toBe("invalid_input");
    expect(
      codeOf(() =>
        c.brain.createMilestone("nope", { name: "X", targetDate: "2026-12-01", status: "planned" }),
      ),
    ).toBe("not_found");
    const m = c.brain.createMilestone(a.projectId, {
      name: "X",
      targetDate: "2026-12-01",
      status: "planned",
    });
    expect(codeOf(() => c.brain.updateMilestone(b.projectId, m.id, { name: "Y" }))).toBe(
      "not_found",
    );
    expect(codeOf(() => c.brain.deleteMilestone(b.projectId, m.id))).toBe("not_found");
    expect(
      codeOf(() => c.brain.updateMilestone(a.projectId, m.id, { status: "bogus" as never })),
    ).toBe("invalid_input");
  });

  test("upcoming: planned only, within the window, sorted, overdue flagged, with environment name", () => {
    const { projectId, envIds } = seedProject("app", { envs: ["prod"] });
    const mk = (name: string, targetDate: string, over: object = {}) =>
      c.brain.createMilestone(projectId, { name, targetDate, status: "planned", ...over });
    mk("late", "2026-11-01");
    mk("soon", "2026-11-10", { environmentId: envIds.prod });
    mk("edge", "2026-12-06"); // exactly 30 days out: included
    mk("far", "2026-12-07"); // 31 days: outside
    mk("finished", "2026-11-08", { status: "done" });
    const up = c.brain.upcoming();
    expect(up.map((m) => m.name)).toEqual(["late", "soon", "edge"]);
    expect(up[0]).toMatchObject({ overdue: true, projectName: "app" });
    expect(up[1]).toMatchObject({ overdue: false, environmentName: "prod" });
    c.settings.set("brain.upcoming.days", 7);
    expect(c.brain.upcoming().map((m) => m.name)).toEqual(["late", "soon"]);
  });

  test("today and the horizon are local calendar dates, not UTC ones", () => {
    const { projectId } = seedProject("app");
    // 20:00 UTC on the 6th is already 01:30 on the 7th in Kolkata.
    const late = new Date("2026-11-06T20:00:00.000Z");
    const inZone = (timeZone: string) =>
      new BrainService({
        db: c.db,
        clock: { now: () => late },
        settings: c.settings,
        audit: c.audit,
        events: c.events,
        registry: { get: () => null },
        inspections: { requestInspection: () => ({ status: "not_found" }) },
        timeZone,
      });
    c.brain.createMilestone(projectId, {
      name: "due6",
      targetDate: "2026-11-06",
      status: "planned",
    });
    c.brain.createMilestone(projectId, {
      name: "due8",
      targetDate: "2026-11-08",
      status: "planned",
    });
    c.settings.set("brain.upcoming.days", 1);
    const utc = inZone("UTC").upcoming();
    expect(utc.map((m) => [m.name, m.overdue])).toEqual([["due6", false]]);
    const ist = inZone("Asia/Kolkata").upcoming();
    expect(ist.map((m) => [m.name, m.overdue])).toEqual([
      ["due6", true],
      ["due8", false],
    ]);
  });

  test("a done milestone is never overdue", () => {
    const { projectId } = seedProject("app");
    const m = c.brain.createMilestone(projectId, {
      name: "old",
      targetDate: "2026-01-01",
      status: "done",
    });
    expect(m.overdue).toBe(false);
  });
});

describe("projects and the Jira summary (C11)", () => {
  const issue = (key: string, projectKey: string, over: object = {}) =>
    c.db
      .insert(schema.jiraIssues)
      .values({
        key,
        jiraId: key,
        projectKey,
        summary: `Synthetic ${key}`,
        statusName: "In Progress",
        statusCategory: "indeterminate",
        priority: null,
        issueType: "Task",
        labels: [],
        dueDate: null,
        jiraCreatedAt: NOW,
        jiraUpdatedAt: NOW,
        webUrl: "https://example.invalid/x",
        inScope: true,
        firstSeenAt: NOW,
        lastSeenAt: NOW,
        attention: null,
        attentionSince: null,
        ...over,
      })
      .run();

  test("counts only in-scope issues whose project key matches, top 5 most urgent first", () => {
    const { projectId } = seedProject("app", { jiraKeys: ["DEMO", "OPS"] });
    issue("DEMO-1", "DEMO", { attention: "stale" });
    issue("DEMO-2", "DEMO", { attention: "overdue" });
    issue("DEMO-3", "DEMO", { attention: "blocked" });
    issue("DEMO-4", "DEMO"); // no attention
    issue("OPS-1", "OPS", { attention: "blocked" });
    issue("OPS-2", "OPS", { attention: "due_soon" });
    issue("OPS-3", "OPS", { attention: "stale" });
    issue("DEMO-5", "DEMO", { attention: "overdue", inScope: false });
    issue("OTHER-1", "OTHER", { attention: "overdue" });
    const j = c.brain.getProject(projectId)?.jira;
    expect(j?.byAttention).toEqual({ overdue: 1, blocked: 2, due_soon: 1, stale: 2 });
    expect(j?.top.map((i) => i.key)).toEqual(["DEMO-2", "DEMO-3", "OPS-1", "OPS-2", "DEMO-1"]);
  });

  test("a project with no Jira keys has an empty summary", () => {
    const { projectId } = seedProject("app");
    issue("DEMO-1", "DEMO", { attention: "overdue" });
    expect(c.brain.getProject(projectId)?.jira).toEqual({
      byAttention: { overdue: 0, blocked: 0, due_soon: 0, stale: 0 },
      top: [],
    });
  });

  test("list and detail views", () => {
    const { projectId, repoId } = seedProject("app", { envs: ["prod"] });
    seedFact(projectId);
    c.brain.createMilestone(projectId, {
      name: "Beta",
      targetDate: "2026-12-01",
      status: "planned",
    });
    const list = c.brain.listProjects();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      name: "app",
      repositoryIds: [repoId],
      factsNeedingReview: 1,
      nextMilestone: { name: "Beta" },
    });
    const d = c.brain.getProject(projectId);
    expect(d?.repositories[0]?.environments[0]?.name).toBe("prod");
    expect(d?.facts).toHaveLength(1);
    expect(d?.milestones).toHaveLength(1);
    expect(c.brain.getProject("nope")).toBeNull();
  });

  test("updateProject: name and summary, duplicate name, unknown id, extra field", () => {
    const a = seedProject("a");
    seedProject("b");
    expect(c.brain.updateProject(a.projectId, { summary: "Hello" }).summary).toBe("Hello");
    expect(c.brain.updateProject(a.projectId, { name: "a2", summary: null })).toMatchObject({
      name: "a2",
      summary: null,
    });
    expect(codeOf(() => c.brain.updateProject(a.projectId, { name: "b" }))).toBe("duplicate_name");
    expect(codeOf(() => c.brain.updateProject("nope", { name: "z" }))).toBe("not_found");
    expect(codeOf(() => c.brain.updateProject(a.projectId, { id: "x" } as never))).toBe(
      "invalid_input",
    );
    expect(codeOf(() => c.brain.updateProject(a.projectId, { name: "bad name" }))).toBe(
      "invalid_input",
    );
  });
});
