import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  type AIExecutionResult,
  type Approval,
  type ClaudeJobRequest,
  COMMIT_SUBJECT_MAX,
  isValidApprovalText,
  JobError,
  type Operation,
  type RawToolResult,
  SANDBOX_ROOT_MASKED_HINT,
} from "@synapse/contracts";
import { openDatabase, runMigrations, schema } from "@synapse/database";
import { FakeClock, newId } from "@synapse/shared";
import { and, eq, sql } from "drizzle-orm";
import type { Container } from "../../src/container";
import { ApprovalEngine } from "../../src/core/approvals/approvals";
import { AuditLogger } from "../../src/core/audit/audit";
import { SettingsService } from "../../src/core/config/settings";
import { OutboxDispatcher } from "../../src/core/events/dispatcher";
import { LiveBus } from "../../src/core/events/live-bus";
import { EventPublisher } from "../../src/core/events/publisher";
import { JobQueue } from "../../src/core/jobs/queue";
import type { HandlerRegistration } from "../../src/core/jobs/worker";
import { LeaseService } from "../../src/core/leases/leases";
import { assemblePrompt } from "../../src/core/orchestrator/prompt";
import { buildDenylist, DEFAULT_KNOWN_SERVERS } from "../../src/core/orchestrator/tool-catalog";
import { SANDBOX_REQUIRED_REASON, validateRequest } from "../../src/core/orchestrator/validator";
import { PermissionManager } from "../../src/core/permissions/permissions";
import { GitHubCliProvider } from "../../src/integrations/github/gh-cli";
import { LocalGitWorkflow } from "../../src/integrations/repository/git-workflow";
import { LocalGitProvider } from "../../src/integrations/repository/local-git";
import {
  buildDevelopRequest,
  SANDBOX_PATH_TOO_LONG_HINT,
  testResultFrom,
} from "../../src/intelligence/engineering/develop-prompt";
import { RepositoryRegistry } from "../../src/modules/engineering-brain/registry";
import {
  ENGINEERING_LEASE,
  EngineeringLock,
  STEP_JOB,
} from "../../src/modules/engineering-tasks/lock";
import { EngineeringTaskService } from "../../src/modules/engineering-tasks/service";
import { commitMessage, EngineeringStepService } from "../../src/modules/engineering-tasks/steps";
import {
  EngineeringTaskError,
  EngineeringTaskStore,
} from "../../src/modules/engineering-tasks/store";
import { engineeringRoutes } from "../../src/routes/engineering";
import {
  RUN_TMP_MAX_BYTES,
  registerStepJob,
  runScratchDir,
  sweepRunScratch,
} from "../../src/workers/engineering/steps";
import { type RemoteRepoFixture, remoteRepoFixture } from "../fixtures/engineering";
import { git, tempDir } from "../fixtures/git-repo";

const NOW = "2026-11-06T09:00:00.000Z";
const roots: string[] = [];
const scratch = () => {
  const d = tempDir("synapse-steps-");
  roots.push(d);
  return d;
};

/** Markers that must never reach audit rows or events. */
const DIFF_MARKER = "DIFF-MARKER-7c1";
const TEST_MARKER = "TEST-OUTPUT-MARKER-91a";
const FILE_MARKER = "path-marker-feature";
const APPROVED = "APPROVED-MARKER Fix the redirect after login.";

const ctx = {
  signal: new AbortController().signal,
  checkpoint() {},
  getCheckpoint: () => undefined,
} as never;

// ---- fake gh (a real executable the real GitHubCliProvider spawns) ------------------------------

