import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToString } from "react-dom/server";
import { DiffViewer } from "../app/components/engineering/DiffViewer";
import {
  CancelTaskControl,
  DescriptionApproval,
  DescriptionForm,
  EngineeringSection,
} from "../app/components/engineering/EngineeringSection";
import { NewTaskForm } from "../app/components/engineering/NewTaskForm";
import { PlanApproval } from "../app/components/engineering/PlanApproval";
import { TaskTimeline } from "../app/components/engineering/TaskTimeline";
import { JiraSection } from "../app/components/jira/JiraSection";
import { Sidebar } from "../app/components/shell/Sidebar";
import { Running } from "../app/components/system/Running";
import {
  EngineeringApprovalCard,
  EngineeringAttentionCard,
  EngineeringPlanCard,
  RejectControl,
} from "../app/components/triage/EngineeringCards";
import { createDeferred } from "../lib/deferred";
import { lockText } from "../lib/engineering";
import { sidebarItems } from "../lib/nav";
import { buildNeedsYou, type NeedsYouInput } from "../lib/needs-you";
import { createNeedsYouActions, type NeedsYouApi } from "../lib/needs-you-actions";
import { approval, DIFF, detail, repo, task } from "./engineering-fixtures";
import { issue } from "./jira-fixtures";

const text = (html: string) => html.replace(/<!-- -->/g, "");
const NOW = new Date("2026-11-06T10:05:00.000Z");

// ---------------------------------------------------------------- plan approval

const renderPlan = (r = repo(), d = detail()) =>
  text(renderToString(<PlanApproval task={d} repo={r} onApprove={async () => null} />));

test("plan approval: protected environments are disabled and labelled, others are selectable", () => {
  const html = renderPlan();
  expect(html).toMatch(/<option[^>]*disabled[^>]*>prod \(protected\)<\/option>/);
  expect(html).not.toMatch(/<option[^>]*disabled[^>]*>stage/);
  expect(html).toContain("dev");
});

test("plan approval: an auto-deploy environment shows the deploy notice, others do not", () => {
  // Stage is the chosen environment when it is the one the tracked branch points at.
  const stage = repo({ trackedBranch: "staging" });
  const html = renderPlan(stage);
  expect(html).toContain("Merging the PR deploys stage");
  expect(renderPlan()).not.toContain("Merging the PR deploys");
});

test("plan approval: parent branch prefilled from the environment, PR line and task branch shown", () => {
  const html = renderPlan();
  expect(html).toContain('value="develop"');
  expect(html).toContain("PR origin/develop → upstream/develop");
  expect(html).toMatch(/synapse\/t1234567-fix-the-retry-loop/);
  expect(html).toContain("Add backoff");
  expect(html).toContain("src/retry.ts");
});

test("plan approval: the test command is prefilled and an unsafe one shows an inline error", () => {
  const ok = renderPlan();
  expect(ok).toContain('value="bun test"');
  expect(ok).not.toContain("syn-eng-field-error");
  const unsafe = detail({
    plan: {
      ...(detail().plan as NonNullable<ReturnType<typeof detail>["plan"]>),
      testCommand: "bun test; rm -rf /",
    },
  });
  const html = renderPlan(repo(), unsafe);
  expect(html).toContain("syn-eng-field-error");
  expect(html).toMatch(/Test command[\s\S]*not allowed/i);
  // The approve button is disabled while the form is invalid.
  expect(html).toMatch(/<button[^>]*disabled[^>]*>Approve plan/);
});

test("plan approval: a tracked branch that is itself protected is flagged", () => {
  const html = renderPlan(repo({ trackedBranch: "main", environments: repo().environments }));
  expect(html).toMatch(/protected/i);
  expect(html).toContain("syn-eng-field-error");
});

test("plan approval has the remember-as-tracked checkbox", () => {
  expect(renderPlan()).toContain("Remember as tracked branch");
});

// ---------------------------------------------------------------- diff viewer

