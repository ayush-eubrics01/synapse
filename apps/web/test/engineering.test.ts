import { expect, test } from "bun:test";
import {
  ENGINEERING_REASON_CODES,
  errorKindSchema,
  GIT_PREFLIGHT_REASONS,
  GIT_UNSAFE_REASONS,
  GIT_WORKFLOW_ERROR_CODES,
  PR_ERROR_CODES,
} from "@synapse/contracts";
import {
  approveTaskDescription,
  approveTaskPlan,
  cancelEngineeringTask,
  createEngineeringTask,
  createTaskFromJira,
  createTaskFromSlack,
  editEngineeringApproval,
  getEngineeringTask,
  getEngineeringTasks,
} from "../lib/api";
import {
  approvalTextProblem,
  approvalTextValues,
  canCheckAgain,
  changedText,
  defaultPlanForm,
  deployEnvironment,
  engineeringApproval,
  groupTasks,
  lockText,
  parentBranchError,
  parseDiff,
  reasonLabel,
  repositoryChoices,
  SANDBOX_OFF_TEXT,
  SANDBOX_ON_TEXT,
  stepLabel,
  testCommandError,
} from "../lib/engineering";
import { approval, detail, repo, task } from "./engineering-fixtures";

type Call = { url: string; init?: RequestInit };
function fake(status: number, body: unknown) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

// ---------------------------------------------------------------- api

test("task reads: the list takes an optional status, the detail is by id", async () => {
  const list = fake(200, []);
  await getEngineeringTasks(undefined, list.impl);
  expect(list.calls[0]?.url).toBe("/api/engineering/tasks");
  await getEngineeringTasks("planned", list.impl);
  expect(list.calls[1]?.url).toBe("/api/engineering/tasks?status=planned");
  const one = fake(200, {});
  await getEngineeringTask("t/1", one.impl);
  expect(one.calls[0]?.url).toBe("/api/engineering/tasks/t%2F1");
});

test("task writes POST the documented bodies", async () => {
  const f = fake(201, {});
  await createEngineeringTask({ repositoryId: "r1", title: "T", draftDescription: "D" }, f.impl);
  await createTaskFromJira("DEMO-1", undefined, f.impl);
  await createTaskFromSlack("m1", "r1", f.impl);
  await approveTaskDescription("t1", "text", f.impl);
  await approveTaskPlan(
    "t1",
    {
      parentBranch: "develop",
      testCommand: "bun test",
      environmentId: "e1",
      rememberAsTracked: true,
    },
    f.impl,
  );
  await cancelEngineeringTask("t1", f.impl);
  const urls = f.calls.map((c) => `${c.init?.method} ${c.url}`);
  expect(urls).toEqual([
    "POST /api/engineering/tasks",
    "POST /api/engineering/tasks/from-jira",
    "POST /api/engineering/tasks/from-slack",
    "POST /api/engineering/tasks/t1/approve-description",
    "POST /api/engineering/tasks/t1/approve-plan",
    "POST /api/engineering/tasks/t1/cancel",
  ]);
  const body = (i: number) => JSON.parse(String(f.calls[i]?.init?.body ?? "null"));
  expect(body(1)).toEqual({ key: "DEMO-1" });
  expect(body(2)).toEqual({ messageId: "m1", repositoryId: "r1" });
  expect(body(3)).toEqual({ description: "text" });
  expect(body(4)).toEqual({
    parentBranch: "develop",
    testCommand: "bun test",
    environmentId: "e1",
    rememberAsTracked: true,
  });
});

// ---------------------------------------------------------------- labels

test("every fixed reason code in the contracts has a plain-English label", () => {
  const all = [
    ...ENGINEERING_REASON_CODES,
    ...GIT_PREFLIGHT_REASONS,
    ...GIT_WORKFLOW_ERROR_CODES,
    ...GIT_UNSAFE_REASONS,
    ...PR_ERROR_CODES,
    ...errorKindSchema.options,
  ];
  const fallback = reasonLabel("definitely_not_a_code");
  for (const code of all) {
    const label = reasonLabel(code);
    expect(label).not.toBe(fallback);
    // An environment variable name (XDG_CACHE_HOME) is the one place an underscore is the point.
    expect(label.replace(/\b[A-Z]+(?:_[A-Z]+)+\b/g, "")).not.toContain("_");
  }
});

test("the final-review codes have their own labels (M11)", () => {
  for (const code of [
    "lock_lost",
    "lock_held_by_other",
    "step_running",
    "not_terminal",
    "repo_has_active_task",
    "checks_failing",
    "origin_changed",
    "merged_after_cancel",
    "cleanup_incomplete",
  ]) {
    expect(reasonLabel(code)).not.toBe(reasonLabel("definitely_not_a_code"));
  }
  expect(reasonLabel("checks_failing")).toMatch(/checks/i);
  expect(reasonLabel("origin_changed")).toMatch(/origin/i);
  expect(reasonLabel("merged_after_cancel")).toMatch(/merged/i);
});

