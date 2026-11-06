import { expect, test } from "bun:test";
import {
  ApiError,
  acceptBrainFact,
  acceptCurrentRemotes,
  createMilestone,
  getProject,
  getProjects,
  getRepositories,
  inspectRepositoryNow,
  inspectRepositoryPath,
  registerRepository,
  rejectBrainFact,
} from "../lib/api";
import {
  brainPaletteItems,
  driftLabel,
  envChipLabel,
  groupFacts,
  milestoneLabel,
  registryErrorLabel,
} from "../lib/brain";
import { sidebarItems } from "../lib/nav";
import { buildNeedsYou, type NeedsYouInput } from "../lib/needs-you";
import { fact, milestone, repo } from "./brain-fixtures";

const NOW = new Date(2026, 10, 6, 12, 0, 0);

test("groupFacts groups approved facts by kind in a fixed order and drops other statuses", () => {
  const groups = groupFacts([
    fact({ id: "a", kind: "risk" }),
    fact({ id: "b", kind: "purpose" }),
    fact({ id: "c", kind: "risk" }),
    fact({ id: "d", kind: "stack", status: "needs_review" }),
    fact({ id: "e", kind: "note", status: "rejected" }),
  ]);
  expect(groups.map((g) => g.kind)).toEqual(["purpose", "risk"]);
  expect(groups[1]?.facts.map((f) => f.id)).toEqual(["a", "c"]);
  expect(groups[0]?.label).toBe("Purpose");
});

test("envChipLabel reads name -> branch with the auto-deploy and protected notes", () => {
  const [stage, prod] = repo().environments;
  expect(envChipLabel(stage as never)).toBe("stage → stage · auto-deploys on merge");
  expect(envChipLabel(prod as never)).toBe("prod → prod · protected");
  expect(
    envChipLabel({
      id: "x",
      name: "qa",
      branch: "release",
      protected: false,
      autoDeploysOnMerge: false,
    }),
  ).toBe("qa → release");
  expect(
    envChipLabel({ id: "x", name: "p", branch: "p", protected: true, autoDeploysOnMerge: true }),
  ).toBe("p → p · protected · auto-deploys on merge");
});

test("milestoneLabel says Overdue or In N days", () => {
  expect(milestoneLabel(milestone({ overdue: true, targetDate: "2026-11-01" }), NOW)).toBe(
    "Overdue",
  );
  expect(milestoneLabel(milestone({ targetDate: "2026-11-09" }), NOW)).toBe("In 3 days");
  expect(milestoneLabel(milestone({ targetDate: "2026-11-07" }), NOW)).toBe("In 1 day");
  expect(milestoneLabel(milestone({ targetDate: "2026-11-06" }), NOW)).toBe("Due today");
  expect(milestoneLabel(milestone({ targetDate: "2026-11-05" }), NOW)).toBe("Overdue");
  expect(milestoneLabel(milestone({ targetDate: "2026-11-09" }), null)).toBe("2026-11-09");
  expect(milestoneLabel(milestone({ status: "done" }), NOW)).toBe("Done");
});

test("driftLabel joins every drift part and is null without drift", () => {
  expect(driftLabel(null)).toBeNull();
  expect(driftLabel({ offTrackedBranch: "feature", detectedAt: "x" }, "main")).toBe(
    "Not on main (now feature)",
  );
  expect(
    driftLabel(
      {
        offTrackedBranch: "HEAD",
        missingEnvironmentBranches: ["stage", "prod"],
        remotesChanged: true,
        pathMissing: true,
        detectedAt: "x",
      },
      "main",
    ),
  ).toBe("Not on main (now HEAD) · Missing branch: stage, prod · Remotes changed · Path missing");
});

test("registryErrorLabel maps every API code and falls back to the code", () => {
  const expected: Record<string, string> = {
    not_absolute: "Enter an absolute path",
    not_found: "Path not found",
    not_directory: "Not a directory",
    not_git_root: "Not the top of a git repository",
    unsafe_chars: "Path must use letters, numbers, . _ - and /",
    forbidden_location: "That location can't be registered",
    nested: "Inside or around an already registered repository",
    already_registered: "Already registered",
    duplicate_name: "Name already used by another project",
    invalid_branch: "Branch not found in this repository",
    unknown_tracked_branch: "Branch not found in this repository",
    unknown_environment_branch: "Branch not found in this repository",
  };
  for (const [code, label] of Object.entries(expected))
    expect(registryErrorLabel(code)).toBe(label);
  // every other code the registry can return has its own readable label
  for (const code of [
    "invalid_input",
    "duplicate_environment",
    "path_unavailable",
    "git_failed",
    "invalid_environment",
    "invalid_state",
  ]) {
    expect(registryErrorLabel(code)).not.toContain("Couldn't register:");
  }
  expect(registryErrorLabel("weird")).toBe("Couldn't register: weird");
});