let ghDir: string;
let fakeGh: string;
beforeAll(() => {
  ghDir = scratch();
  fakeGh = join(ghDir, "gh");
  writeFileSync(
    fakeGh,
    `#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const d = import.meta.dir;
const argv = process.argv.slice(2);
appendFileSync(d + "/argv.log", JSON.stringify(argv) + "\\n");
const cfg = existsSync(d + "/cfg.json") ? JSON.parse(readFileSync(d + "/cfg.json", "utf8")) : {};
const sub = argv[0] + " " + argv[1];
if (cfg.fail === sub) process.exit(1);
if (sub === "pr create") {
  // The PR head is the fork branch: remember which one, so pr view can report its tip.
  const base = argv[argv.indexOf("--base") + 1];
  require("node:fs").writeFileSync(d + "/pr.json", JSON.stringify({ base }));
  process.stdout.write("https://github.com/up/app/pull/7\\n");
}
if (sub === "pr view") {
  const { base } = JSON.parse(readFileSync(d + "/pr.json", "utf8"));
  const r = Bun.spawnSync(["git", "--git-dir", cfg.origin, "rev-parse", "refs/heads/" + base]);
  const headRefOid = r.stdout.toString().trim();
  const rollup = cfg.checks === "none" ? [] : [{ status: cfg.checkStatus ?? "COMPLETED", conclusion: cfg.checkStatus ? "" : (cfg.conclusion ?? "SUCCESS") }];
  process.stdout.write(JSON.stringify({ number: 7, url: "u", state: cfg.state ?? "OPEN", mergeable: cfg.mergeable ?? "MERGEABLE", statusCheckRollup: rollup, headRefOid: cfg.headRefOid ?? headRefOid }));
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

// ---- fake orchestrator --------------------------------------------------------------------------

const tool = (
  toolName: string,
  input: unknown,
  content: string,
  isError = false,
): RawToolResult => ({
  toolUseId: `t-${newId()}`,
  toolName,
  input,
  isError,
  content,
});

function aiResult(over: Partial<AIExecutionResult> = {}): AIExecutionResult {
  return {
    status: "succeeded",
    toolResults: [],
    finalText: "",
    numTurns: 3,
    durationMs: 10,
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      costUsdEquivalent: 0,
    },
    permissionDenials: [],
    connectors: [],
    availableTools: [],
    exitCode: 0,
    ...over,
  };
}

const modelReply = (testsPassed: boolean) =>
  `Done.\n\`\`\`json\n${JSON.stringify({
    summary: "Changed the redirect.",
    testsPassed,
    testOutputTail: "model claims all good",
    notes: "",
  })}\n\`\`\``;

/** The develop "run": edits files in the repo (side effect) and returns crafted tool results. */
function editingRun(
  files: Record<string, string> = {
    "src/index.ts": `export const redirect = "${DIFF_MARKER}";\n`,
    [`src/${FILE_MARKER}.ts`]: "export const x = 1;\n",
  },
  bash: RawToolResult[] = [tool("Bash", { command: "bun test" }, `3 pass\n0 fail\n${TEST_MARKER}`)],
  testsClaim = true,
) {
  return (req: ClaudeJobRequest) => {
    const wd = req.workingDirectory as string;
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(join(wd, rel, ".."), { recursive: true });
      writeFileSync(join(wd, rel), content);
    }
    return aiResult({
      toolResults: [tool("Edit", { file_path: join(wd, "src/index.ts") }, "ok"), ...bash],
      finalText: modelReply(testsClaim),
    });
  };
}

// ---- harness ------------------------------------------------------------------------------------

let db: ReturnType<typeof openDatabase>["db"];
let clock: FakeClock;
let settings: SettingsService;
let queue: JobQueue;
let leases: LeaseService;
let audit: AuditLogger;
let events: EventPublisher;
let handlers: Map<string, HandlerRegistration>;
let approvals: ApprovalEngine;
let dispatcher: OutboxDispatcher;
let workflow: LocalGitWorkflow;
let lock: EngineeringLock;
let service: EngineeringTaskService;
let steps: EngineeringStepService;
let fx: RemoteRepoFixture;
let repo: string;
let repoId: string;
let requests: ClaudeJobRequest[];
let reply: (req: ClaudeJobRequest) => AIExecutionResult;
/** The step worker's run root: develop runs get `<it>/r/<8 hex of sha256(jobId)>/t` (ADR-040). */
let sandboxScratch: string;

const taskRow = (id: string) =>
  db.select().from(schema.engineeringTasks).where(eq(schema.engineeringTasks.id, id)).get();
const stepRow = (id: string, step: string) =>
  db
    .select()
    .from(schema.engineeringTaskSteps)
    .where(
      and(
        eq(schema.engineeringTaskSteps.taskId, id),
        eq(schema.engineeringTaskSteps.step, step as never),
      ),
    )
    .get();
const leaseRow = () =>
  db.select().from(schema.leases).where(eq(schema.leases.name, ENGINEERING_LEASE)).get();
const auditDump = () => JSON.stringify(db.select().from(schema.auditEvents).all());
const eventDump = () => JSON.stringify(db.select().from(schema.domainEvents).all());
const approvalRow = (id: string) =>
  db.select().from(schema.approvals).where(eq(schema.approvals.id, id)).get();
const pendingOf = (action: Operation): Approval | undefined =>
  approvals.listPending().find((a) => a.action === action);

/** One-shot callbacks run right after the named git or gh method returns (to interleave events). */
let hooks: Record<string, () => void> = {};
function hooked<T extends object>(target: T): T {
  return new Proxy(target, {
    get(t, prop, recv) {
      const v = Reflect.get(t, prop, recv);
      if (typeof v !== "function") return v;
      const fire = () => {
        const hook = hooks[String(prop)];
        if (hook) {
          delete hooks[String(prop)];
          hook();
        }
      };
      return (...args: unknown[]) => {
        const r = v.apply(t, args);
        if (r instanceof Promise) {
          return r.then((x) => {
            fire();
            return x;
          });
        }
        fire();
        return r;
      };
    },
  });
}

/** True when a PENDING `engineering.step` job for this task and step is queued. */
const pendingStep = (taskId: string, step: string): boolean =>
  db
    .select()
    .from(schema.jobs)
    .where(and(eq(schema.jobs.type, STEP_JOB), eq(schema.jobs.status, "PENDING")))
    .all()
    .some((j) => {
      const i = j.input as { taskId?: string; step?: string } | null;
      return i?.taskId === taskId && i?.step === step;
    });

/** Runs queued `engineering.step` jobs in order until none is left. */
async function drain(): Promise<void> {
  const h = handlers.get(STEP_JOB);
  if (!h) throw new Error("step handler not registered");
  for (let i = 0; i < 20; i++) {
    const next = db
      .select()
      .from(schema.jobs)
      .where(and(eq(schema.jobs.type, STEP_JOB), eq(schema.jobs.status, "PENDING")))
      .orderBy(sql`${schema.jobs}.rowid asc`)
      .get();
    if (!next) return;
    db.update(schema.jobs).set({ status: "COMPLETED" }).where(eq(schema.jobs.id, next.id)).run();
    const job = queue.get(next.id);
    if (!job) throw new Error("job vanished");
    await h.handler(job, ctx);
  }
  throw new Error("drain did not settle");
}

/** Approves the pending approval for `action`, executes it, delivers events, runs step jobs. */
async function approve(action: Operation) {
  const a = pendingOf(action);
  if (!a) throw new Error(`no pending ${action}`);
  approvals.approve(a.id);
  const outcome = await approvals.execute(a.id);
  dispatcher.dispatchOnce();
  await drain();
  return { approval: a, outcome };
}

async function reject(action: Operation) {
  const a = pendingOf(action);
  if (!a) throw new Error(`no pending ${action}`);
  approvals.reject(a.id, "no");
  dispatcher.dispatchOnce();
  await drain();
  return a;
}

const PLAN = {
  summary: "Fix the redirect.",
  plan: [{ step: "Change the handler" }],
  filesLikelyTouched: ["src/index.ts"],
  testCommand: "bun test",
  risk: "low" as const,
  size: "s" as const,
  unclear: [],
};

/** A task picked up under the lock, with its branch and develop steps run. */
async function developed(parentBranch = "main"): Promise<string> {
  const t = service.create({ repositoryId: repoId, title: "Fix redirect", draftDescription: "x" });
  db.update(schema.engineeringTasks)
    .set({ status: "planned", approvedDescription: APPROVED, plan: PLAN })
    .where(eq(schema.engineeringTasks.id, t.id))
    .run();
  await service.approvePlan(t.id, { parentBranch, testCommand: "bun test" });
  expect(await service.pickupNext()).toEqual({ pickedUp: t.id });
  await drain();
  return t.id;
}

const head = (dir: string, ref: string) => git(dir, "rev-parse", ref);
const protectMain = () =>
  db
    .insert(schema.repositoryEnvironments)
    .values({
      id: newId(),
      repositoryId: repoId,
      name: "main-env",
      branch: "main",
      protected: true,
      autoDeploysOnMerge: false,
    })
    .run();
const restartLockOf = () =>
  new EngineeringLock({
    db,
    clock,
    leases,
    settings,
    events,
    audit,
    git: workflow,
    queue,
    approvals,
  });
const branches = () => git(repo, "branch", "--format=%(refname:short)").split("\n");

/** Pushes a commit changing README.md to `bare`'s `branch` from a throwaway clone. */
function pushRemoteCommit(bare: string, content: string, branch = "main"): void {
  const dir = join(scratch(), "c");
  git(scratch(), "clone", "-q", "-b", branch, `file://${bare}`, dir);
  git(dir, "config", "user.email", "x@example.com");
  git(dir, "config", "user.name", "X");
  writeFileSync(join(dir, "README.md"), content);
  git(dir, "commit", "-q", "-am", "remote change");
  git(dir, "push", "-q", "origin", branch);
}

beforeEach(async () => {
  db = openDatabase(":memory:").db;
  runMigrations(db);
  clock = new FakeClock(NOW);
  settings = new SettingsService(db, clock, () => "e");
  events = new EventPublisher(clock);
  audit = new AuditLogger(clock);
  queue = new JobQueue(db, clock);
  leases = new LeaseService(db, clock);
  handlers = new Map();
  approvals = new ApprovalEngine(db, clock, events, audit, new PermissionManager(db, audit));
  dispatcher = new OutboxDispatcher(db, clock, new LiveBus());
  fx = remoteRepoFixture(scratch());
  repo = fx.repo;
  const provider = new LocalGitProvider({ home: fx.home });
  const registry = new RepositoryRegistry({ db, clock, audit, events, provider });
  const view = await registry.register({
    path: repo,
    name: "app",
    trackedBranch: "main",
    environments: [
      { name: "prod", branch: "prod", protected: true, autoDeploysOnMerge: true },
      { name: "stage", branch: "stage", protected: false, autoDeploysOnMerge: true },
    ],
    jiraProjectKeys: [],
  });
  repoId = view.id;
  // The PR goes fork → upstream on github.com (stored URLs); git itself pushes to the bare file:// origin.
  db.update(schema.repositories)
    .set({ originUrl: "https://github.com/fork/app", upstreamUrl: "https://github.com/up/app" })
    .where(eq(schema.repositories.id, repoId))
    .run();
  workflow = new LocalGitWorkflow({ home: fx.home, extraEnv: { GIT_CONFIG_NOSYSTEM: "1" } });
  lock = new EngineeringLock({
    db,
    clock,
    leases,
    settings,
    events,
    audit,
    git: workflow,
    queue,
    approvals,
  });
  service = new EngineeringTaskService({
    db,
    clock,
    events,
    audit,
    queue,
    provider,
    registry,
    lock,
    git: workflow,
  });
  hooks = {};
  const gh = new GitHubCliProvider({ binary: fakeGh });
  steps = new EngineeringStepService({
    db,
    clock,
    events,
    audit,
    queue,
    approvals,
    lock,
    git: hooked(workflow),
    prs: hooked(gh),
  });
  steps.register(approvals, dispatcher);
  requests = [];
  reply = editingRun();
  sandboxScratch = scratch();
  registerStepJob({
    db,
    settings,
    steps,
    handlers,
    orchestrator: {
      run: async (req: ClaudeJobRequest) => {
        requests.push(req);
        return reply(req);
      },
    },
    // The test repositories live under the OS temp dir, which the real sandbox masks.
    sandbox: {
      runRoot: sandboxScratch,
      home: fx.home,
      protectedDirs: [join(sandboxScratch, "data")],
      maskedRoots: [],
    },
  });
  rmSync(join(ghDir, "argv.log"), { force: true });
  rmSync(join(ghDir, "pr.json"), { force: true });
  writeFileSync(join(ghDir, "cfg.json"), JSON.stringify({ origin: fx.origin }));
});

// ---- tests --------------------------------------------------------------------------------------

describe("develop request (E9)", () => {
  test("scoped tools pass rule L; only system and user_approved parts; settings drive it", async () => {
    settings.set("engineering.model", "opus");
    settings.set("engineering.develop.maxTurns", 40);
    settings.set("engineering.develop.timeoutMinutes", 25);
    await developed();
    const req = requests[0] as ClaudeJobRequest;
    expect(req.workerProfile).toBe("engineering");
    expect(req.workingDirectory).toBe(repo);
    expect(req.allowedTools).toEqual([
      `Read(/${repo}/**)`,
      `Grep(/${repo}/**)`,
      `Glob(/${repo}/**)`,
      `Edit(/${repo}/**)`,
      `Write(/${repo}/**)`,
      `MultiEdit(/${repo}/**)`,
      "Bash(bun test:*)",
    ]);
    expect(req.model).toBe("opus");
    expect(req.maxTurns).toBe(40);
    expect(req.timeoutMs).toBe(25 * 60_000);
    const parts = req.parts ?? [];
    expect(parts.every((p) => p.provenance === "system" || p.provenance === "user_approved")).toBe(
      true,
    );
    const approved = parts.filter((p) => p.provenance === "user_approved");
    expect(approved.map((p) => p.source)).toEqual([
      "engineering_task.approved_description",
      "engineering_task.plan",
    ]);
    expect(approved[0]?.content).toBe(APPROVED);
    expect(JSON.parse(approved[1]?.content ?? "{}").plan).toEqual(PLAN.plan);
    // Neither the draft nor the title reaches the run.
    expect(JSON.stringify(req)).not.toContain("Fix redirect");
    const system = parts.find((p) => p.provenance === "system")?.content ?? "";
    for (const s of [".gitattributes", ".gitmodules", ".lfsconfig", "commit"]) {
      expect(system).toContain(s);
    }
  });

  test("the built request passes the real validator (rule L), with turns capped at 50", () => {
    const req = buildDevelopRequest(
      { approvedDescription: APPROVED, plan: PLAN },
      { localPath: "/home/demo/app", testCommand: "bun test" },
      {
        model: "sonnet",
        maxTurns: 60,
        timeoutMinutes: 30,
        sandbox: {
          tmpDir: "/home/demo/.cache/synapse/0123abcd/r/89abcdef/t",
          home: "/home/demo",
          protectedDirs: ["/home/demo/.local/share/synapse"],
        },
      },
    );
    expect(req.maxTurns).toBe(50);
    const parts = req.parts ?? [];
    const r = validateRequest(
      {
        runId: "r",
        jobId: null,
        workerProfile: req.workerProfile,
        model: "sonnet",
        systemPrompt: req.systemPrompt ?? "",
        prompt: assemblePrompt(req.instructions, parts, "BND"),
        promptParts: parts,
        allowedTools: req.allowedTools,
        disallowedTools: buildDenylist(req.allowedTools, DEFAULT_KNOWN_SERVERS, "engineering"),
        maxTurns: req.maxTurns,
        timeoutMs: req.timeoutMs ?? 0,
        workingDirectory: req.workingDirectory ?? "",
        ...(req.sandbox ? { sandbox: req.sandbox } : {}),
      },
      DEFAULT_KNOWN_SERVERS,
      { instructions: req.instructions, boundary: "BND" },
    );
    expect(r).toEqual({ ok: true });
  });
});

describe("develop sandbox (ADR-040)", () => {
  const hex = (jobId: string) => createHash("sha256").update(jobId).digest("hex");
  const runDir = (jobId: string) => join(sandboxScratch, "r", hex(jobId).slice(0, 8));

  test("the develop request carries the per-run tmpDir and the deny list", async () => {
    await developed();
    const req = requests[0] as ClaudeJobRequest;
    const jobId = req.jobId as string;
    expect(jobId).toBeTruthy();
    expect(req.sandbox?.tmpDir).toBe(join(runDir(jobId), "t"));
    expect(req.sandbox?.denyRead).toContain(join(fx.home, ".ssh"));
    expect(req.sandbox?.denyRead).toContain(join(sandboxScratch, "data"));
  });

  test("the run root and r dir are created 0700, outside every deny entry (Task 4b)", async () => {
    const root = join(scratch(), "cache", "synapse");
    handlers.delete(STEP_JOB);
    registerStepJob({
      db,
      settings,
      steps,
      handlers,
      orchestrator: {
        run: async (req: ClaudeJobRequest) => {
          requests.push(req);
          return reply(req);
        },
      },
      sandbox: {
        runRoot: root,
        home: fx.home,
        protectedDirs: [join(sandboxScratch, "data")],
        maskedRoots: [],
      },
    });
    const id = await developed();
    expect(taskRow(id)?.status).toBe("awaiting_approval");
    const req = requests[0] as ClaudeJobRequest;
    expect(req.sandbox?.tmpDir).toBe(join(root, "r", hex(req.jobId as string).slice(0, 8), "t"));
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, "r")).mode & 0o777).toBe(0o700);
    const tmp = req.sandbox?.tmpDir as string;
    for (const e of req.sandbox?.denyRead ?? []) {
      expect(tmp === e || tmp.startsWith(`${e}/`)).toBe(false);
    }
  });

  test("sandbox placeholders left by the run are removed before the diff check (Task 4b)", async () => {
    // Some git templates ship an empty branches/: make the observed set exactly new.
    rmSync(join(repo, ".git", "branches"), { recursive: true, force: true });
    const edit = editingRun();
    reply = (req) => {
      const wd = req.workingDirectory as string;
      for (const d of [
        "branches",
        "remotes",
        "objects/info/commit-graphs/.claude-sandbox-noreplace",
        "info/.claude-sandbox-noreplace",
        "objects/info/.claude-sandbox-noreplace",
      ]) {
        mkdirSync(join(wd, ".git", d), { recursive: true });
      }
      writeFileSync(join(wd, ".git", "config.worktree"), "");
      writeFileSync(join(wd, ".git", "objects", "info", "alternates"), "");
      mkdirSync(join(wd, ".claude", ".cc-writes"), { recursive: true });
      return edit(req);
    };
    const id = await developed();
    expect(taskRow(id)?.status).toBe("awaiting_approval");
    const out = stepRow(id, "develop")?.output as Record<string, unknown>;
    expect(out.sandboxPlaceholdersRemoved).toBe(10);
    expect(out.unsafeReasons).toEqual([]);
    expect(existsSync(join(repo, ".claude"))).toBe(false);
    expect(existsSync(join(repo, ".git", "config.worktree"))).toBe(false);
    expect(pendingOf("engineering.commit")).toBeDefined();
  });

  test("a non-empty placeholder is kept and the run is unsafe (Task 4b)", async () => {
    const edit = editingRun();
    reply = (req) => {
      const wd = req.workingDirectory as string;
      mkdirSync(join(wd, ".git", "info", ".claude-sandbox-noreplace"), { recursive: true });
      writeFileSync(join(wd, ".git", "objects", "info", "alternates"), "/elsewhere/objects\n");
      return edit(req);
    };
    const id = await developed();
    expect(taskRow(id)?.status).toBe("needs_attention");
    expect(taskRow(id)?.failure).toBe("unsafe_change");
    const out = stepRow(id, "develop")?.output as Record<string, unknown>;
    expect(out.sandboxPlaceholdersRemoved).toBe(1);
    expect(out.unsafeReasons).toEqual(["git_dir_changed"]);
    expect(existsSync(join(repo, ".git", "objects", "info", "alternates"))).toBe(true);
    expect(pendingOf("engineering.commit")).toBeUndefined();
  });

  test("placeholders are also removed after a failed run, so a clean tree fails cleanly (Task 4b)", async () => {
    rmSync(join(repo, ".git", "branches"), { recursive: true, force: true });
    reply = (req) => {
      const wd = req.workingDirectory as string;
      mkdirSync(join(wd, ".git", "branches"), { recursive: true });
      writeFileSync(join(wd, ".git", "config.worktree"), "");
      throw new JobError({ kind: "timeout", message: "timed out" });
    };
    const id = await developed();
    expect(taskRow(id)?.status).toBe("failed");
    expect(taskRow(id)?.failure).toBe("timeout");
    const out = stepRow(id, "develop")?.output as Record<string, unknown>;
    expect(out.sandboxPlaceholdersRemoved).toBe(2);
    expect(existsSync(join(repo, ".git", "branches"))).toBe(false);
  });

  test("run dir names: 8 hex of sha256(jobId), longer on a collision, null when all are taken (fix round 2)", () => {
    const h = hex("job-1");
    const taken = new Set<string>();
    const exists = (p: string) => taken.has(p);
    expect(runScratchDir("/c/s/0123abcd", "job-1", exists)).toBe(
      `/c/s/0123abcd/r/${h.slice(0, 8)}`,
    );
    taken.add(`/c/s/0123abcd/r/${h.slice(0, 8)}`);
    expect(runScratchDir("/c/s/0123abcd", "job-1", exists)).toBe(
      `/c/s/0123abcd/r/${h.slice(0, 12)}`,
    );
    taken.add(`/c/s/0123abcd/r/${h.slice(0, 12)}`);
    taken.add(`/c/s/0123abcd/r/${h.slice(0, 16)}`);
    expect(runScratchDir("/c/s/0123abcd", "job-1", exists)).toBeNull();
    // The path the observed real-CLI layout needs: well under the 64-byte limit.
    const t = `${runScratchDir("/home/demo1/.cache/synapse/0123abcd", "job-1", () => false)}/t`;
    expect(Buffer.byteLength(t)).toBeLessThanOrEqual(RUN_TMP_MAX_BYTES);
    expect(RUN_TMP_MAX_BYTES).toBe(64);
  });

  test("a tmpDir over 64 bytes refuses the run: sandbox_path_too_long, nothing created (fix round 2)", async () => {
    const root = join(scratch(), "x".repeat(70));
    handlers.delete(STEP_JOB);
    registerStepJob({
      db,
      settings,
      steps,
      handlers,
      orchestrator: {
        run: async (req: ClaudeJobRequest) => {
          requests.push(req);
          return reply(req);
        },
      },
      sandbox: { runRoot: root, home: fx.home, protectedDirs: [], maskedRoots: [] },
    });
    const id = await developed();
    expect(requests).toHaveLength(0);
    expect(taskRow(id)?.status).toBe("needs_attention");
    expect(taskRow(id)?.failure).toBe("sandbox_path_too_long");
    const out = stepRow(id, "develop")?.output as Record<string, unknown>;
    expect(out.hint).toBe(SANDBOX_PATH_TOO_LONG_HINT);
    expect(SANDBOX_PATH_TOO_LONG_HINT).toContain("XDG_CACHE_HOME");
    expect(existsSync(root)).toBe(false);
    expect(leaseRow()).toBeDefined();
    expect(pendingStep(id, "cleanup")).toBe(false);
  });

  test("a run root inside a masked path refuses the run: sandbox_root_masked, nothing created (H4.6)", async () => {
    const root = join(fx.home, ".config", "c", "synapse", "abcd1234");
    handlers.delete(STEP_JOB);
    registerStepJob({
      db,
      settings,
      steps,
      handlers,
      orchestrator: {
        run: async (req: ClaudeJobRequest) => {
          requests.push(req);
          return reply(req);
        },
      },
      sandbox: { runRoot: root, home: fx.home, protectedDirs: [], maskedRoots: [] },
    });
    const id = await developed();
    expect(requests).toHaveLength(0);
    expect(taskRow(id)?.status).toBe("needs_attention");
    expect(taskRow(id)?.failure).toBe("sandbox_root_masked");
    const out = stepRow(id, "develop")?.output as Record<string, unknown>;
    expect(out.hint).toBe(SANDBOX_ROOT_MASKED_HINT);
    expect(existsSync(root)).toBe(false);
    expect(leaseRow()).toBeDefined();
    expect(pendingStep(id, "cleanup")).toBe(false);
  });

  test("a sandbox init failure inside the Bash tool_result is sandbox_unavailable, not failed tests (fix round 2)", async () => {
    const msg =
      "Sandbox is required but failed to initialize: Failed to create bridge sockets after 5 attempts. Restart to retry. Running it outside the sandbox (dangerouslyDisableSandbox) is not allowed either.";
    reply = editingRun(undefined, [tool("Bash", { command: "bun test" }, msg, true)], false);
    const id = await developed();
    expect(taskRow(id)?.status).toBe("needs_attention");
    expect(taskRow(id)?.failure).toBe("sandbox_unavailable");
    const out = stepRow(id, "develop")?.output as Record<string, unknown>;
    expect(out.failure).toBe("sandbox_unavailable");
    expect(out.testsPassed).toBeUndefined();
    expect(pendingOf("engineering.commit")).toBeUndefined();
    expect(leaseRow()).toBeDefined();
  });

  test("a failing test run that merely mentions a sandbox stays an ordinary result (fix round 2)", async () => {
    reply = editingRun(
      undefined,
      [tool("Bash", { command: "bun test" }, "1 fail\nexpected sandbox to be ready", true)],
      false,
    );
    const id = await developed();
    expect(taskRow(id)?.status).toBe("awaiting_approval");
    const out = stepRow(id, "develop")?.output as Record<string, unknown>;
    expect(out.testsPassed).toBe(false);
  });

  test("passing test output that mentions an unavailable sandbox stays an ordinary result (final review)", async () => {
    reply = editingRun(
      undefined,
      [
        tool(
          "Bash",
          { command: "bun test" },
          "(pass) api > returns 503 when the sandbox is unavailable\n1 pass\n0 fail",
          false,
        ),
      ],
      true,
    );
    const id = await developed();
    expect(taskRow(id)?.status).toBe("awaiting_approval");
    expect(taskRow(id)?.failure).toBeNull();
  });

  test("the CLI sandbox message after an Exit code line is still sandbox_unavailable (final review)", async () => {
    reply = editingRun(
      undefined,
      [
        tool(
          "Bash",
          { command: "bun test" },
          "Exit code 1\nSandbox is required but failed to initialize: x",
          true,
        ),
      ],
      false,
    );
    const id = await developed();
    expect(taskRow(id)?.failure).toBe("sandbox_unavailable");
  });

  test("generated commit subject and PR title are capped at the edit limits (final review)", () => {
    const title = "t".repeat(300);
    const msg = commitMessage({ id: "tk", title, approvedDescription: null });
    expect((msg.split("\n")[0] ?? "").length).toBe(COMMIT_SUBJECT_MAX);
    expect(isValidApprovalText("commitMessage", msg.split("\n")[0] ?? "")).toBe(true);
  });

  test("with the setting off the request has no sandbox", async () => {
    settings.set("engineering.sandbox.enabled", false);
    await developed();
    expect(requests).toHaveLength(1);
    expect("sandbox" in (requests[0] as ClaudeJobRequest)).toBe(false);
  });

  test("the run scratch is removed after a run that returns (Review Focus 5)", async () => {
    const seen: string[] = [];
    const edit = editingRun();
    reply = (req) => {
      const tmp = req.sandbox?.tmpDir as string;
      mkdirSync(tmp, { recursive: true });
      writeFileSync(join(tmp, "x"), "x");
      seen.push(req.jobId as string);
      return edit(req);
    };
    const id = await developed();
    expect(taskRow(id)?.status).toBe("awaiting_approval");
    expect(seen).toHaveLength(1);
    expect(existsSync(runDir(seen[0] as string))).toBe(false);
  });

  test("the run scratch is removed after a run that throws (Review Focus 5)", async () => {
    const seen: string[] = [];
    reply = (req) => {
      mkdirSync(req.sandbox?.tmpDir as string, { recursive: true });
      seen.push(req.jobId as string);
      throw new JobError({ kind: "timeout", message: "timed out" });
    };
    const id = await developed();
    expect(taskRow(id)?.failure).toBe("timeout");
    expect(seen).toHaveLength(1);
    expect(existsSync(runDir(seen[0] as string))).toBe(false);
  });

  test("a sandbox that cannot start needs attention, keeps the lock, makes no approval (F1.4)", async () => {
    reply = () => {
      throw new JobError({
        kind: "provider_error",
        message: "sandbox unavailable",
        details: { sandboxUnavailable: true },
      });
    };
    const id = await developed();
    expect(taskRow(id)?.status).toBe("needs_attention");
    expect(taskRow(id)?.failure).toBe("sandbox_unavailable");
    expect((stepRow(id, "develop")?.output as Record<string, unknown> | null)?.failure).toBe(
      "sandbox_unavailable",
    );
    expect(leaseRow()).toBeDefined();
    expect(pendingOf("engineering.commit")).toBeUndefined();
  });

  test("rule M's refusal surfaces as sandbox_disabled and keeps the lock (F1.5, H4.6)", async () => {
    reply = () => {
      throw new JobError({ kind: "invalid_input", message: SANDBOX_REQUIRED_REASON });
    };
    const id = await developed();
    expect(taskRow(id)?.status).toBe("needs_attention");
    expect(taskRow(id)?.failure).toBe("sandbox_disabled");
    expect(leaseRow()).toBeDefined();
    expect(pendingStep(id, "cleanup")).toBe(false);
  });

  test("sandbox denial text in a passing run does not flip testsPassed (F1.4)", () => {
    expect(
      testResultFrom(
        [tool("Bash", { command: "bun test" }, "1 pass\nsandbox: network request denied")],
        "bun test",
      ).testsPassed,
    ).toBe(true);
  });

  test("a cleanup failure never replaces the run's result (fix round 1)", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    let locked = "";
    const edit = editingRun();
    reply = (req) => {
      locked = join(req.sandbox?.tmpDir as string, "locked");
      mkdirSync(join(locked, "inner"), { recursive: true });
      chmodSync(locked, 0o000);
      return edit(req);
    };
    try {
      const id = await developed();
      expect(taskRow(id)?.status).toBe("awaiting_approval");
      expect(errors.mock.calls).toEqual([["engineering.step: run scratch cleanup failed"]]);
    } finally {
      errors.mockRestore();
      chmodSync(locked, 0o755);
    }
  });

  test("a cleanup failure never replaces the run's error (fix round 1)", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    let locked = "";
    reply = (req) => {
      locked = join(req.sandbox?.tmpDir as string, "locked");
      mkdirSync(join(locked, "inner"), { recursive: true });
      chmodSync(locked, 0o000);
      throw new JobError({ kind: "timeout", message: "timed out" });
    };
    try {
      const id = await developed();
      expect(taskRow(id)?.failure).toBe("timeout");
      expect(errors.mock.calls).toEqual([["engineering.step: run scratch cleanup failed"]]);
    } finally {
      errors.mockRestore();
      chmodSync(locked, 0o755);
    }
  });

  test("a repository inside the data dir is refused (repo_in_masked_path, fix round 2)", async () => {
    handlers.delete(STEP_JOB);
    registerStepJob({
      db,
      settings,
      steps,
      handlers,
      orchestrator: {
        run: async (req: ClaudeJobRequest) => {
          requests.push(req);
          return reply(req);
        },
      },
      // The repository's parent stands in for the Synapse data dir.
      sandbox: {
        runRoot: sandboxScratch,
        home: fx.home,
        protectedDirs: [join(repo, "..")],
        maskedRoots: [],
      },
    });
    const id = await developed();
    expect(requests).toHaveLength(0);
    expect(taskRow(id)?.status).toBe("failed");
    expect(taskRow(id)?.failure).toBe("repo_in_masked_path");
    expect(leaseRow()).toBeUndefined();
  });

  test("a repository inside a home deny entry is refused (repo_in_masked_path, fix round 1)", async () => {
    // A second fixture whose repository lives under `<home>/.config`.
    const home = scratch();
    mkdirSync(join(home, ".config"));
    const fx2 = remoteRepoFixture(join(home, ".config"));
    const registry2 = new RepositoryRegistry({
      db,
      clock,
      audit,
      events,
      provider: new LocalGitProvider({ home: fx2.home }),
    });
    const view = await registry2.register({
      path: fx2.repo,
      name: "demo",
      trackedBranch: "main",
      environments: [],
      jiraProjectKeys: [],
    });
    repoId = view.id;
    repo = fx2.repo;
    handlers.delete(STEP_JOB);
    registerStepJob({
      db,
      settings,
      steps,
      handlers,
      orchestrator: {
        run: async (req: ClaudeJobRequest) => {
          requests.push(req);
          return reply(req);
        },
      },
      sandbox: { runRoot: sandboxScratch, home, protectedDirs: [], maskedRoots: [] },
    });
    const id = await developed();
    expect(requests).toHaveLength(0);
    expect(taskRow(id)?.status).toBe("failed");
    expect(taskRow(id)?.failure).toBe("repo_in_masked_path");
    expect(leaseRow()).toBeUndefined();
  });

  test("a repository in a masked path is refused before any run (repo_in_masked_path)", async () => {
    handlers.delete(STEP_JOB);
    registerStepJob({
      db,
      settings,
      steps,
      handlers,
      orchestrator: {
        run: async (req: ClaudeJobRequest) => {
          requests.push(req);
          return reply(req);
        },
      },
      // The repository's parent stands in for /tmp (the default roots are tested in
      // develop-prompt.test.ts).
      sandbox: {
        runRoot: sandboxScratch,
        home: fx.home,
        protectedDirs: [],
        maskedRoots: [join(repo, "..")],
      },
    });
    const id = await developed();
    expect(requests).toHaveLength(0);
    expect(taskRow(id)?.status).toBe("failed");
    expect(taskRow(id)?.failure).toBe("repo_in_masked_path");
    expect(leaseRow()).toBeUndefined();
  });
});