test("the named reasons read as sentences, and unknown or empty codes never echo raw text", () => {
  expect(reasonLabel("unsafe_change")).toMatch(/outside|unsafe|\.git/i);
  expect(reasonLabel("parent_conflict")).toMatch(/conflict/i);
  expect(reasonLabel("pr_head_moved")).toMatch(/pull request/i);
  expect(reasonLabel("<b>x</b>")).not.toContain("<b>");
  expect(reasonLabel(null)).toBe("");
});

test("step labels cover every step", () => {
  expect(stepLabel("push_pr")).toBe("Push and open PR");
  expect(stepLabel("merge_local")).toBe("Merge locally");
});

test("lock text is free, or busy with the title", () => {
  expect(lockText({ held: false })).toBe("free");
  expect(lockText({ held: true, taskTitle: "Fix it" })).toBe("busy · Fix it");
  expect(lockText({ held: true })).toBe("busy");
  expect(lockText(null)).toBe("unknown");
});

// ---------------------------------------------------------------- plan form rules

test("test command errors: empty and unsafe commands are refused with a message", () => {
  expect(testCommandError("bun test")).toBeNull();
  expect(testCommandError("")).toMatch(/required|enter/i);
  expect(testCommandError("bun test; rm -rf /")).toMatch(/not allowed|unsafe|runner/i);
  expect(testCommandError("rm -rf /")).not.toBeNull();
});

test("a parent branch must be a safe ref and not a protected environment's branch", () => {
  const r = repo();
  expect(parentBranchError("develop", r)).toBeNull();
  expect(parentBranchError("", r)).not.toBeNull();
  expect(parentBranchError("-x", r)).not.toBeNull();
  expect(parentBranchError("a..b", r)).not.toBeNull();
  expect(parentBranchError("main", r)).toMatch(/protected/i);
});

test("defaults: the environment's branch, else the tracked branch; the test command from the plan", () => {
  const r = repo();
  const d = defaultPlanForm(detail(), r);
  expect(d).toEqual({
    environmentId: "e-dev",
    parentBranch: "develop",
    testCommand: "bun test",
    remember: false,
  });
  const noEnv = defaultPlanForm(detail(), repo({ environments: [] }));
  expect(noEnv.environmentId).toBe("");
  expect(noEnv.parentBranch).toBe("develop");
  const noCmd = defaultPlanForm(detail({ plan: null }), r);
  expect(noCmd.testCommand).toBe("");
});

test("the deploy environment is the chosen one, or the one whose branch the parent is", () => {
  const r = repo();
  expect(deployEnvironment(r, "e-stage", "anything")?.name).toBe("stage");
  expect(deployEnvironment(r, "", "staging")?.name).toBe("stage");
  expect(deployEnvironment(r, "e-dev", "develop")).toBeNull();
});

// ---------------------------------------------------------------- diff

test("parseDiff splits files, classifies lines and counts + and -", () => {
  const files = parseDiff(
    [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1,2 @@",
      "-old",
      "+new",
      "+more",
      "diff --git a/b.ts b/b.ts",
      "+++ b/b.ts",
      "@@ -0,0 +1 @@",
      "+x",
    ].join("\n"),
  );
  expect(files.map((f) => [f.path, f.added, f.removed])).toEqual([
    ["src/a.ts", 2, 1],
    ["b.ts", 1, 0],
  ]);
  const kinds = files[0]?.lines.map((l) => l.kind);
  expect(kinds).toEqual(["meta", "meta", "meta", "hunk", "del", "add", "add"]);
  expect(files[0]?.lines.find((l) => l.kind === "add")?.text).toBe("+new");
});

test("parseDiff of empty text is no files", () => {
  expect(parseDiff("")).toEqual([]);
});

// ---------------------------------------------------------------- approvals and grouping

test("engineeringApproval reads each action's payload and ignores other approvals", () => {
  expect(engineeringApproval(approval("slack.send", {}))).toBeNull();
  const c = engineeringApproval(
    approval("engineering.commit", {
      diffHash: "h",
      files: [{ path: "a.ts", added: 2, removed: 1 }],
      filesTotal: 1,
      testsPassed: false,
      message: "msg",
    }),
  );
  expect(c).toMatchObject({ kind: "commit", testsPassed: false, message: "msg", filesTotal: 1 });
  const p = engineeringApproval(
    approval("engineering.push_pr", {
      commits: [{ sha: "abc1234", subject: "s" }],
      commitsTotal: 3,
      mergeSha: "def5678",
      prTitle: "T",
      prBody: "B",
      autoDeploys: true,
      environmentName: "stage",
      parentBranch: "develop",
    }),
  );
  expect(p).toMatchObject({
    kind: "push_pr",
    commitsTotal: 3,
    autoDeploys: true,
    title: "T",
    body: "B",
  });
  const m = engineeringApproval(
    approval("engineering.merge_pr", {
      prNumber: 7,
      prUrl: "https://github.com/org/demo/pull/7",
      status: { state: "OPEN", mergeable: "MERGEABLE", checks: "passing" },
      autoDeploys: false,
    }),
  );
  expect(m).toMatchObject({ kind: "merge_pr", prNumber: 7, checks: "passing" });
});

