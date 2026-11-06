/**
 * Engineering automation end to end through the routes, the REAL ClaudeCliProvider, orchestrator
 * and validator, with a fake claude binary and a fake gh (never the real ones, never a real
 * remote): bare `file://` remotes, an upstream push URL of DISABLED.
 *
 * create -> approve-description -> investigate job -> approve-plan -> pickup -> branch, develop ->
 * commit / merge_local / push_pr / merge_pr approvals through /api/approvals -> completed.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Approval, EngineeringTaskDetail } from "@synapse/contracts";
import { schema } from "@synapse/database";
import { FakeClock } from "@synapse/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createApp } from "../../src/app";
import { type Container, createContainer } from "../../src/container";
import { loadConfig } from "../../src/core/config/config";
import { ClaudeCliProvider } from "../../src/integrations/claude-code/cli-provider";
import { GitHubCliProvider } from "../../src/integrations/github/gh-cli";
import { ENGINEERING_LEASE, STEP_JOB } from "../../src/modules/engineering-tasks/lock";
import { INVESTIGATE_JOB, PICKUP_JOB } from "../../src/modules/engineering-tasks/service";
import { type RemoteRepoFixture, remoteRepoFixture } from "../fixtures/engineering";
import { git, tempDir } from "../fixtures/git-repo";

const fakeClaude = resolve(import.meta.dir, "../fixtures/engineering-fake-claude.ts");
const NOW = "2026-11-06T12:00:00.000Z";
const roots: string[] = [];
const scratch = () => {
  const d = tempDir("eng-e2e-");
  roots.push(d);
  return d;
};
const signal = new AbortController().signal;
const ctx = { signal, checkpoint() {}, getCheckpoint: () => undefined } as never;

let ghDir: string;
let fakeGh: string;
beforeAll(() => {
  ghDir = scratch();
  fakeGh = join(ghDir, "gh");
  writeFileSync(
    fakeGh,
    `#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const d = import.meta.dir;
const argv = process.argv.slice(2);
appendFileSync(d + "/argv.log", JSON.stringify(argv) + "\\n");
const sub = argv[0] + " " + argv[1];
if (sub === "pr create") {
  writeFileSync(d + "/base.txt", argv[argv.indexOf("--base") + 1]);
  process.stdout.write("https://github.com/up/app/pull/7\\n");
}
if (sub === "pr view") {
  // The PR head is the fork branch's tip (origin.txt names the bare fork).
  const origin = readFileSync(d + "/origin.txt", "utf8");
  const base = readFileSync(d + "/base.txt", "utf8");
  const headRefOid = Bun.spawnSync(["git", "--git-dir", origin, "rev-parse", "refs/heads/" + base]).stdout.toString().trim();
  process.stdout.write(JSON.stringify({ number: 7, url: "u", state: "OPEN", mergeable: "MERGEABLE", statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }], headRefOid }));
}
process.exit(0);
`,
  );
  chmodSync(fakeGh, 0o755);
});
afterAll(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});
const ghCalls = (): string[][] => {
  const log = join(ghDir, "argv.log");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
};

let c: Container;
let app: ReturnType<typeof createApp>;
let fx: RemoteRepoFixture;
let repoId: string;
let outDir: string;
let savedHome: string | undefined;

beforeEach(async () => {
  const root = scratch();
  fx = remoteRepoFixture(root);
  writeFileSync(join(ghDir, "origin.txt"), fx.origin);
  outDir = join(root, "fake-out");
  mkdirSync(outDir);
  const credsPath = join(root, "creds.json");
  writeFileSync(
    credsPath,
    JSON.stringify({
      claudeAiOauth: { expiresAt: Date.parse(NOW) + 3_600_000, refreshTokenExpiresAt: 1.9e12 },
    }),
  );
  rmSync(join(ghDir, "argv.log"), { force: true });
  // The container's git runs with $HOME of the fixture (empty), so no developer config leaks in.
  savedHome = process.env.HOME;
  process.env.HOME = fx.home;
  const clock = new FakeClock(NOW);
  c = createContainer(
    loadConfig({
      SYNAPSE_DB_PATH: ":memory:",
      SYNAPSE_CLAUDE_CREDENTIALS: credsPath,
      HOME: fx.home,
    }),
    {
      run: async () => "Linger=no",
      clock,
      provider: new ClaudeCliProvider({
        binary: process.execPath,
        prefixArgs: ["run", fakeClaude],
        env: { PATH: process.env.PATH ?? "", HOME: fx.home, FAKE_ENG_DIR: outDir },
        clock,
        killGraceMs: 200,
      }),
      prs: new GitHubCliProvider({ binary: fakeGh }),
      // The fixture repository lives under the OS temp dir, which the real sandbox masks.
      sandboxMaskedRoots: [],
    },
  );
  app = createApp(c);
  const res = await send("POST", "/api/repos", {
    path: fx.repo,
    name: "app",
    trackedBranch: "main",
    environments: [
      { name: "prod", branch: "prod", protected: true, autoDeploysOnMerge: true },
      { name: "stage", branch: "stage", protected: false, autoDeploysOnMerge: true },
    ],
    jiraProjectKeys: [],
  });
  expect(res.status).toBe(201);
  repoId = ((await res.json()) as { id: string }).id;
  // The PR goes fork -> upstream on github.com; git itself pushes to the bare file:// origin.
  c.db
    .update(schema.repositories)
    .set({ originUrl: "https://github.com/fork/app", upstreamUrl: "https://github.com/up/app" })
    .where(eq(schema.repositories.id, repoId))
    .run();
  // Registration queues a first inspection; this e2e only wants engineering jobs.
  c.db.delete(schema.jobs).run();
});
afterEach(() => {
  c.sqlite.close();
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
});

const send = (method: string, path: string, body?: unknown) =>
  app.request(`http://127.0.0.1:7400${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const getTask = async (id: string) =>
  (await (await send("GET", `/api/engineering/tasks/${id}`)).json()) as EngineeringTaskDetail;
const seen = (kind: "investigate" | "develop") =>
  JSON.parse(readFileSync(join(outDir, `${kind}.json`), "utf8")) as {
    args: string[];
    cwd: string;
    autoMemory: string | null;
    tmpdir: string | null;
  };
const head = (dir: string, ref: string) => git(dir, "rev-parse", ref);
const branches = () => git(fx.repo, "branch", "--format=%(refname:short)").split("\n");
const leaseRow = () =>
  c.db.select().from(schema.leases).where(eq(schema.leases.name, ENGINEERING_LEASE)).get();

const DRAINED = [INVESTIGATE_JOB, STEP_JOB, "approval.execute"];
/** Delivers events (approval.approved -> approval.execute) and runs queued jobs until none is left. */
async function drain(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    c.dispatcher.dispatchOnce();
    const next = c.db
      .select()
      .from(schema.jobs)
      .where(and(inArray(schema.jobs.type, DRAINED), eq(schema.jobs.status, "PENDING")))
      .orderBy(sql`${schema.jobs}.rowid asc`)
      .get();
    if (!next) return;
    c.db.update(schema.jobs).set({ status: "COMPLETED" }).where(eq(schema.jobs.id, next.id)).run();
    const h = c.handlers.get(next.type);
    const job = c.queue.get(next.id);
    if (!h || !job) throw new Error(`no handler or job for ${next.type}`);
    await h.handler(job, ctx);
  }
  throw new Error("drain did not settle");
}