describe("happy path (E8–E15)", () => {
  test("develop → commit → update → merge_local → push + PR → merge_pr → completed, cleaned, lock released", async () => {
    const id = await developed();
    const task = taskRow(id);
    expect(task?.status).toBe("awaiting_approval");
    expect(task?.currentStep).toBe("commit");
    const taskBranch = task?.taskBranch as string;
    const develop = stepRow(id, "develop")?.output as Record<string, unknown>;
    expect(develop.testsPassed).toBe(true);
    expect(String(develop.testOutputTail)).toContain(TEST_MARKER);
    expect(String(develop.diffText)).toContain(DIFF_MARKER);
    expect(develop.gitDirBaseline).toMatch(/^[0-9a-f]{64}$/);
    expect(develop.configFingerprint).toMatch(/^[0-9a-f]{64}$/);

    const commit = pendingOf("engineering.commit") as Approval;
    expect(commit.riskLevel).toBe("medium");
    const cp = commit.payload as Record<string, unknown>;
    expect(cp.taskId).toBe(id);
    expect(cp.testsPassed).toBe(true);
    expect(cp.testRun).toBe("exact");
    expect((cp.files as { path: string }[]).map((f) => f.path)).toEqual([
      "src/index.ts",
      `src/${FILE_MARKER}.ts`,
    ]);
    expect(String(cp.message)).toContain(`Task: ${id}`);
    expect(String(cp.message).startsWith("Fix redirect\n\n")).toBe(true);
    // Diff text lives on the step output only.
    expect(JSON.stringify(cp)).not.toContain(DIFF_MARKER);
    expect(cp.diffHash).toBe(develop.diffHash);
    expect(cp.gitDirBaseline).toBe(develop.gitDirBaseline);

    const mainBefore = head(repo, "main");
    expect((await approve("engineering.commit")).outcome.status).toBe("executed");
    expect(git(repo, "log", "-1", "--format=%B", taskBranch)).toContain(`Task: ${id}`);
    expect(stepRow(id, "update_parent")?.status).toBe("done");
    const ml = pendingOf("engineering.merge_local") as Approval;
    expect(ml.riskLevel).toBe("medium");
    expect(ml.idempotencyKey).toBe(`engineering:merge_local:${id}:1`);
    expect((ml.payload as { commitSha: string }).commitSha).toBe(head(repo, taskBranch));
    expect(taskRow(id)?.currentStep).toBe("merge_local");

    expect((await approve("engineering.merge_local")).outcome.status).toBe("executed");
    expect(head(repo, "main")).not.toBe(mainBefore);
    expect(taskRow(id)?.mergeSha).toBe(head(repo, "main"));
    const push = pendingOf("engineering.push_pr") as Approval;
    const pp = push.payload as Record<string, unknown>;
    expect(push.riskLevel).toBe("medium");
    expect(pp.autoDeploys).toBe(false);
    expect((pp.commits as unknown[]).length).toBe(2); // the task commit and the --no-ff merge
    expect(pp.commitsTotal).toBe(2);
    expect(pp.mergeSha).toBe(head(repo, "main"));
    expect(pp.prTitle).toBe("Fix redirect");
    expect(String(pp.prBody)).toContain(`Task: ${id}\nTests passed`);

    const upstreamBefore = head(fx.upstream, "main");
    expect((await approve("engineering.push_pr")).outcome.status).toBe("executed");
    expect(head(fx.origin, "main")).toBe(pp.mergeSha as string);
    expect(head(fx.upstream, "main")).toBe(upstreamBefore); // never pushed to upstream
    expect(stepRow(id, "push_pr")?.output).toMatchObject({ pushedSha: pp.mergeSha });
    const create = ghCalls().find((c) => c[1] === "create") as string[];
    expect(create.slice(0, 8)).toEqual([
      "pr",
      "create",
      "--repo",
      "up/app",
      "--head",
      "fork:main",
      "--base",
      "main",
    ]);
    expect(taskRow(id)?.prNumber).toBe(7);
    const mp = pendingOf("engineering.merge_pr") as Approval;
    expect(mp.riskLevel).toBe("high"); // E14: always
    expect((mp.payload as Record<string, unknown>).status).toEqual({
      state: "OPEN",
      mergeable: "MERGEABLE",
      checks: "passing",
      headSha: pp.mergeSha,
      checkedAt: NOW,
    });
    expect((mp.payload as Record<string, unknown>).pushedSha).toBe(pp.mergeSha);

    expect((await approve("engineering.merge_pr")).outcome.status).toBe("executed");
    expect(ghCalls().find((c) => c[1] === "merge")).toEqual([
      "pr",
      "merge",
      "7",
      "--repo",
      "up/app",
      "--merge",
      "--match-head-commit",
      pp.mergeSha as string,
    ]);
    expect(taskRow(id)?.status).toBe("completed");
    expect(stepRow(id, "cleanup")?.status).toBe("done");
    expect(branches()).not.toContain(taskBranch);
    expect(git(repo, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(leaseRow()).toBeUndefined();

    // No diff text, test output, paths or branch names in audit rows or events.
    for (const dump of [auditDump(), eventDump()]) {
      for (const m of [DIFF_MARKER, TEST_MARKER, FILE_MARKER, "synapse/", repo, APPROVED]) {
        expect(dump).not.toContain(m);
      }
    }
  }, 30_000);
});

describe("test result source (ADR-026)", () => {
  test("a failing Bash tool_result wins over the model's claim", async () => {
    reply = editingRun(
      undefined,
      [tool("Bash", { command: "bun test" }, `1 fail\n${TEST_MARKER}`, true)],
      true,
    );
    const id = await developed();
    const out = stepRow(id, "develop")?.output as Record<string, unknown>;
    expect(out.testsPassed).toBe(false);
    expect(String(out.testOutputTail)).toContain("1 fail");
    expect(
      (pendingOf("engineering.commit")?.payload as { testsPassed: boolean } | undefined)
        ?.testsPassed,
    ).toBe(false);
  });

  test("the last test-command result counts; other commands and missing results do not", () => {
    const ok = tool("Bash", { command: "bun test" }, "pass");
    const bad = tool("Bash", { command: "bun test src/a.test.ts" }, "fail", true);
    const other = tool("Bash", { command: "bun testx" }, "pass");
    expect(testResultFrom([bad, ok], "bun test")).toEqual({
      testsPassed: true,
      testOutputTail: "pass",
      testRun: "exact",
    });
    expect(testResultFrom([ok, bad, other], "bun test")).toMatchObject({
      testsPassed: false,
      testRun: "partial",
    });
    expect(testResultFrom([other], "bun test")).toEqual({
      testsPassed: false,
      testOutputTail: null,
      testRun: "none",
    });
    expect(testResultFrom([], "bun test")).toEqual({
      testsPassed: false,
      testOutputTail: null,
      testRun: "none",
    });
    const long = tool("Bash", { command: "bun test" }, `${"x".repeat(5000)}END`);
    const tail = testResultFrom([long], "bun test").testOutputTail as string;
    expect(tail.length).toBe(2000);
    expect(tail.endsWith("END")).toBe(true);
  });
});

describe("unsafe and empty develop runs (E9)", () => {
  test("a write into .git/hooks is unsafe_change: no commit approval, needs attention, lock kept", async () => {
    reply = editingRun({ ".git/hooks/x": "#!/bin/sh\n", "src/index.ts": "changed\n" });
    const id = await developed();
    expect(taskRow(id)?.status).toBe("needs_attention");
    expect(taskRow(id)?.failure).toBe("unsafe_change");
    expect(stepRow(id, "develop")?.status).toBe("failed");
    expect(
      (stepRow(id, "develop")?.output as { unsafeReasons: string[] } | undefined)?.unsafeReasons,
    ).toEqual(["git_dir_changed"]);
    expect(approvals.listPending()).toEqual([]);
    expect(leaseRow()?.holder).toBe(`task:${id}`);
  });

  test("a .gitattributes change is unsafe_change", async () => {
    reply = editingRun({ ".gitattributes": "*.ts filter=evil\n" });
    const id = await developed();
    expect(taskRow(id)?.failure).toBe("unsafe_change");
    expect(
      (stepRow(id, "develop")?.output as { unsafeReasons: string[] } | undefined)?.unsafeReasons,
    ).toEqual(["git_metadata_changed"]);
    expect(approvals.listPending()).toEqual([]);
  });

  test("an empty diff fails the task (no_changes), cleans up and releases the lock", async () => {
    reply = editingRun({});
    const id = await developed();
    expect(taskRow(id)?.status).toBe("failed");
    expect(taskRow(id)?.failure).toBe("no_changes");
    expect(branches()).not.toContain(taskRow(id)?.taskBranch);
    expect(git(repo, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(leaseRow()).toBeUndefined();
  });
});

describe("rejection and cancel (E16)", () => {
  test("rejecting the commit leaves no commit, cancels, discards the run's changes, deletes the branch, releases the lock", async () => {
    const id = await developed();
    const taskBranch = taskRow(id)?.taskBranch as string;
    const mainBefore = head(repo, "main");
    await reject("engineering.commit");
    expect(taskRow(id)?.status).toBe("cancelled");
    expect(stepRow(id, "commit")?.status).toBe("skipped");
    expect(stepRow(id, "cleanup")?.status).toBe("done");
    expect(head(repo, "main")).toBe(mainBefore);
    expect(branches()).not.toContain(taskBranch);
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(git(repo, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(leaseRow()).toBeUndefined();
  });

  test("rejecting a later step keeps the committed task branch (not merged) and releases the lock", async () => {
    const id = await developed();
    await approve("engineering.commit");
    await reject("engineering.merge_local");
    expect(taskRow(id)?.status).toBe("cancelled");
    expect(branches()).toContain(taskRow(id)?.taskBranch as string);
    expect(leaseRow()).toBeUndefined();
  });

  test("cancel() while the commit approval waits expires it and cleans up", async () => {
    const id = await developed();
    const a = pendingOf("engineering.commit") as Approval;
    service.cancel(id);
    await drain();
    dispatcher.dispatchOnce();
    expect(approvalRow(a.id)?.status).toBe("expired");
    expect(taskRow(id)?.status).toBe("cancelled");
    expect(branches()).not.toContain(taskRow(id)?.taskBranch);
    expect(leaseRow()).toBeUndefined();
  });

  test("a tree the user changed after the approval is not discarded: needs attention, lock kept; tidy and cancel again releases", async () => {
    const id = await developed();
    writeFileSync(join(repo, "src/index.ts"), "my own edit\n");
    await reject("engineering.commit");
    expect(taskRow(id)?.status).toBe("needs_attention");
    expect(taskRow(id)?.failure).toBe("dirty_tree");
    expect(readFileSync(join(repo, "src/index.ts"), "utf8")).toBe("my own edit\n");
    expect(leaseRow()?.holder).toBe(`task:${id}`);
    git(repo, "checkout", "--", ".");
    git(repo, "clean", "-fdq");
    service.cancel(id);
    await drain();
    expect(taskRow(id)?.status).toBe("cancelled");
    expect(leaseRow()).toBeUndefined();
  });

  test("cleanup never touches git while another task holds the lock", async () => {
    const id = await developed();
    const taskBranch = taskRow(id)?.taskBranch as string;
    db.update(schema.engineeringTasks)
      .set({ status: "cancelled" })
      .where(eq(schema.engineeringTasks.id, id))
      .run();
    db.update(schema.leases)
      .set({ holder: "task:someone-else" })
      .where(eq(schema.leases.name, ENGINEERING_LEASE))
      .run();
    expect(await steps.cleanup(id)).toEqual({
      status: "skipped",
      step: "cleanup",
      reason: "lock_held_by_other",
    });
    expect(stepRow(id, "cleanup")?.status).toBe("skipped");
    expect(branches()).toContain(taskBranch);
    expect(git(repo, "status", "--porcelain")).not.toBe("");
  });
});

describe("revalidation (E18)", () => {
  test("stale commit approval: the diff changed, nothing is committed, approval revoked, needs attention", async () => {
    const id = await developed();
    const taskBranch = taskRow(id)?.taskBranch as string;
    const base = head(repo, taskBranch);
    writeFileSync(join(repo, "src/index.ts"), "changed after the approval\n");
    const { approval, outcome } = await approve("engineering.commit");
    expect(outcome.status).toBe("skipped");
    expect(approvalRow(approval.id)?.status).toBe("revoked");
    expect(head(repo, taskBranch)).toBe(base);
    expect(taskRow(id)?.status).toBe("needs_attention");
    expect(taskRow(id)?.failure).toBe("diff_changed");
    expect(leaseRow()?.holder).toBe(`task:${id}`);
    // The system revoke does not cancel the task.
    dispatcher.dispatchOnce();
    expect(taskRow(id)?.status).toBe("needs_attention");
  });

  test("a git config change before the commit executes is config_changed", async () => {
    const id = await developed();
    git(repo, "config", "core.pager", "less");
    const { outcome } = await approve("engineering.commit");
    expect(outcome.status).toBe("skipped");
    expect(taskRow(id)?.failure).toBe("config_changed");
  });

  test("a git config change before merge_local executes is config_changed", async () => {
    const id = await developed();
    await approve("engineering.commit");
    const mainBefore = head(repo, "main");
    git(repo, "config", "core.pager", "less");
    const { outcome } = await approve("engineering.merge_local");
    expect(outcome.status).toBe("skipped");
    expect(taskRow(id)?.failure).toBe("config_changed");
    expect(head(repo, "main")).toBe(mainBefore);
  });

  test("a parent that became protected after plan approval fails push_pr revalidation", async () => {
    const id = await developed();
    await approve("engineering.commit");
    await approve("engineering.merge_local");
    db.insert(schema.repositoryEnvironments)
      .values({
        id: newId(),
        repositoryId: repoId,
        name: "main-env",
        branch: "main",
        protected: true,
        autoDeploysOnMerge: false,
      })
      .run();
    const originBefore = head(fx.origin, "main");
    const { outcome } = await approve("engineering.push_pr");
    expect(outcome.status).toBe("skipped");
    expect(taskRow(id)?.failure).toBe("protected_branch");
    expect(head(fx.origin, "main")).toBe(originBefore);
    expect(ghCalls().some((c) => c[1] === "create")).toBe(false);
  });
});

describe("conflicts (E11, E12)", () => {
  test("an update_parent conflict sets needs_attention (parent_conflict), aborts the merge and keeps the lock", async () => {
    const id = await developed();
    pushRemoteCommit(fx.origin, "origin side\n");
    pushRemoteCommit(fx.upstream, "upstream side\n");
    expect((await approve("engineering.commit")).outcome.status).toBe("executed");
    expect(taskRow(id)?.status).toBe("needs_attention");
    expect(taskRow(id)?.failure).toBe("parent_conflict");
    expect(stepRow(id, "update_parent")?.status).toBe("failed");
    expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(false);
    expect(leaseRow()?.holder).toBe(`task:${id}`);
    expect(approvals.listPending()).toEqual([]);
  });

  test("a merge_local conflict sets needs_attention (merge_conflict) and keeps the lock", async () => {
    reply = editingRun({ "README.md": "task side\n" });
    const id = await developed();
    pushRemoteCommit(fx.origin, "origin side\n");
    pushRemoteCommit(fx.upstream, "origin side\n");
    await approve("engineering.commit");
    expect(taskRow(id)?.status).toBe("awaiting_approval");
    const { outcome } = await approve("engineering.merge_local");
    expect(outcome.status).toBe("failed");
    expect(taskRow(id)?.failure).toBe("merge_conflict");
    expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(false);
    expect(leaseRow()?.holder).toBe(`task:${id}`);
  });
});

describe("auto-deploy notice and PR failures (E13, E14)", () => {
  test("an auto-deploy parent makes push_pr and merge_pr high risk and carries the notice", async () => {
    const id = await developed("stage");
    await approve("engineering.commit");
    await approve("engineering.merge_local");
    const push = pendingOf("engineering.push_pr") as Approval;
    expect(push.riskLevel).toBe("high");
    expect(push.payload).toMatchObject({ autoDeploys: true, environmentName: "stage" });
    await approve("engineering.push_pr");
    const merge = pendingOf("engineering.merge_pr") as Approval;
    expect(merge.riskLevel).toBe("high");
    expect(merge.payload).toMatchObject({ autoDeploys: true, environmentName: "stage" });
    expect(taskRow(id)?.status).toBe("awaiting_approval");
  });

  test("a non-GitHub upstream is unsupported_remote before anything is pushed", async () => {
    db.update(schema.repositories)
      .set({ upstreamUrl: "https://gitlab.com/up/app" })
      .where(eq(schema.repositories.id, repoId))
      .run();
    const id = await developed();
    await approve("engineering.commit");
    await approve("engineering.merge_local");
    const originBefore = head(fx.origin, "main");
    expect((await approve("engineering.push_pr")).outcome.status).toBe("failed");
    expect(taskRow(id)?.failure).toBe("unsupported_remote");
    expect(head(fx.origin, "main")).toBe(originBefore);
  });

  test("a failed PR creation after the push needs attention (pr_create_failed)", async () => {
    writeFileSync(
      join(ghDir, "cfg.json"),
      JSON.stringify({ origin: fx.origin, fail: "pr create" }),
    );
    const id = await developed();
    await approve("engineering.commit");
    await approve("engineering.merge_local");
    expect((await approve("engineering.push_pr")).outcome.status).toBe("failed");
    expect(taskRow(id)?.status).toBe("needs_attention");
    expect(taskRow(id)?.failure).toBe("pr_create_failed");
    expect(stepRow(id, "push_pr")?.output).toMatchObject({ pushed: true });
  });
});

describe("restart while an approval waits (E6 refinement)", () => {
  const restartLock = () =>
    new EngineeringLock({
      db,
      clock,
      leases,
      settings,
      events,
      audit,
      git: workflow,
      queue,
      approvals,
    });

  test("commit approval pending, same diff and config: resumed, approval still pending, lock kept", async () => {
    const id = await developed();
    clock.advance(30 * 60_000);
    expect(await restartLock().recover()).toEqual({ action: "resumed", taskId: id });
    expect(taskRow(id)?.status).toBe("awaiting_approval");
    expect(pendingOf("engineering.commit")).toBeDefined();
    expect(leaseRow()?.holder).toBe(`task:${id}`);
    expect(new Date(leaseRow()?.expiresAt as string).getTime()).toBeGreaterThan(
      clock.now().getTime(),
    );
  });

  test("commit approval pending but the diff changed: needs attention (diff_changed)", async () => {
    const id = await developed();
    writeFileSync(join(repo, "src/index.ts"), "edited while down\n");
    expect(await restartLock().recover()).toEqual({
      action: "needs_attention",
      taskId: id,
      reason: "diff_changed",
    });
    expect(leaseRow()?.holder).toBe(`task:${id}`);
  });

  test("commit approval pending but the config changed: needs attention (config_changed)", async () => {
    const id = await developed();
    git(repo, "config", "core.pager", "less");
    expect(await restartLock().recover()).toMatchObject({ reason: "config_changed" });
    expect(taskRow(id)?.status).toBe("needs_attention");
  });

  test("an executor that was running (in_progress at commit) cannot be re-driven: resume_unsafe", async () => {
    const id = await developed();
    git(repo, "stash", "-u");
    db.update(schema.engineeringTasks)
      .set({ status: "in_progress" })
      .where(eq(schema.engineeringTasks.id, id))
      .run();
    expect(await restartLock().recover()).toMatchObject({
      action: "needs_attention",
      reason: "resume_unsafe",
    });
  });

  test("in_progress at develop with a clean tree re-drives develop; a touched git dir does not", async () => {
    const id = await developed();
    const a = pendingOf("engineering.commit") as Approval;
    // Undo the run's edits with plain file writes: no git command may touch .git here.
    writeFileSync(join(repo, "src/index.ts"), "export {};\n");
    rmSync(join(repo, `src/${FILE_MARKER}.ts`));
    db.update(schema.approvals)
      .set({ status: "expired" })
      .where(eq(schema.approvals.id, a.id))
      .run();
    db.update(schema.engineeringTasks)
      .set({ status: "in_progress", currentStep: "develop" })
      .where(eq(schema.engineeringTasks.id, id))
      .run();
    expect(await restartLock().recover()).toEqual({ action: "resumed", taskId: id });
    const pending = db
      .select()
      .from(schema.jobs)
      .where(and(eq(schema.jobs.type, STEP_JOB), eq(schema.jobs.status, "PENDING")))
      .all();
    expect(pending.map((j) => j.input)).toEqual([{ taskId: id, step: "develop" }]);

    // Same state, but something wrote into .git after the baseline: not re-driven.
    db.update(schema.jobs).set({ status: "COMPLETED" }).run();
    writeFileSync(join(repo, ".git", "hooks", "post-checkout"), "#!/bin/sh\n");
    expect(await restartLock().recover()).toMatchObject({ reason: "resume_unsafe" });
  });
});

describe("pinned SHAs (review fixes)", () => {
  test("a commit on the task branch after the merge_local request fails revalidation (branch_moved)", async () => {
    const id = await developed();
    await approve("engineering.commit");
    const taskBranch = taskRow(id)?.taskBranch as string;
    git(repo, "switch", "-q", taskBranch);
    writeFileSync(join(repo, "extra.ts"), "x\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "user commit on the task branch");
    git(repo, "switch", "-q", "main");
    const mainBefore = head(repo, "main");
    const { outcome } = await approve("engineering.merge_local");
    expect(outcome.status).toBe("skipped");
    expect(taskRow(id)?.failure).toBe("branch_moved");
    expect(head(repo, "main")).toBe(mainBefore);
  });

  test("a user commit on the parent after merge_local fails push_pr revalidation (branch_moved); nothing is pushed", async () => {
    const id = await developed();
    await approve("engineering.commit");
    await approve("engineering.merge_local");
    writeFileSync(join(repo, "user.ts"), "x\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "user commit on the parent");
    const originBefore = head(fx.origin, "main");
    const { outcome } = await approve("engineering.push_pr");
    expect(outcome.status).toBe("skipped");
    expect(taskRow(id)?.failure).toBe("branch_moved");
    expect(head(fx.origin, "main")).toBe(originBefore);
    expect(ghCalls().some((c) => c[1] === "create")).toBe(false);
  });

  test("the fork branch moving after the push fails merge_pr revalidation (pr_head_moved); gh never merges", async () => {
    const id = await developed();
    await approve("engineering.commit");
    await approve("engineering.merge_local");
    await approve("engineering.push_pr");
    pushRemoteCommit(fx.origin, "someone pushed to the fork\n");
    const { outcome } = await approve("engineering.merge_pr");
    expect(outcome.status).toBe("skipped");
    expect(taskRow(id)?.status).toBe("needs_attention");
    expect(taskRow(id)?.failure).toBe("pr_head_moved");
    expect(ghCalls().some((c) => c[1] === "merge")).toBe(false);
  });

  test("merge_local re-checks protection at execution time", async () => {
    const id = await developed();
    await approve("engineering.commit");
    const mainBefore = head(repo, "main");
    // Revalidate ends with the task-branch tip check; the parent becomes protected right after.
    hooks.branchTip = () => protectMain();
    const { outcome } = await approve("engineering.merge_local");
    expect(outcome.status).toBe("failed");
    expect(taskRow(id)?.failure).toBe("protected_branch");
    expect(head(repo, "main")).toBe(mainBefore);
  });

  test("merge_pr re-checks protection at execution time", async () => {
    const id = await developed();
    await approve("engineering.commit");
    await approve("engineering.merge_local");
    await approve("engineering.push_pr");
    hooks.prStatus = () => protectMain();
    const { outcome } = await approve("engineering.merge_pr");
    expect(outcome.status).toBe("failed");
    expect(taskRow(id)?.failure).toBe("protected_branch");
    expect(ghCalls().some((c) => c[1] === "merge")).toBe(false);
  });
});

describe("cleanup keeps branches with commits (review fixes)", () => {
  test("a user commit on the task branch while the task needs attention: cancel keeps the branch", async () => {
    const id = await developed();
    writeFileSync(join(repo, "src/index.ts"), "edited after the approval\n");
    await approve("engineering.commit"); // stale: diff_changed → needs_attention
    expect(taskRow(id)?.status).toBe("needs_attention");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "the user's own work");
    const tip = head(repo, taskRow(id)?.taskBranch as string);
    service.cancel(id);
    await drain();
    expect(taskRow(id)?.status).toBe("cancelled");
    expect(branches()).toContain(taskRow(id)?.taskBranch as string);
    expect(head(repo, taskRow(id)?.taskBranch as string)).toBe(tip);
    expect(stepRow(id, "cleanup")?.output).toMatchObject({ outcome: "branch_kept" });
    expect(auditDump()).toContain('"branchKept":true');
    expect(leaseRow()).toBeUndefined();
  });

  test("a crash after commitAll but before its bookkeeping, then cancel: the branch is kept", async () => {
    const id = await developed();
    const a = pendingOf("engineering.commit") as Approval;
    const p = a.payload as { message: string; diffHash: string };
    // The executor claimed the step and committed; the process died before settle.
    db.update(schema.engineeringTasks)
      .set({ status: "in_progress" })
      .where(eq(schema.engineeringTasks.id, id))
      .run();
    const { sha } = await workflow.commitAll(repo, p.message, p.diffHash);
    service.cancel(id);
    await drain();
    expect(taskRow(id)?.status).toBe("cancelled");
    expect(head(repo, taskRow(id)?.taskBranch as string)).toBe(sha);
    expect(stepRow(id, "cleanup")?.output).toMatchObject({ outcome: "branch_kept" });
  });
});

describe("cancel and lock edge cases (review fixes)", () => {
  test("a cancel while the push runs: pushed, no PR (pushed_not_pr), cleaned up", async () => {
    const id = await developed();
    await approve("engineering.commit");
    await approve("engineering.merge_local");
    hooks.pushParent = () => {
      service.cancel(id);
    };
    const { outcome } = await approve("engineering.push_pr");
    expect(outcome.status).toBe("executed");
    expect(head(fx.origin, "main")).toBe(head(repo, "main"));
    expect(ghCalls().some((c) => c[1] === "create")).toBe(false);
    expect(stepRow(id, "push_pr")?.output).toMatchObject({
      pushed: true,
      outcome: "pushed_not_pr",
    });
    expect(taskRow(id)?.status).toBe("cancelled");
    expect(taskRow(id)?.prNumber).toBeNull();
    expect(leaseRow()).toBeUndefined();
  });

  test("recovery that sends a task with a pending commit approval to needs_attention expires it", async () => {
    const id = await developed();
    const a = pendingOf("engineering.commit") as Approval;
    writeFileSync(join(repo, "src/index.ts"), "edited while down\n");
    expect(await restartLockOf().recover()).toMatchObject({ reason: "diff_changed" });
    expect(approvalRow(a.id)?.status).toBe("expired");
    dispatcher.dispatchOnce();
    expect(taskRow(id)?.status).toBe("needs_attention");
  });

  test("a re-requested step gets a new approval, never the old decided one", async () => {
    const id = await developed();
    await approve("engineering.commit");
    const first = pendingOf("engineering.merge_local") as Approval;
    git(repo, "config", "core.pager", "less");
    await approve("engineering.merge_local"); // config_changed: revoked, needs attention
    expect(approvalRow(first.id)?.status).toBe("revoked");
    // Re-drive update_parent (as a future resume would) with the config accepted again.
    git(repo, "config", "--unset", "core.pager");
    db.update(schema.engineeringTasks)
      .set({ status: "in_progress", currentStep: "update_parent" })
      .where(eq(schema.engineeringTasks.id, id))
      .run();
    queue.enqueue(db, {
      type: STEP_JOB,
      input: { taskId: id, step: "update_parent" },
      idempotencyKey: `redrive-${newId()}`,
      maxAttempts: 1,
    });
    await drain();
    const second = pendingOf("engineering.merge_local") as Approval;
    expect(second.id).not.toBe(first.id);
    expect(second.idempotencyKey).toBe(`engineering:merge_local:${id}:2`);
    expect(taskRow(id)?.status).toBe("awaiting_approval");
  });

  test("a completed task whose cleanup found a dirty tree keeps its prior status and closes as completed after re-cleanup", async () => {
    const id = await developed();
    await approve("engineering.commit");
    await approve("engineering.merge_local");
    await approve("engineering.push_pr");
    writeFileSync(join(repo, "wip.ts"), "user wip\n");
    await approve("engineering.merge_pr");
    expect(taskRow(id)?.status).toBe("needs_attention");
    expect(stepRow(id, "cleanup")?.output).toMatchObject({
      failure: "dirty_tree",
      priorStatus: "completed",
    });
    expect(leaseRow()?.holder).toBe(`task:${id}`);
    // It can never be resumed or re-queued.
    for (const to of ["in_progress", "queued", "awaiting_approval"] as const) {
      expect(() =>
        db.transaction((tx) => new EngineeringTaskStore({ clock, events }).transition(tx, id, to)),
      ).toThrow(EngineeringTaskError);
    }
    // Cancel retries cleanup instead of cancelling; a tidy tree closes it as completed.
    rmSync(join(repo, "wip.ts"));
    expect(service.cancel(id).status).toBe("needs_attention");
    await drain();
    expect(taskRow(id)?.status).toBe("completed");
    expect(stepRow(id, "cleanup")?.status).toBe("done");
    expect(leaseRow()).toBeUndefined();
  });
});

describe("final review fixes", () => {
  const setGh = (extra: Record<string, unknown>) =>
    writeFileSync(join(ghDir, "cfg.json"), JSON.stringify({ origin: fx.origin, ...extra }));

  test("I2: the branch checked out at pickup was deleted meanwhile: cleanup returns to the parent and releases the lock", async () => {
    git(repo, "switch", "-q", "-c", "feature-x");
    const id = await developed();
    expect(stepRow(id, "branch")?.output).toMatchObject({ returnTo: "feature-x" });
    git(repo, "update-ref", "-d", "refs/heads/feature-x");
    await reject("engineering.commit");
    expect(taskRow(id)?.status).toBe("cancelled");
    expect(stepRow(id, "cleanup")?.status).toBe("done");
    expect(git(repo, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(branches()).not.toContain(taskRow(id)?.taskBranch as string);
    expect(leaseRow()).toBeUndefined();
  });

  test("I2: neither the return branch nor the parent exists: cleanup stays on the task branch, keeps it (branch_kept), releases the lock", async () => {
    const id = await developed();
    const taskBranch = taskRow(id)?.taskBranch as string;
    // update-ref keeps .git/config as it is (branch -D drops branch.main.*: config_changed).
    git(repo, "update-ref", "-d", "refs/heads/main");
    await reject("engineering.commit");
    expect(taskRow(id)?.status).toBe("cancelled");
    expect(stepRow(id, "cleanup")?.status).toBe("done");
    expect(stepRow(id, "cleanup")?.output).toMatchObject({
      outcome: "branch_kept",
      deleted: false,
    });
    expect(git(repo, "symbolic-ref", "--short", "HEAD")).toBe(taskBranch);
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(leaseRow()).toBeUndefined();
  });

  test("M1: a test run with extra arguments is a partial run, on the commit payload and the PR body", async () => {
    reply = editingRun(undefined, [tool("Bash", { command: "bun test src/x.test.ts" }, "1 pass")]);
    const id = await developed();
    expect(stepRow(id, "develop")?.output).toMatchObject({ testsPassed: true, testRun: "partial" });
    expect(pendingOf("engineering.commit")?.payload).toMatchObject({
      testsPassed: true,
      testRun: "partial",
    });
    await approve("engineering.commit");
    await approve("engineering.merge_local");
    const body = String(
      ((pendingOf("engineering.push_pr") as Approval).payload as { prBody: string }).prBody,
    );
    expect(body).toContain("Partial test run (passed)");
    expect(body).not.toContain("Tests passed");
  });

  test("M1: no test run at all is 'Tests not run'", async () => {
    reply = editingRun(undefined, []);
    const id = await developed();
    expect(pendingOf("engineering.commit")?.payload).toMatchObject({
      testsPassed: false,
      testRun: "none",
    });
    await approve("engineering.commit");
    await approve("engineering.merge_local");
    const body = String(
      ((pendingOf("engineering.push_pr") as Approval).payload as { prBody: string }).prBody,
    );
    expect(body).toContain(`Task: ${id}\nTests not run`);
  });

  test("M5: a cancel while the PR is being created still records the PR on the task", async () => {
    const id = await developed();
    await approve("engineering.commit");
    await approve("engineering.merge_local");
    hooks.createPr = () => {
      service.cancel(id);
    };
    await approve("engineering.push_pr");
    expect(taskRow(id)?.status).toBe("cancelled");
    expect(taskRow(id)?.prNumber).toBe(7);
    expect(taskRow(id)?.prUrl).toBe("https://github.com/up/app/pull/7");
    expect(pendingOf("engineering.merge_pr")).toBeUndefined();
    expect(leaseRow()).toBeUndefined();
  });

  test("M5: a PR merged after a cancel is the truth: completed, merged_after_cancel recorded, cleaned up", async () => {
    const id = await developed();
    await approve("engineering.commit");
    await approve("engineering.merge_local");
    await approve("engineering.push_pr");
    const pushedSha = (
      (pendingOf("engineering.merge_pr") as Approval).payload as { pushedSha: string }
    ).pushedSha;
    hooks.mergePr = () => {
      service.cancel(id);
    };
    expect((await approve("engineering.merge_pr")).outcome.status).toBe("executed");
    expect(taskRow(id)?.status).toBe("completed");
    expect(taskRow(id)?.failure).toBe("merged_after_cancel");
    expect(stepRow(id, "merge_pr")?.output).toMatchObject({
      merged: true,
      outcome: "merged_after_cancel",
      mergeSha: null, // gh reported no merge commit: the PR head is kept apart
      prHeadSha: pushedSha,
    });
    expect(stepRow(id, "cleanup")?.status).toBe("done");
    expect(leaseRow()).toBeUndefined();
  });

  test("M6: failing checks at merge time refuse the merge (checks_failing); the fresh status is recorded; gh never merges", async () => {
    const id = await developed();
    await approve("engineering.commit");
    await approve("engineering.merge_local");
    await approve("engineering.push_pr");
    const a = pendingOf("engineering.merge_pr") as Approval;
    setGh({ conclusion: "FAILURE" });
    clock.advance(60_000);
    expect((await approve("engineering.merge_pr")).outcome.status).toBe("skipped");
    expect(ghCalls().some((c) => c[1] === "merge")).toBe(false);
    expect(approvalRow(a.id)?.status).toBe("revoked");
    expect(taskRow(id)?.status).toBe("needs_attention");
    expect(taskRow(id)?.failure).toBe("checks_failing");
    expect(stepRow(id, "merge_pr")?.output).toMatchObject({
      freshStatus: { checks: "failing", checkedAt: "2026-11-06T09:01:00.000Z" },
    });
    expect(leaseRow()?.holder).toBe(`task:${id}`);
  });

  test("M8: a failed task whose cleanup found a dirty tree keeps 'failed'; cancel retries cleanup and restores it", async () => {
    reply = editingRun({});
    hooks.branchTip = () => writeFileSync(join(repo, "wip.ts"), "user wip\n");
    const id = await developed();
    expect(taskRow(id)?.status).toBe("needs_attention");
    expect(stepRow(id, "cleanup")?.output).toMatchObject({
      failure: "dirty_tree",
      priorStatus: "failed",
    });
    rmSync(join(repo, "wip.ts"));
    expect(service.cancel(id).status).toBe("needs_attention");
    await drain();
    expect(taskRow(id)?.status).toBe("failed");
    expect(taskRow(id)?.failure).toBe("no_changes");
    expect(stepRow(id, "cleanup")?.status).toBe("done");
    expect(leaseRow()).toBeUndefined();
  });

  test("M9: the repository vanishing between revalidation and execution sends the task to needs_attention", async () => {
    const id = await developed();
    const a = pendingOf("engineering.commit") as Approval;
    const away = `${repo}-away`;
    hooks.diffSummary = () => renameSync(repo, away);
    try {
      expect((await approve("engineering.commit")).outcome.status).toBe("failed");
    } finally {
      renameSync(away, repo);
    }
    expect(taskRow(id)?.status).toBe("needs_attention");
    expect(taskRow(id)?.failure).toBe("path_unavailable");
    expect(stepRow(id, "commit")?.status).toBe("failed");
    expect(approvalRow(a.id)?.status).not.toBe("approved");
    expect(approvals.listPending()).toEqual([]);
  });

  test("M10: an origin push URL that is not the registered origin refuses the push (origin_changed)", async () => {
    const elsewhere = join(scratch(), "elsewhere.git");
    git(scratch(), "init", "-q", "--bare", elsewhere);
    git(repo, "remote", "set-url", "--push", "origin", `file://${elsewhere}`);
    const id = await developed();
    await approve("engineering.commit");
    await approve("engineering.merge_local");
    const originBefore = head(fx.origin, "main");
    await approve("engineering.push_pr");
    expect(taskRow(id)?.status).toBe("needs_attention");
    expect(taskRow(id)?.failure).toBe("origin_changed");
    expect(head(fx.origin, "main")).toBe(originBefore);
    expect(git(elsewhere, "for-each-ref")).toBe("");
    expect(ghCalls().some((c) => c[1] === "create")).toBe(false);
  });
});

describe("startup sweep of run scratch (fix round 1)", () => {
  test("leftover run dirs are removed; the r dir stays", () => {
    const dir = scratch();
    mkdirSync(join(dir, "r", "a", "tmp"), { recursive: true });
    writeFileSync(join(dir, "r", "a", "tmp", "f"), "x");
    mkdirSync(join(dir, "r", "b"));
    writeFileSync(join(dir, "r", "stray-file"), "x");
    writeFileSync(join(dir, "keep.txt"), "x");
    sweepRunScratch(dir);
    expect(readdirSync(join(dir, "r"))).toEqual([]);
    expect(existsSync(join(dir, "keep.txt"))).toBe(true);
  });

  test("a symlinked r dir is not followed (final review)", () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    const dir = scratch();
    const target = scratch();
    writeFileSync(join(target, "victim"), "x");
    symlinkSync(target, join(dir, "r"));
    try {
      sweepRunScratch(dir);
      expect(existsSync(join(target, "victim"))).toBe(true);
    } finally {
      errors.mockRestore();
    }
  });

  test("a missing r dir is a no-op", () => {
    const dir = scratch();
    expect(() => sweepRunScratch(dir)).not.toThrow();
    expect(existsSync(join(dir, "r"))).toBe(false);
  });

  test("best effort: one undeletable entry logs a fixed line and the rest go", () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    const dir = scratch();
    const locked = join(dir, "r", "a", "locked");
    mkdirSync(join(locked, "inner"), { recursive: true });
    mkdirSync(join(dir, "r", "b"));
    chmodSync(locked, 0o000);
    try {
      expect(() => sweepRunScratch(dir)).not.toThrow();
      expect(readdirSync(join(dir, "r"))).toEqual(["a"]);
      expect(errors.mock.calls).toEqual([["engineering.step: run scratch sweep failed"]]);
    } finally {
      errors.mockRestore();
      chmodSync(locked, 0o755);
    }
  });
});

describe("approval text edits and merge re-request (F2.1, F3.2)", () => {
  const setGh = (extra: Record<string, unknown>) =>
    writeFileSync(join(ghDir, "cfg.json"), JSON.stringify({ origin: fx.origin, ...extra }));
  const api = () =>
    engineeringRoutes({
      engineering: service,
      engineeringSteps: steps,
      engineeringLock: lock,
    } as unknown as Container);
  const put = async (taskId: string, approvalId: string, body: unknown) => {
    const res = await api().request(`/api/engineering/tasks/${taskId}/approvals/${approvalId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const retry = async (taskId: string) => {
    const res = await api().request(`/api/engineering/tasks/${taskId}/retry-merge`, {
      method: "POST",
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const payloadOf = (id: string) => approvalRow(id)?.payload as Record<string, unknown>;
  const editAudits = () =>
    db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, "engineering.approval_edited"))
      .all();

  test("commit: the edited message is stored, audited by field name only, and committed verbatim", async () => {
    const id = await developed();
    const a = pendingOf("engineering.commit") as Approval;
    const text = "Fix add\n\nTask: t1 EDIT-MARKER-5e";
    const r = await put(id, a.id, { commitMessage: text });
    expect(r.status).toBe(200);
    expect((r.body.payload as { message: string }).message).toBe(text);
    expect(payloadOf(a.id).message).toBe(text);
    const rows = editAudits();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.approvalId).toBe(a.id);
    expect(rows[0]?.details).toEqual({ taskId: id, fields: ["commitMessage"] });
    expect(auditDump()).not.toContain("EDIT-MARKER-5e");
    expect(eventDump()).not.toContain("EDIT-MARKER-5e");
    expect((await approve("engineering.commit")).outcome.status).toBe("executed");
    expect(git(repo, "log", "-1", "--format=%B", `${taskRow(id)?.taskBranch}`)).toContain(
      "EDIT-MARKER-5e",
    );
  });

  test("wrong field, empty edit, unknown approval", async () => {
    const id = await developed();
    const a = pendingOf("engineering.commit") as Approval;
    const before = payloadOf(a.id).message;
    expect((await put(id, a.id, { prTitle: "x" })).body).toEqual({ error: "invalid_input" });
    expect((await put(id, a.id, {})).status).toBe(400);
    expect((await put(id, a.id, { commitMessage: "ok", extra: 1 })).status).toBe(400);
    expect(await put(id, "nope", { commitMessage: "ok" })).toEqual({
      status: 404,
      body: { error: "not_found" },
    });
    expect(await put("other-task", a.id, { commitMessage: "ok" })).toEqual({
      status: 404,
      body: { error: "not_found" },
    });
    expect(payloadOf(a.id).message).toBe(before);
    expect(editAudits()).toHaveLength(0);
  });

  test("text git or argv cannot take is 400 invalid_text and the payload is unchanged", async () => {
    const id = await developed();
    const a = pendingOf("engineering.commit") as Approval;
    const before = payloadOf(a.id).message;
    for (const bad of [
      "   ",
      "   \nbody",
      "Fix\u0000",
      "Fix\r\nx",
      "a".repeat(201),
      "a".repeat(5001),
    ]) {
      const r = await put(id, a.id, { commitMessage: bad });
      expect(r).toEqual({ status: 400, body: { error: "invalid_text" } });
    }
    expect(payloadOf(a.id).message).toBe(before);
    expect(editAudits()).toHaveLength(0);
  });

  test("after Approve the edit is 409 not_pending and the payload is unchanged", async () => {
    const id = await developed();
    const a = pendingOf("engineering.commit") as Approval;
    const before = payloadOf(a.id).message;
    approvals.approve(a.id);
    expect(await put(id, a.id, { commitMessage: "Fix add" })).toEqual({
      status: 409,
      body: { error: "not_pending" },
    });
    expect(payloadOf(a.id).message).toBe(before);
  });

  test("a card left open after the task moved on is 409 not_pending", async () => {
    const id = await developed();
    const a = pendingOf("engineering.commit") as Approval;
    await approve("engineering.commit");
    expect((await put(id, a.id, { commitMessage: "late" })).body).toEqual({ error: "not_pending" });
    // Pending approval, but the task left awaiting_approval.
    const b = pendingOf("engineering.merge_local") as Approval;
    db.update(schema.engineeringTasks)
      .set({ status: "needs_attention" })
      .where(eq(schema.engineeringTasks.id, id))
      .run();
    expect((await put(id, b.id, { commitMessage: "x" })).body).toEqual({ error: "invalid_input" });
    const row = db.select().from(schema.approvals).where(eq(schema.approvals.id, a.id)).get();
    expect(row?.status).not.toBe("pending");
  });

  test("not_pending: task status, current step and step-row approval each reached with a valid field", async () => {
    const id = await developed();
    const a = pendingOf("engineering.commit") as Approval;
    const before = payloadOf(a.id).message;
    const setTask = (v: Record<string, unknown>) =>
      db.update(schema.engineeringTasks).set(v).where(eq(schema.engineeringTasks.id, id)).run();
    const expectRefused = async () => {
      expect(await put(id, a.id, { commitMessage: "Fix add" })).toEqual({
        status: 409,
        body: { error: "not_pending" },
      });
      expect(payloadOf(a.id).message).toBe(before);
    };
    setTask({ status: "needs_attention" });
    await expectRefused();
    setTask({ status: "awaiting_approval", currentStep: "merge_local" });
    await expectRefused();
    setTask({ currentStep: "commit" });
    db.update(schema.engineeringTaskSteps)
      .set({ approvalId: "other" })
      .where(
        and(
          eq(schema.engineeringTaskSteps.taskId, id),
          eq(schema.engineeringTaskSteps.step, "commit"),
        ),
      )
      .run();
    await expectRefused();
    expect(editAudits()).toHaveLength(0);
  });

  test("push_pr: title and a 20000-character body reach createPr", async () => {
    const id = await developed();
    await approve("engineering.commit");
    await approve("engineering.merge_local");
    const a = pendingOf("engineering.push_pr") as Approval;
    const body = "b".repeat(20000);
    expect((await put(id, a.id, { commitMessage: "x" })).status).toBe(400);
    expect((await put(id, a.id, { prTitle: "Fix add", prBody: body })).status).toBe(200);
    expect((await put(id, a.id, { prTitle: "a\nb" })).body).toEqual({ error: "invalid_text" });
    expect((await put(id, a.id, { prBody: "b".repeat(20001) })).body).toEqual({
      error: "invalid_text",
    });
    expect((await approve("engineering.push_pr")).outcome.status).toBe("executed");
    const create = ghCalls().find((c) => c[0] === "pr" && c[1] === "create") as string[];
    expect(create[create.indexOf("--title") + 1]).toBe("Fix add");
    expect(create[create.indexOf("--body") + 1]).toBe(body);
    expect(auditDump()).not.toContain("bbbbbbbbbb");
  });

  /** A task parked at merge_pr / checks_failing through a failing revalidation. */
  async function checksFailing(): Promise<{ id: string; pushedSha: string }> {
    const id = await developed();
    await approve("engineering.commit");
    await approve("engineering.merge_local");
    await approve("engineering.push_pr");
    const pushedSha = (
      (pendingOf("engineering.merge_pr") as Approval).payload as {
        pushedSha: string;
      }
    ).pushedSha;
    setGh({ conclusion: "FAILURE" });
    expect((await approve("engineering.merge_pr")).outcome.status).toBe("skipped");
    expect(taskRow(id)?.failure).toBe("checks_failing");
    return { id, pushedSha };
  }

  test("retry-merge: passing checks request a fresh merge_pr approval", async () => {
    const { id } = await checksFailing();
    setGh({});
    clock.advance(60_000);
    const r = await retry(id);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("awaiting_approval");
    expect(taskRow(id)?.currentStep).toBe("merge_pr");
    expect(taskRow(id)?.failure).toBeNull();
    const a = pendingOf("engineering.merge_pr") as Approval;
    expect(a.riskLevel).toBe("high");
    expect((a.payload as { status: { checks: string } }).status.checks).toBe("passing");
    expect(stepRow(id, "merge_pr")?.approvalId).toBe(a.id);
    expect(auditDump()).toContain("engineering.merge_rerequested");
    // The fresh approval executes (merge goes through).
    expect((await approve("engineering.merge_pr")).outcome.status).toBe("executed");
  });

  test("retry-merge: pending but mergeable is allowed; pending and not mergeable is not", async () => {
    const { id } = await checksFailing();
    setGh({ checkStatus: "IN_PROGRESS", mergeable: "UNKNOWN" });
    expect((await retry(id)).body).toEqual({ error: "checks_failing" });
    expect(taskRow(id)?.status).toBe("needs_attention");
    setGh({ checkStatus: "IN_PROGRESS" });
    expect((await retry(id)).status).toBe(200);
    expect(taskRow(id)?.status).toBe("awaiting_approval");
  });

  test("retry-merge: still failing is 409 checks_failing and nothing changes", async () => {
    const { id } = await checksFailing();
    const stepBefore = JSON.stringify(stepRow(id, "merge_pr"));
    expect(await retry(id)).toEqual({ status: 409, body: { error: "checks_failing" } });
    expect(taskRow(id)?.status).toBe("needs_attention");
    expect(taskRow(id)?.failure).toBe("checks_failing");
    expect(JSON.stringify(stepRow(id, "merge_pr"))).toBe(stepBefore);
    expect(approvals.listPending()).toEqual([]);
  });

  test("retry-merge: a moved head, a closed or merged PR and a gh failure are fixed 409s", async () => {
    const { id } = await checksFailing();
    const cases: [Record<string, unknown>, string][] = [
      [{ headRefOid: "0".repeat(40) }, "pr_head_moved"],
      [{ state: "MERGED" }, "state_changed"],
      [{ state: "CLOSED" }, "state_changed"],
      [{ fail: "pr view" }, "pr_status_failed"],
    ];
    for (const [cfg, code] of cases) {
      setGh(cfg);
      expect(await retry(id)).toEqual({ status: 409, body: { error: code } });
      expect(taskRow(id)?.status).toBe("needs_attention");
      expect(approvals.listPending()).toEqual([]);
    }
  });

  test("retry-merge: any other step or reason is 400 invalid_state; an unknown task is 404", async () => {
    const id = await developed();
    expect(await retry(id)).toEqual({ status: 400, body: { error: "invalid_state" } });
    await approve("engineering.commit");
    await approve("engineering.merge_local");
    await approve("engineering.push_pr");
    expect((await retry(id)).body).toEqual({ error: "invalid_state" });
    expect((await retry("nope")).status).toBe(404);
  });

  test("retry-merge: a protected parent is 400 protected_branch", async () => {
    const { id } = await checksFailing();
    setGh({});
    protectMain();
    expect(await retry(id)).toEqual({ status: 400, body: { error: "protected_branch" } });
    expect(approvals.listPending()).toEqual([]);
  });
});