test("a malformed engineering payload still yields a card kind, with safe defaults", () => {
  const bad = engineeringApproval(approval("engineering.merge_local", { commits: "x" }));
  expect(bad).toMatchObject({ kind: "merge_local", commits: [] });
});

test("groupTasks puts each status in one group", () => {
  const g = groupTasks([
    task({ id: "1", status: "proposed" }),
    task({ id: "2", status: "planned" }),
    task({ id: "3", status: "approved" }),
    task({ id: "4", status: "queued" }),
    task({ id: "5", status: "in_progress" }),
    task({ id: "6", status: "needs_attention" }),
    task({ id: "7", status: "completed" }),
    task({ id: "8", status: "cancelled" }),
    task({ id: "9", status: "investigating" }),
  ]);
  const ids = (xs: { id: string }[]) => xs.map((t) => t.id);
  expect(ids(g.proposed)).toEqual(["1"]);
  expect(ids(g.planned)).toEqual(["2"]);
  expect(ids(g.queue)).toEqual(["3", "4"]);
  expect(ids(g.active)).toEqual(["5", "6", "9"]);
  expect(ids(g.history)).toEqual(["7", "8"]);
});

test("changedText keeps only the changed fields", () => {
  expect(changedText({ commitMessage: "a" }, { commitMessage: "b" })).toEqual({
    commitMessage: "b",
  });
  expect(changedText({ commitMessage: "a" }, { commitMessage: "a" })).toEqual({});
  expect(changedText({ prTitle: "t", prBody: "b" }, { prTitle: "t", prBody: "c" })).toEqual({
    prBody: "c",
  });
});

test("approvalTextProblem gives the first failing field's sentence", () => {
  expect(approvalTextProblem({ prTitle: "a\nb" })).toBe(
    "A PR title needs 1 to 200 characters on one line.",
  );
  expect(approvalTextProblem({ commitMessage: "  \nbody" })).toBe(
    "A commit message needs 1 to 5000 characters and a first line of at most 200.",
  );
  expect(approvalTextProblem({ prBody: "x".repeat(20001) })).toBe(
    "A PR body can have at most 20000 characters.",
  );
  expect(approvalTextProblem({ commitMessage: "Fix add", prTitle: "T", prBody: "" })).toBeNull();
});

test("canCheckAgain is true only for checks_failing at merge_pr while needing attention", () => {
  const t = (status: string, failure: string | null, currentStep: string | null) =>
    canCheckAgain({ status, failure, currentStep } as Parameters<typeof canCheckAgain>[0]);
  expect(t("needs_attention", "checks_failing", "merge_pr")).toBe(true);
  expect(t("needs_attention", "dirty_tree", "merge_pr")).toBe(false);
  expect(t("needs_attention", "checks_failing", "push_pr")).toBe(false);
  expect(t("in_progress", "checks_failing", "merge_pr")).toBe(false);
});

test("repositoryChoices sorts by name and keeps only id and name", () => {
  const r = (id: string, name: string) => ({ id, name, localPath: "/home/u/x" }) as never;
  expect(repositoryChoices([r("2", "demo"), r("1", "api")])).toEqual([
    { id: "1", name: "api" },
    { id: "2", name: "demo" },
  ]);
});

test("approvalTextValues reads the editable text of commit and push cards only", () => {
  expect(approvalTextValues({ kind: "commit", message: "Fix add" } as never)).toEqual({
    commitMessage: "Fix add",
  });
  expect(approvalTextValues({ kind: "push_pr", title: "T", body: "B" } as never)).toEqual({
    prTitle: "T",
    prBody: "B",
  });
  expect(approvalTextValues({ kind: "merge_local" } as never)).toBeNull();
});

test("the sandbox copy and the new reasons read as plain sentences", () => {
  expect(SANDBOX_ON_TEXT).toBe(
    "Tests run in a sandbox: no network, writes only inside the repository",
  );
  expect(SANDBOX_OFF_TEXT).toBe("Develop runs are disabled: the test sandbox is turned off");
  expect(reasonLabel("sandbox_unavailable")).toContain("sudo apt install bubblewrap socat");
  expect(reasonLabel("not_pending")).toBe("This approval was already decided or replaced.");
  expect(reasonLabel("checks_failing")).toContain("use Check again");
});

test("editEngineeringApproval PUTs the edit and surfaces the code", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const ok = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ id: "a1" }), { status: 200 });
  }) as unknown as typeof fetch;
  await editEngineeringApproval("t1", "a1", { prTitle: "T" }, ok);
  expect(calls[0]?.url).toContain("/api/engineering/tasks/t1/approvals/a1");
  expect(calls[0]?.init?.method).toBe("PUT");
  expect(calls[0]?.init?.body).toBe(JSON.stringify({ prTitle: "T" }));
  const bad = (async () =>
    new Response(JSON.stringify({ error: "not_pending" }), {
      status: 409,
    })) as unknown as typeof fetch;
  await expect(editEngineeringApproval("t1", "a1", {}, bad)).rejects.toMatchObject({
    code: "not_pending",
  });
});