test("the diff viewer renders one collapsible section per file as plain text", () => {
  const html = text(renderToString(<DiffViewer diffText={DIFF} truncated={false} />));
  expect(html.match(/<details/g)?.length).toBe(2);
  expect(html).toContain("src/a.ts");
  expect(html).toContain("+2");
  expect(html).toContain("-1");
  // Repo content is escaped, never injected.
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(html).toContain("syn-diff-line--add");
  expect(html).toContain("syn-diff-line--del");
  expect(html).toContain("<pre");
});

test("the diff viewer says when the diff was cut, and falls back to the file list without text", () => {
  expect(text(renderToString(<DiffViewer diffText={DIFF} truncated />))).toMatch(/cut/i);
  const html = text(
    renderToString(
      <DiffViewer diffText="" files={[{ path: "x.ts", added: 3, removed: 0 }]} truncated={false} />,
    ),
  );
  expect(html).toContain("x.ts");
  expect(html).toContain("+3");
});

// ---------------------------------------------------------------- approval cards

const noop = () => {};
const card = (a: ReturnType<typeof approval>, d = detail()) =>
  text(
    renderToString(
      <EngineeringApprovalCard
        approval={a}
        taskTitle="Fix the retry loop"
        detail={d}
        now={NOW}
        onDecide={noop}
      />,
    ),
  );

test("the commit card shows the backend's test result, the files and the message", () => {
  const base = {
    diffHash: "h",
    files: [{ path: "src/retry.ts", added: 4, removed: 1 }],
    filesTotal: 1,
    message: "Add backoff\n\nbody",
  };
  const pass = card(approval("engineering.commit", { ...base, testsPassed: true }));
  expect(pass).toContain("ENGINEERING · COMMIT");
  expect(pass).toContain("Tests passed");
  expect(pass).toContain("src/retry.ts");
  expect(pass).toContain("Add backoff");
  const fail = card(approval("engineering.commit", { ...base, testsPassed: false }));
  expect(fail).toContain("Tests failed");
  expect(fail).toMatch(/syn-chip--red[^>]*>Tests failed/);
});

test("the commit card shows the diff and test tail from the task detail", () => {
  const d = detail({
    steps: [
      {
        id: "s1",
        step: "develop",
        status: "done",
        approvalId: null,
        claudeRunId: null,
        output: { diffText: DIFF, truncated: false, testOutputTail: "3 pass\n1 fail" },
        createdAt: "",
        updatedAt: "",
      },
    ],
  });
  const html = card(
    approval("engineering.commit", {
      diffHash: "h",
      files: [],
      filesTotal: 2,
      testsPassed: true,
      message: "m",
    }),
    d,
  );
  expect(html).toContain("syn-diff");
  expect(html).toContain("3 pass");
});

test("the merge local card lists the commits", () => {
  const html = card(
    approval("engineering.merge_local", {
      parentBranch: "develop",
      taskBranch: "synapse/t1-x",
      commitSha: "abcdef1234567",
      commits: [{ sha: "abcdef1234567", subject: "Add backoff" }],
    }),
  );
  expect(html).toContain("ENGINEERING · MERGE LOCAL");
  expect(html).toContain("Add backoff");
  expect(html).toContain("develop");
});

test("the push and PR card shows commits, the PR text and the deploy notice", () => {
  const html = card(
    approval("engineering.push_pr", {
      parentBranch: "staging",
      commits: [{ sha: "abcdef1234567", subject: "Add backoff" }],
      commitsTotal: 4,
      mergeSha: "1234567abcdef",
      prTitle: "Add backoff <i>now</i>",
      prBody: "Body text",
      autoDeploys: true,
      environmentName: "stage",
    }),
  );
  expect(html).toContain("ENGINEERING · PUSH &amp; PR");
  expect(html).toContain("Add backoff");
  expect(html).toContain("and 3 more");
  expect(html).toContain("Body text");
  expect(html).toContain("PR origin/staging → upstream/staging");
  expect(html).toContain("Merging the PR deploys stage");
  expect(html).toContain("&lt;i&gt;now&lt;/i&gt;");
});