async function pending(action: string): Promise<Approval> {
  const list = (await (await send("GET", "/api/approvals")).json()) as Approval[];
  const a = list.find((x) => x.action === action);
  if (!a) throw new Error(`no pending ${action}`);
  return a;
}
async function decide(action: string, verb: "approve" | "reject"): Promise<Approval> {
  const a = await pending(action);
  const res = await send("POST", `/api/approvals/${a.id}/${verb}`, {});
  expect(res.status).toBe(200);
  await drain();
  return a;
}

/** create -> approve-description -> investigate -> approve-plan -> pickup -> branch + develop. */
async function developedTask(): Promise<string> {
  const created = await send("POST", "/api/engineering/tasks", {
    repositoryId: repoId,
    title: "Fix redirect",
    draftDescription: "draft: redirect after login is wrong",
  });
  expect(created.status).toBe(201);
  const id = ((await created.json()) as EngineeringTaskDetail).id;

  const ad = await send("POST", `/api/engineering/tasks/${id}/approve-description`, {
    description: "Fix the redirect after login.",
  });
  expect(ad.status).toBe(200);
  await drain();
  const planned = await getTask(id);
  expect(planned.status).toBe("planned");
  expect(planned.plan?.filesLikelyTouched).toEqual(["src/index.ts", "src/feature.ts"]);
  expect(planned.steps.map((s) => [s.step, s.status])).toEqual([["investigate", "done"]]);

  const ap = await send("POST", `/api/engineering/tasks/${id}/approve-plan`, {
    parentBranch: "main",
    testCommand: "bun test",
  });
  expect(ap.status).toBe(200);
  expect(((await ap.json()) as EngineeringTaskDetail).status).toBe("queued");

  // The minute tick: pickup takes the lock, then the branch and develop step jobs run.
  const pickup = c.handlers.get(PICKUP_JOB);
  expect(await pickup?.handler({} as never, ctx)).toEqual({ pickedUp: id });
  await drain();
  return id;
}

