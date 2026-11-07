import type {
  ApprovalView,
  EngineeringTaskDetail,
  EngineeringTaskView,
  RepositoryView,
} from "@synapse/contracts";

export const T = "2026-11-06T10:00:00.000Z";

export const repo = (o: Partial<RepositoryView> = {}): RepositoryView => ({
  id: "r1",
  name: "synapse-demo",
  localPath: "/home/u/demo",
  originUrl: "git@github.com:me/demo.git",
  upstreamUrl: "git@github.com:org/demo.git",
  upstreamPushDisabled: true,
  trackedBranch: "develop",
  jiraProjectKeys: [],
  notes: null,
  headSha: null,
  inspectedHeadSha: null,
  drift: null,
  environments: [
    { id: "e-prod", name: "prod", branch: "main", protected: true, autoDeploysOnMerge: false },
    { id: "e-stage", name: "stage", branch: "staging", protected: false, autoDeploysOnMerge: true },
    { id: "e-dev", name: "dev", branch: "develop", protected: false, autoDeploysOnMerge: false },
  ],
  projectId: null,
  createdAt: T,
  updatedAt: T,
  ...o,
});

export const task = (o: Partial<EngineeringTaskView> = {}): EngineeringTaskView => ({
  id: "t1234567890",
  repositoryId: "r1",
  environmentId: null,
  source: "manual",
  sourceRef: null,
  title: "Fix the retry loop",
  status: "planned",
  currentStep: null,
  parentBranch: null,
  taskBranch: null,
  prUrl: null,
  prNumber: null,
  failure: null,
  lastPickupError: null,
  cleanup: null,
  createdAt: T,
  updatedAt: T,
  ...o,
});

export const detail = (o: Partial<EngineeringTaskDetail> = {}): EngineeringTaskDetail => ({
  ...task(),
  draftDescription: "draft",
  approvedDescription: "approved text",
  plan: {
    summary: "Retries never back off",
    plan: [{ step: "Add backoff" }, { step: "Add a test" }],
    filesLikelyTouched: ["src/retry.ts", "test/retry.test.ts"],
    testCommand: "bun test",
    risk: "low",
    size: "xs",
    unclear: [],
  },
  baseSha: null,
  mergeSha: null,
  steps: [],
  ...o,
});

export const approval = (
  action: string,
  payload: Record<string, unknown>,
  o: Partial<ApprovalView> = {},
): ApprovalView =>
  ({
    id: "a1",
    action,
    targetIntegration: "engineering",
    targetRef: "t1234567890",
    payload: { taskId: "t1234567890", ...payload },
    riskLevel: "medium",
    status: "pending",
    requestedByModule: "engineering",
    requestedByWorker: null,
    expiresAt: null,
    decidedAt: null,
    executionResult: null,
    idempotencyKey: "k",
    createdAt: T,
    ...o,
  }) as ApprovalView;

export const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 111..222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,3 @@",
  " keep",
  "-old <b>bold</b>",
  "+new <script>alert(1)</script>",
  "+more",
  "diff --git a/src/b.ts b/src/b.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/b.ts",
  "@@ -0,0 +1 @@",
  "+hello",
].join("\n");