test("the merge PR card shows the red deploy banner only when the flag is set", () => {
  const payload = {
    parentBranch: "staging",
    prNumber: 7,
    prUrl: "https://github.com/org/demo/pull/7",
    status: { state: "OPEN", mergeable: "MERGEABLE", checks: "passing" },
  };
  const deploy = card(
    approval("engineering.merge_pr", { ...payload, autoDeploys: true, environmentName: "stage" }),
  );
  expect(deploy).toContain("ENGINEERING · MERGE PR");
  expect(deploy).toMatch(/syn-eng-deploy[^>]*>[^<]*Merging the PR deploys stage/);
  expect(deploy).toContain("passing");
  expect(deploy).toContain('href="https://github.com/org/demo/pull/7"');
  const plain = card(approval("engineering.merge_pr", { ...payload, autoDeploys: false }));
  expect(plain).not.toContain("syn-eng-deploy");
  const hostile = card(
    approval("engineering.merge_pr", {
      ...payload,
      prUrl: "javascript:alert(1)",
      autoDeploys: false,
    }),
  );
  expect(hostile).not.toContain("javascript:");
});

const CANCEL_TEXT =
  "This cancels the task and discards Synapse&#x27;s uncommitted changes. Committed work is kept on the task branch.";

test("reject asks for confirmation inline with the cancel consequences (M7)", () => {
  const closed = text(renderToString(<RejectControl onReject={noop} />));
  expect(closed).toContain("Reject");
  expect(closed).not.toContain(CANCEL_TEXT);
  const open = text(renderToString(<RejectControl onReject={noop} initiallyConfirming />));
  expect(open).toContain(CANCEL_TEXT);
});

test("cancel task asks for the same inline confirmation (M7)", () => {
  const closed = text(renderToString(<CancelTaskControl onCancel={noop} />));
  expect(closed).toContain("Cancel task");
  expect(closed).not.toContain(CANCEL_TEXT);
  const open = text(renderToString(<CancelTaskControl onCancel={noop} initiallyConfirming />));
  expect(open).toContain(CANCEL_TEXT);
  expect(open).toContain("Keep");
});

test("the needs attention card shows the plain-English reason", () => {
  const html = text(
    renderToString(
      <EngineeringAttentionCard
        task={task({ status: "needs_attention", failure: "merge_conflict" })}
        now={NOW}
        onCancel={noop}
        onOpen={noop}
      />,
    ),
  );
  expect(html).toContain("ENGINEERING · NEEDS ATTENTION");
  expect(html).toMatch(/conflict/i);
  expect(html).not.toContain("merge_conflict");
});

test("the plan card names the task and offers the review", () => {
  const html = text(
    renderToString(<EngineeringPlanCard task={task()} detail={detail()} now={NOW} onOpen={noop} />),
  );
  expect(html).toContain("ENGINEERING · APPROVE PLAN");
  expect(html).toContain("Fix the retry loop");
  expect(html).toContain("Retries never back off");
});

// ---------------------------------------------------------------- feed ranking

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

test("engineering approvals get their own card kind, ranked after sends and before other approvals", () => {
  const cards = buildNeedsYou(
    baseInput({
      approvals: [
        approval("slack.send", {}, { id: "s1" }),
        approval(
          "engineering.commit",
          { diffHash: "h", files: [], testsPassed: true, message: "m" },
          { id: "e1" },
        ),
      ],
      engineeringTasks: [task({ status: "needs_attention", failure: "dirty_tree", id: "tx" })],
    }),
  );
  expect(cards.map((c) => `${c.kind}:${c.key}`)).toEqual([
    "engineering-approval:approval:e1",
    "engineering-attention:eng-attention:tx",
    "approval:approval:s1",
  ]);
});

test("a planned task becomes an approve-plan card", () => {
  const cards = buildNeedsYou(baseInput({ engineeringTasks: [task({ status: "planned" })] }));
  expect(cards.map((c) => c.kind)).toEqual(["engineering-plan"]);
});

// ---------------------------------------------------------------- shell