test("brainPaletteItems offers Register a repository and one entry per project", () => {
  const ran: string[] = [];
  const items = brainPaletteItems([{ id: "p1", name: "demo-app" }], {
    register: () => ran.push("register"),
    open: (id) => ran.push(`open:${id}`),
  });
  expect(items.map((i) => i.label)).toEqual(["Register a repository", "demo-app"]);
  expect(items[1]?.group).toBe("project");
  items[0]?.run();
  items[1]?.run();
  expect(ran).toEqual(["register", "open:p1"]);
});

const counts = {
  urgent: 0,
  approvals: 0,
  outgoingAttention: 0,
  redFlags: 0,
  commitmentsToReview: 0,
  followupDrafts: 0,
  profileRecommendations: 0,
  peopleToEvaluate: 0,
  conversations: 0,
  jiraAttention: 0,
  brainReview: 4,
};

test("the nav has Projects after Jira with the brainReview badge", () => {
  const items = sidebarItems(counts, 0);
  const ids = items.map((i) => i.id);
  expect(ids.indexOf("projects")).toBe(ids.indexOf("jira") + 1);
  const projects = items.find((i) => i.id === "projects");
  expect(projects?.label).toBe("Projects");
  expect(projects?.count).toBe(4);
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

test("brain-review is ranked after jira-attention and setup-brain only when there are no repos", () => {
  const review = [{ fact: fact({ id: "f9", status: "needs_review" }), projectName: "demo-app" }];
  const cards = buildNeedsYou(baseInput({ brainReview: review, repositories: [] }));
  expect(cards.map((c) => c.kind)).toEqual(["brain-review", "setup-brain"]);
  expect(buildNeedsYou(baseInput({ repositories: null })).map((c) => c.kind)).toEqual([]);
  expect(buildNeedsYou(baseInput({ repositories: [repo()] })).map((c) => c.kind)).toEqual([]);
});

test("a fact pending a deferred reject is hidden, and the card goes with its last fact", () => {
  const review = [{ fact: fact({ id: "f9", status: "needs_review" }), projectName: "demo-app" }];
  const hidden = new Set(["brain-fact:f9"]);
  expect(buildNeedsYou(baseInput({ brainReview: review, hidden }))).toEqual([]);
});

type Call = { url: string; init?: RequestInit };
function fake(status: number, body: unknown) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(status === 204 ? null : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

test("brain api calls use the C12 routes", async () => {
  const f = fake(200, {});
  await getRepositories(f.impl);
  await getProjects(f.impl);
  await getProject("p 1", f.impl);
  await inspectRepositoryPath("/tmp/demo/app", f.impl);
  await acceptCurrentRemotes("r1", f.impl);
  await acceptBrainFact("f1", "edited", f.impl);
  await acceptBrainFact("f2", undefined, f.impl);
  await rejectBrainFact("f1", f.impl);
  await createMilestone("p1", { name: "Go", targetDate: "2026-11-10" }, f.impl);
  expect(f.calls.map((c) => `${c.init?.method ?? "GET"} ${c.url}`)).toEqual([
    "GET /api/repos",
    "GET /api/projects",
    "GET /api/projects/p%201",
    "POST /api/repos/inspect",
    "POST /api/repos/r1/accept-remotes",
    "POST /api/brain/facts/f1/accept",
    "POST /api/brain/facts/f2/accept",
    "POST /api/brain/facts/f1/reject",
    "POST /api/projects/p1/milestones",
  ]);
  expect(JSON.parse(String(f.calls[3]?.init?.body))).toEqual({ path: "/tmp/demo/app" });
  expect(JSON.parse(String(f.calls[5]?.init?.body))).toEqual({ content: "edited" });
  expect(JSON.parse(String(f.calls[6]?.init?.body))).toEqual({});
});

test("a refused register carries the API error code", async () => {
  const f = fake(409, { error: "duplicate_name" });
  const err = await registerRepository(
    {
      path: "/tmp/demo/app",
      name: "demo-app",
      trackedBranch: "main",
      environments: [],
      jiraProjectKeys: [],
    },
    f.impl,
  ).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).code).toBe("duplicate_name");
  expect((err as ApiError).status).toBe(409);
});

test("inspecting a repository that is already queued is a 409 ApiError", async () => {
  const f = fake(409, { error: "already_queued", jobId: "j1" });
  const err = await inspectRepositoryNow("r1", f.impl).catch((e: unknown) => e);
  expect((err as ApiError).status).toBe(409);
  expect((err as ApiError).code).toBe("already_queued");
});