describe("engineering end to end (real provider, fake claude and gh)", () => {
  test("create to completed: scoped runs, approvals through the routes, parent pushed, PR created and merged", async () => {
    const id = await developedTask();

    // The investigation was read-only and path-scoped.
    const inv = seen("investigate");
    expect(inv.cwd).toBe(fx.repo);
    const invAllowed = (inv.args[inv.args.indexOf("--allowedTools") + 1] ?? "").split(",").sort();
    expect(invAllowed).toEqual(
      [`Glob(/${fx.repo}/**)`, `Grep(/${fx.repo}/**)`, `Read(/${fx.repo}/**)`].sort(),
    );

    // The develop run: scoped file tools plus exactly the confirmed test command.
    const dev = seen("develop");
    expect(dev.cwd).toBe(fx.repo);
    expect(dev.args[dev.args.indexOf("--permission-mode") + 1]).toBe("default");
    expect(dev.args).not.toContain("--tools");
    expect(dev.args).toContain("--no-session-persistence");
    expect(dev.autoMemory).toBe("1");
    expect(seen("investigate").autoMemory).toBe("1");
    // ADR-040: the develop run is sandboxed with a per-run TMPDIR, removed after the step job.
    const devSettings = JSON.parse(dev.args[dev.args.indexOf("--settings") + 1] ?? "{}");
    expect(devSettings.sandbox.enabled).toBe(true);
    expect(devSettings.sandbox.failIfUnavailable).toBe(true);
    expect(devSettings.sandbox.filesystem.allowRead).toEqual([dev.tmpdir]);
    expect(dev.tmpdir).toEndWith("/tmp");
    expect(dev.tmpdir).toContain("/runs/");
    // Task 4b: the run scratch is never under a request deny entry (the data dir is one).
    const requestMasks = (devSettings.sandbox.filesystem.denyRead as string[]).filter(
      (e) => !["/tmp", "/run", "/var/run"].includes(e),
    );
    expect(requestMasks.length).toBeGreaterThan(0);
    for (const e of requestMasks) {
      expect(dev.tmpdir === e || (dev.tmpdir as string).startsWith(`${e}/`)).toBe(false);
    }
    expect(existsSync(dev.tmpdir as string)).toBe(false);
    expect(existsSync(dirname(dev.tmpdir as string))).toBe(false);
    // The investigation is not sandboxed.
    const invSettings = JSON.parse(inv.args[inv.args.indexOf("--settings") + 1] ?? "{}");
    expect(invSettings).not.toHaveProperty("sandbox");
    expect(seen("investigate").tmpdir).toBeNull();
    const devAllowed = (dev.args[dev.args.indexOf("--allowedTools") + 1] ?? "").split(",").sort();
    expect(devAllowed).toEqual(
      [
        ...["Read", "Grep", "Glob", "Edit", "Write", "MultiEdit"].map(
          (t) => `${t}(/${fx.repo}/**)`,
        ),
        "Bash(bun test:*)",
      ].sort(),
    );
    // Only the approved description reaches the run, never the draft or the title.
    const prompt = dev.args[dev.args.indexOf("-p") + 1] ?? "";
    expect(prompt).toContain("Fix the redirect after login.");
    expect(prompt).not.toContain("draft: redirect");

    let t = await getTask(id);
    expect(t).toMatchObject({ status: "awaiting_approval", currentStep: "commit" });
    const taskBranch = t.taskBranch as string;
    const develop = t.steps.find((s) => s.step === "develop");
    expect(develop?.status).toBe("done");
    const devOut = develop?.output as {
      diffText: string;
      testOutputTail: string;
      testsPassed: boolean;
    };
    expect(devOut.testsPassed).toBe(true);
    expect(devOut.testOutputTail).toContain("3 pass");
    expect(devOut.diffText).toContain("redirect");
    expect((await send("GET", "/api/engineering/lock")).status).toBe(200);
    expect(await (await send("GET", "/api/engineering/lock")).json()).toMatchObject({
      held: true,
      taskId: id,
    });
    const overview = (await (await send("GET", "/api/dashboard/overview")).json()) as {
      counts: { engineeringAwaiting: number; approvals: number };
      engineeringLock: { held: boolean; taskTitle?: string };
    };
    expect(overview.counts.engineeringAwaiting).toBe(1);
    expect(overview.engineeringLock).toMatchObject({ held: true, taskTitle: "Fix redirect" });
    // The list never carries diff text.
    expect(await (await send("GET", "/api/engineering/tasks")).text()).not.toContain("diffText");

    const originMain = head(fx.origin, "main");
    const upstreamMain = head(fx.upstream, "main");
    await decide("engineering.commit", "approve");
    expect(git(fx.repo, "log", "-1", "--format=%B", taskBranch)).toContain(`Task: ${id}`);
    await decide("engineering.merge_local", "approve");
    await decide("engineering.push_pr", "approve");
    // The parent ref advanced on the bare origin; upstream was never pushed to.
    expect(head(fx.origin, "main")).not.toBe(originMain);
    expect(head(fx.origin, "main")).toBe(head(fx.repo, "main"));
    expect(head(fx.upstream, "main")).toBe(upstreamMain);

    await decide("engineering.merge_pr", "approve");
    const verbs = ghCalls()
      .filter((a) => a[0] === "pr" && ["create", "merge"].includes(a[1] ?? ""))
      .map((a) => a[1]);
    expect(verbs).toEqual(["create", "merge"]);

    t = await getTask(id);
    expect(t.status).toBe("completed");
    expect(t.prUrl).toBe("https://github.com/up/app/pull/7");
    expect(t.prNumber).toBe(7);
    expect(branches()).not.toContain(taskBranch);
    expect(leaseRow()).toBeUndefined();
    expect(await (await send("GET", "/api/engineering/lock")).json()).toEqual({ held: false });
  });

  test("rejecting the commit leaves no commit, cancels, deletes the branch, discards changes and frees the lock", async () => {
    const id = await developedTask();
    const taskBranch = (await getTask(id)).taskBranch as string;
    expect(branches()).toContain(taskBranch);
    const mainBefore = head(fx.repo, "main");
    expect(git(fx.repo, "status", "--porcelain")).not.toBe("");

    await decide("engineering.commit", "reject");

    const t = await getTask(id);
    expect(t.status).toBe("cancelled");
    expect(head(fx.repo, "main")).toBe(mainBefore);
    expect(head(fx.origin, "main")).toBe(mainBefore);
    expect(branches()).not.toContain(taskBranch);
    expect(git(fx.repo, "status", "--porcelain")).toBe("");
    expect(existsSync(join(fx.repo, "src", "feature.ts"))).toBe(false);
    expect(readFileSync(join(fx.repo, "src", "index.ts"), "utf8")).toBe("export {};\n");
    expect(git(fx.repo, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(leaseRow()).toBeUndefined();
    expect(ghCalls().filter((a) => a[1] === "create" || a[1] === "merge")).toEqual([]);
    expect(await (await send("GET", "/api/engineering/lock")).json()).toEqual({ held: false });
  });
});