test("the sidebar footer shows the lock text and the nav has Engineering after Projects", () => {
  const free = renderToString(
    <Sidebar
      items={[]}
      active="overview"
      onGo={noop}
      footer={{ api: "a", web: "w", lock: lockText({ held: false }) }}
    />,
  );
  expect(free).toContain("free");
  const busy = text(
    renderToString(
      <Sidebar
        items={[]}
        active="overview"
        onGo={noop}
        footer={{ api: "a", web: "w", lock: lockText({ held: true, taskTitle: "Fix it" }) }}
      />,
    ),
  );
  expect(busy).toContain("busy · Fix it");
  const labels = sidebarItems(null, 0).map((i) => i.label);
  expect(labels.indexOf("Engineering")).toBe(labels.indexOf("Projects") + 1);
  const counts = {
    engineeringAwaiting: 2,
  } as Parameters<typeof sidebarItems>[0];
  expect(sidebarItems(counts, 0).find((i) => i.id === "engineering")?.count).toBe(2);
});

test("the Running panel shows the engineering task from the overview lock", () => {
  const render = (lock: { held: boolean; taskTitle?: string; since?: string }) =>
    text(
      renderToString(
        <Running pipeline={[]} status={null} runs={[]} now={NOW} engineeringLock={lock} />,
      ),
    );
  expect(render({ held: true, taskTitle: "Fix it", since: "2026-11-06T09:00:00.000Z" })).toContain(
    "Fix it",
  );
  const idle = render({ held: false });
  expect(idle).toContain("None running");
  expect(idle).toContain("lock free");
});

// ---------------------------------------------------------------- section and forms

test("the section groups tasks and shows the lock status", () => {
  const html = text(
    renderToString(
      <EngineeringSection
        tasks={[
          task({ id: "p1", status: "proposed", title: "Proposed one" }),
          task({ id: "a1", status: "in_progress", title: "Active one", currentStep: "develop" }),
          task({
            id: "h1",
            status: "completed",
            title: "Done one",
            prUrl: "https://github.com/o/r/pull/3",
            prNumber: 3,
          }),
        ]}
        details={{}}
        repos={[repo()]}
        lock={{ held: true, taskId: "a1", taskTitle: "Active one" }}
        now={NOW}
        handlers={{
          create: async () => null,
          approveDescription: async () => null,
          approvePlan: async () => null,
          cancel: noop,
        }}
      />,
    ),
  );
  for (const s of [
    "Engineering",
    "Proposed",
    "Active one",
    "Done one",
    "History",
    "busy · Active one",
  ]) {
    expect(html).toContain(s);
  }
  expect(html).toContain("Develop");
});

test("an empty section explains how tasks start", () => {
  const html = text(
    renderToString(
      <EngineeringSection
        tasks={[]}
        details={{}}
        repos={[repo()]}
        lock={{ held: false }}
        now={NOW}
        handlers={{
          create: async () => null,
          approveDescription: async () => null,
          approvePlan: async () => null,
          cancel: noop,
        }}
      />,
    ),
  );
  expect(html).toMatch(/No engineering tasks/);
  expect(html).toContain("free");
});

test("the new task form needs a repository", () => {
  expect(text(renderToString(<NewTaskForm repos={[]} onCreate={async () => null} />))).toMatch(
    /Register a repository/,
  );
  const html = text(renderToString(<NewTaskForm repos={[repo()]} onCreate={async () => null} />));
  expect(html).toContain("synapse-demo");
  expect(html).toContain("Propose task");
});

test("the timeline lists the steps in order with their status, and the failure reason", () => {
  const html = text(
    renderToString(
      <TaskTimeline
        task={detail({
          status: "needs_attention",
          failure: "parent_conflict",
          steps: [
            {
              id: "1",
              step: "branch",
              status: "done",
              approvalId: null,
              claudeRunId: null,
              output: null,
              createdAt: "",
              updatedAt: "",
            },
            {
              id: "2",
              step: "develop",
              status: "failed",
              approvalId: null,
              claudeRunId: null,
              output: null,
              createdAt: "",
              updatedAt: "",
            },
          ],
        })}
      />,
    ),
  );
  expect(html.indexOf("Create branch")).toBeLessThan(html.indexOf("Develop"));
  expect(html).toMatch(/conflict/i);
});

