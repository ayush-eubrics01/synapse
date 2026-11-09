import type {
  MilestoneView,
  ProjectDetail,
  ProjectFactView,
  RepositoryProposal,
  RepositoryView,
  UpcomingMilestone,
} from "@synapse/contracts";

const T = "2026-11-05T00:00:00.000Z";

export const repo = (o: Partial<RepositoryView> = {}): RepositoryView => ({
  id: "r1",
  name: "demo-app",
  localPath: "/tmp/demo/app",
  originUrl: "https://example.com/demo/app.git",
  upstreamUrl: null,
  upstreamPushDisabled: false,
  trackedBranch: "main",
  jiraProjectKeys: [],
  notes: null,
  headSha: "abc123",
  inspectedHeadSha: "abc123",
  inspectionWarning: null,
  drift: null,
  environments: [
    {
      id: "e1",
      name: "stage",
      branch: "stage",
      protected: false,
      autoDeploysOnMerge: true,
    },
    { id: "e2", name: "prod", branch: "prod", protected: true, autoDeploysOnMerge: false },
  ],
  projectId: "p1",
  createdAt: T,
  updatedAt: T,
  ...o,
});

export const fact = (o: Partial<ProjectFactView> = {}): ProjectFactView => ({
  id: "f1",
  projectId: "p1",
  kind: "stack",
  content: "TypeScript on Bun",
  evidence: [{ path: "package.json", line: 3 }],
  status: "approved",
  source: "inspection",
  claudeRunId: null,
  supersedesId: null,
  headSha: "abc123",
  createdAt: T,
  decidedAt: T,
  ...o,
});

export const milestone = (o: Partial<MilestoneView> = {}): MilestoneView => ({
  id: "m1",
  projectId: "p1",
  name: "Go live",
  targetDate: "2026-11-10",
  environmentId: "e2",
  environmentName: "prod",
  status: "planned",
  notes: null,
  overdue: false,
  createdAt: T,
  updatedAt: T,
  ...o,
});

export const upcoming = (o: Partial<UpcomingMilestone> = {}): UpcomingMilestone => ({
  ...milestone(),
  projectName: "demo-app",
  ...o,
});

export const detail = (o: Partial<ProjectDetail> = {}): ProjectDetail => ({
  id: "p1",
  name: "demo-app",
  summary: "A demo application",
  repositoryIds: ["r1"],
  factsNeedingReview: 1,
  nextMilestone: milestone(),
  createdAt: T,
  updatedAt: T,
  repositories: [repo()],
  facts: [
    fact(),
    fact({ id: "f2", kind: "module", content: "api serves REST" }),
    fact({ id: "f3", kind: "risk", status: "needs_review", content: "No migrations lock" }),
  ],
  milestones: [milestone()],
  jira: { byAttention: { overdue: 1, blocked: 0, due_soon: 0, stale: 0 }, top: [] },
  ...o,
});

export const proposal = (o: Partial<RepositoryProposal> = {}): RepositoryProposal => ({
  realpath: "/tmp/demo/app",
  suggestedName: "demo-app",
  currentBranch: "main",
  suggestedTrackedBranch: "main",
  headSha: "abc123",
  originUrl: "https://example.com/demo/app.git",
  upstreamUrl: null,
  upstreamPushDisabled: false,
  branches: ["main", "prod", "stage"],
  environmentCandidates: [
    { name: "stage", branch: "stage" },
    { name: "prod", branch: "prod" },
  ],
  ...o,
});