// ---------------------------------------------------------------- Create task actions

test("a Jira row offers Create task only when the handler is given", () => {
  const status = {
    enabled: true,
    cloudIdSet: true,
    lastSyncAt: null,
    lastReconcileAt: null,
    issueCount: 1,
    lastError: null,
    scopeJql: "",
    excludedProjects: [] as string[],
  };
  const withHandler = renderToString(
    <JiraSection
      status={status}
      issues={[issue()]}
      now={NOW}
      onSync={noop}
      onGoToSetup={noop}
      onCreateTask={noop}
    />,
  );
  expect(withHandler).toContain("Create task");
  const without = renderToString(
    <JiraSection status={status} issues={[issue()]} now={NOW} onSync={noop} onGoToSetup={noop} />,
  );
  expect(without).not.toContain("Create task");
});

function actions() {
  const calls: string[] = [];
  const toasts: string[] = [];
  const errors: Array<string | null> = [];
  const api = new Proxy({} as NeedsYouApi, {
    get:
      (_t, name: string) =>
      (...args: unknown[]) => {
        calls.push(`${name}(${args.map((a) => JSON.stringify(a)).join(",")})`);
        return Promise.resolve({});
      },
  });
  const handlers = createNeedsYouActions({
    api,
    deferred: createDeferred({ delayMs: 5000 }),
    toast: { show: (t) => toasts.push(t) },
    refresh: async () => null,
    setActionError: (e) => errors.push(e),
    setDeferredError: () => {},
    committing: { add: () => {}, delete: () => {} },
    toggleHistory: () => {},
    seeAllPeople: () => {},
    seeAllJira: () => {},
    seeAllProjects: () => {},
    registerRepository: () => {},
  });
  return { handlers, calls, toasts, errors };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

test("Create task from a Jira row calls from-jira with the key, and from Slack with the message id", async () => {
  const { handlers, calls, toasts } = actions();
  handlers.createTaskFromJira("DEMO-1");
  handlers.createTaskFromSlack("m1");
  await settle();
  expect(calls).toEqual(['createTaskFromJira("DEMO-1")', 'createTaskFromSlack("m1")']);
  expect(toasts.join(" ")).toMatch(/Engineering/);
});

test("approve and reject of an engineering approval are immediate API calls, cancel too", async () => {
  const { handlers, calls } = actions();
  handlers.decide("a1", "approve");
  handlers.decide("a2", "reject");
  handlers.cancelEngineeringTask("t1");
  await settle();
  expect(calls).toEqual([
    'decideApproval("a1","approve",)',
    'decideApproval("a2","reject",)',
    'cancelEngineeringTask("t1")',
  ]);
});

test("page.tsx puts Engineering after Projects and feeds the footer lock from the overview", () => {
  const page = readFileSync(join(import.meta.dir, "../app/page.tsx"), "utf8");
  const at = (id: string) => page.indexOf(`id="${id}"`);
  expect(at("projects")).toBeLessThan(at("engineering"));
  expect(at("engineering")).toBeLessThan(at("people"));
  expect(page).toContain("lockText(overview?.engineeringLock)");
  expect(page).toContain("onCreateTask={feed.handlers.createTaskFromJira}");
});

// ---------------------------------------------------------------- final review (web)

test("description approval mounts the form only once the detail exists, keyed on id and updatedAt (I3)", () => {
  const t = task({ status: "proposed" });
  const loading = DescriptionApproval({ task: t, detail: null, onApprove: async () => null });
  expect(text(renderToString(loading))).toContain("Loading the description");
  expect(text(renderToString(loading))).not.toContain("<textarea");
  // The detail arrives: a fresh form element keyed on it, so its state starts from the detail.
  const d = detail({
    status: "proposed",
    approvedDescription: null,
    draftDescription: "the draft",
  });
  const ready = DescriptionApproval({ task: t, detail: d, onApprove: async () => null });
  expect(ready.type).toBe(DescriptionForm);
  expect(ready.key).toBe(`${d.id}:${d.updatedAt}`);
  expect(text(renderToString(ready))).toContain(">the draft</textarea>");
  // An edited, approved description is what comes back after a failed investigation.
  const again = DescriptionApproval({
    task: t,
    detail: detail({ status: "proposed", approvedDescription: "my edit", draftDescription: "x" }),
    onApprove: async () => null,
  });
  expect(text(renderToString(again))).toContain(">my edit</textarea>");
});

test("a Jira or Slack draft carries the note that someone else wrote it (I3)", () => {
  const render = (source: "manual" | "jira" | "slack") =>
    text(
      renderToString(
        DescriptionApproval({
          task: task({ status: "proposed", source }),
          detail: detail({ status: "proposed", source }),
          onApprove: async () => null,
        }),
      ),
    );
  expect(render("jira")).toContain(
    "From Jira: written by someone else. Review and edit before approving — only what you approve is given to Claude.",
  );
  expect(render("slack")).toContain("From Slack: written by someone else.");
  expect(render("manual")).not.toContain("written by someone else");
});

test("the commit card labels exact, partial and missing test runs (M1)", () => {
  const base = { diffHash: "h", files: [], filesTotal: 1, message: "m" };
  expect(
    card(approval("engineering.commit", { ...base, testsPassed: true, testRun: "exact" })),
  ).toContain("Tests passed");
  expect(
    card(approval("engineering.commit", { ...base, testsPassed: false, testRun: "exact" })),
  ).toContain("Tests failed");
  const partial = card(
    approval("engineering.commit", { ...base, testsPassed: true, testRun: "partial" }),
  );
  expect(partial).toContain("Partial test run (passed)");
  expect(partial).not.toContain("Tests passed");
  expect(
    card(approval("engineering.commit", { ...base, testsPassed: false, testRun: "partial" })),
  ).toContain("Partial test run (failed)");
  expect(
    card(approval("engineering.commit", { ...base, testsPassed: false, testRun: "none" })),
  ).toContain("Tests not run");
});

test("the merge PR card shows when the checks were read, preferring the fresher status (M6)", () => {
  const payload = {
    parentBranch: "main",
    prNumber: 7,
    prUrl: "https://github.com/o/r/pull/7",
    status: {
      state: "OPEN",
      mergeable: "MERGEABLE",
      checks: "pending",
      headSha: null,
      checkedAt: "2026-11-06T10:00:00.000Z",
    },
    pushedSha: "a".repeat(40),
    autoDeploys: false,
  };
  const html = card(approval("engineering.merge_pr", payload));
  expect(html).toMatch(/checks pending at \d{2}:\d{2}/);
  const fresh = detail({
    steps: [
      {
        id: "s",
        step: "merge_pr",
        status: "failed",
        approvalId: "a1",
        claudeRunId: null,
        output: {
          freshStatus: {
            state: "OPEN",
            mergeable: "MERGEABLE",
            checks: "failing",
            headSha: null,
            checkedAt: "2026-11-06T10:04:00.000Z",
          },
        },
        createdAt: "",
        updatedAt: "",
      },
    ],
  });
  const html2 = card(approval("engineering.merge_pr", payload), fresh);
  expect(html2).toMatch(/checks failing at \d{2}:\d{2}/);
  expect(html2).toMatch(/syn-chip--red/);
});

test("a queued task shows why its pickup is waiting to retry (I1)", () => {
  const html = text(
    renderToString(
      <EngineeringSection
        tasks={[task({ status: "queued", lastPickupError: "fetch_failed" })]}
        details={{}}
        repos={[repo()]}
        lock={{ held: false }}
        now={NOW}
        handlers={{
          create: async () => null,
          approveDescription: async () => null,
          approvePlan: async () => null,
          cancel: noop,
        }}
      />,
    ),
  );
  expect(html).toContain("Waiting to retry");
  expect(html).toMatch(/Fetching from the remote failed/);
  expect(html).not.toContain("fetch_failed");
});
