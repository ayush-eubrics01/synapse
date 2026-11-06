// Real engineering-automation check: a throwaway repo with local bare `origin.git` and
// `upstream.git` (file://, upstream push DISABLED), a one-line bug and a `bun test` test. It runs
// the REAL investigate and develop runs (haiku) through the step runner, approves the commit and
// merge_local approvals programmatically, and stops before push_pr: the push approval stays
// pending and the task is cancelled. gh is never invoked and nothing is pushed beyond the local
// bare repos. Spends a little Claude quota (two haiku runs). Temp DB and repo under
// ~/.cache/synapse-develop-smoke-*, plus this instance's own develop-run root
// ~/.cache/synapse/<hash of its data dir> (the run's private TMPDIR lives there, ADR-040); both
// are deleted afterwards, also on SIGINT/SIGTERM. Only the shared, empty ~/.cache/synapse base
// may remain. Prints statuses and counts only (never task text, diff text, test output, paths or
// branch names).
//
// The develop run's tests execute in the sandbox (ADR-040). The repo also carries a probe test that
// tries to write outside the repo, read a planted placeholder secret and fetch a URL; the last line
// printed is `sandbox: outside_write=<r> secret=<r> network=<r>` and the exit code is 1 on any
// `allowed`.
//
// $HOME stays the real one on purpose: the Claude CLI needs it to authenticate. The run directory
// is created under ~/.cache, NOT /tmp: inside the sandbox /tmp is a private tmpfs, which would make
// every probe inconclusive. The repo (root/work) is outside the masked data dir (root/data).
//
//   bun scripts/dev/develop-smoke.ts
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Approval, EngineeringTaskDetail } from "@synapse/contracts";
import { createContainer } from "../../apps/api/src/container";
import {
  defaultRunScratchRoot,
  instanceRunRoot,
  loadConfig,
} from "../../apps/api/src/core/config/config";
import { NoopDesktopNotifier } from "../../apps/api/src/infrastructure/notifier";
import { STEP_JOB } from "../../apps/api/src/modules/engineering-tasks/lock";
import { INVESTIGATE_JOB, PICKUP_JOB } from "../../apps/api/src/modules/engineering-tasks/service";

export type StepOutcome = { ok: true } | { ok: false; code: string };

export type ProbeResult = "blocked" | "allowed" | "unknown";

export interface SandboxSummary {
  outsideWrite: ProbeResult;
  secret: ProbeResult;
  network: ProbeResult;
}

export interface ProbePaths {
  outsideFile: string;
  secretFile: string;
  url: string;
}

export interface SmokeSummary {
  investigate: StepOutcome;
  /** Null when the develop run never happened. */
  develop: { files: number; testsPassed: boolean; unsafe: boolean } | null;
  commit: StepOutcome;
  mergeLocal: StepOutcome;
  cancelledBeforePush: boolean;
  lockReleased: boolean;
  sandbox: SandboxSummary;
}

const outcomeLine = (label: string, o: StepOutcome) =>
  `${label}: ${o.ok ? "ok" : `failed(${o.code})`}`;

/** The printed lines: statuses, booleans and counts only. Pure. */
export function formatSummary(s: SmokeSummary): string[] {
  return [
    outcomeLine("investigate", s.investigate),
    s.develop
      ? `develop: files=${s.develop.files} testsPassed=${s.develop.testsPassed} unsafe=${s.develop.unsafe}`
      : "develop: not_run",
    outcomeLine("commit", s.commit),
    outcomeLine("merge_local", s.mergeLocal),
    `cancelled_before_push: ${s.cancelledBeforePush}`,
    `lock_released: ${s.lockReleased}`,
    `sandbox: outside_write=${s.sandbox.outsideWrite} secret=${s.sandbox.secret} network=${s.sandbox.network}`,
  ];
}

const MARKER = /^SANDBOX_PROBE outside_write=(\S+) secret=(\S+) network=(\S+)\s*$/;
const asProbe = (v: string | undefined): ProbeResult =>
  v === "blocked" || v === "allowed" ? v : "unknown";

/** Reads the last SANDBOX_PROBE line of the test output tail; anything else is `unknown`. Pure. */
export function parseSandboxProbe(tail: string | null): SandboxSummary {
  const unknown: SandboxSummary = {
    outsideWrite: "unknown",
    secret: "unknown",
    network: "unknown",
  };
  if (!tail) return unknown;
  let m: RegExpMatchArray | null = null;
  for (const line of tail.split("\n")) m = line.match(MARKER) ?? m;
  if (!m) return unknown;
  return { outsideWrite: asProbe(m[1]), secret: asProbe(m[2]), network: asProbe(m[3]) };
}

/** 1 when any sandbox probe got through; `unknown` is not a failure. Pure. */
export function smokeExitCode(s: SmokeSummary): 0 | 1 {
  const { outsideWrite, secret, network } = s.sandbox;
  return [outsideWrite, secret, network].includes("allowed") ? 1 : 0;
}

const SECRET_SENTINEL = "synapse-smoke-placeholder-sentinel";

/** Source of the probe test. It prints one marker line and never the content it read. Pure. */
export function probeTestSource(probe: ProbePaths): string {
  return `import { test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";

test("sandbox probe", async () => {
  const tries = async (f: () => unknown): Promise<"allowed" | "blocked"> => {
    try {
      await f();
      return "allowed";
    } catch {
      return "blocked";
    }
  };
  const outsideWrite = await tries(() => writeFileSync(${JSON.stringify(probe.outsideFile)}, "x"));
  const secret = await tries(() => readFileSync(${JSON.stringify(probe.secretFile)}, "utf8"));
  const network = await tries(async () => {
    await fetch(${JSON.stringify(probe.url)}, { signal: AbortSignal.timeout(5000) });
  });
  console.log(\`SANDBOX_PROBE outside_write=\${outsideWrite} secret=\${secret} network=\${network}\`);
});
`;
}

/** A step's outcome: `done` is ok, anything else is its status or fixed failure code. Pure. */
export function outcomeOf(status: string | undefined, failure: string | null): StepOutcome {
  if (status === undefined) return { ok: false, code: "not_run" };
  if (status === "done") return { ok: true };
  if (failure === null) return { ok: false, code: status };
  // Only fixed reason codes are printed; anything else could carry text.
  return { ok: false, code: /^[a-z_]+(:[a-z_]+)?$/.test(failure) ? failure : "unknown" };
}

const MATH_SRC = "export function add(a: number, b: number): number {\n  return a - b;\n}\n";
const MATH_TEST = `import { expect, test } from "bun:test";
import { add } from "./math";

test("add sums two numbers", () => {
  expect(add(2, 3)).toBe(5);
});
`;

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", args, { cwd, stdio: "ignore" });
  if (r.status !== 0) throw new Error(`setup git ${args[0]} failed`);
}

/** Placeholder repo: `main` and `stage` pushed to bare origin.git and upstream.git. */
export function buildRepo(root: string, probe: ProbePaths): string {
  const repo = join(root, "work");
  mkdirSync(join(repo, "src"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "dev@example.com");
  git(repo, "config", "user.name", "Demo Dev");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
  writeFileSync(join(repo, "src", "math.ts"), MATH_SRC);
  writeFileSync(join(repo, "src", "math.test.ts"), MATH_TEST);
  writeFileSync(join(repo, "src", "sandbox-probe.test.ts"), probeTestSource(probe));
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "branch", "stage");
  for (const name of ["origin", "upstream"]) {
    const bare = join(root, `${name}.git`);
    git(root, "init", "-q", "--bare", "-b", "main", bare);
    git(repo, "remote", "add", name, `file://${bare}`);
    git(repo, "push", "-q", name, "main", "stage");
  }
  git(repo, "remote", "set-url", "--push", "upstream", "DISABLED");
  git(repo, "fetch", "-q", "upstream");
  return repo;
}

if (import.meta.main) await main();

async function main(): Promise<void> {
  const cache = join(homedir(), ".cache");
  mkdirSync(cache, { recursive: true });
  const dir = mkdtempSync(join(cache, "synapse-develop-smoke-"));
  mkdirSync(join(dir, "data"), { recursive: true });
  // This instance's run root (hashed from its own data dir): never the live service's.
  const runRoot = instanceRunRoot(defaultRunScratchRoot(process.env), join(dir, "data"));
  const cleanup = () => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(runRoot, { recursive: true, force: true });
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      cleanup();
      process.exit(130);
    });
  }
  try {
    process.exitCode = await run(dir, runRoot);
  } finally {
    cleanup();
  }
}

async function run(dir: string, runRoot: string): Promise<0 | 1> {
  mkdirSync(join(dir, "data"), { recursive: true });
  const probe: ProbePaths = {
    outsideFile: join(dir, "outside-probe.txt"),
    secretFile: join(dir, "data", "probe-secret.txt"),
    url: "https://example.com/",
  };
  writeFileSync(probe.secretFile, SECRET_SENTINEL);
  const repo = buildRepo(dir, probe);
  const config = { ...loadConfig(process.env), dbPath: join(dir, "data", "t.db") };
  const c = createContainer(config, { notifier: new NoopDesktopNotifier() });
  // The cleanup deletes exactly this dir; it must be the one the container uses.
  if (c.runRoot !== runRoot) throw new Error("develop-smoke: unexpected run root");
  c.settings.set("engineering.model", "haiku");

  const signal = () => AbortSignal.timeout(35 * 60_000);
  const ctx = { signal: signal(), checkpoint() {}, getCheckpoint: () => undefined } as never;
  const DRAINED = [INVESTIGATE_JOB, STEP_JOB, "approval.execute"];
  /** Delivers events (approval.approved -> approval.execute) and runs queued jobs until none is left. */
  const drain = async (): Promise<void> => {
    for (let i = 0; i < 60; i++) {
      c.dispatcher.dispatchOnce();
      const next = c.sqlite
        .query(
          `select id, type from jobs where status = 'PENDING' and type in (${DRAINED.map(() => "?").join(",")}) order by rowid asc limit 1`,
        )
        .get(...DRAINED) as { id: string; type: string } | null;
      if (!next) return;
      c.sqlite.query("update jobs set status = 'COMPLETED' where id = ?").run(next.id);
      const h = c.handlers.get(next.type);
      const job = c.queue.get(next.id);
      if (!h || !job) throw new Error(`no handler or job for ${next.type}`);
      try {
        await h.handler(job, ctx);
      } catch {
        // A failed step is visible in the task state; the summary reports it by code.
      }
    }
    throw new Error("drain did not settle");
  };
  const pendingApproval = (action: string): Approval | undefined =>
    c.approvals.listPending().find((a) => a.action === action);
  const approveAndRun = async (action: string): Promise<boolean> => {
    const a = pendingApproval(action);
    if (!a) return false;
    c.approvals.approve(a.id);
    await drain();
    return true;
  };

  const registered = await c.repositories.register({
    path: repo,
    name: "smoke",
    trackedBranch: "stage",
    environments: [{ name: "stage", branch: "stage", protected: false, autoDeploysOnMerge: true }],
    jiraProjectKeys: [],
  });
  const environmentId = registered.environments.find((e) => e.name === "stage")?.id;

  const task = c.engineering.create({
    repositoryId: registered.id,
    title: "Fix add()",
    draftDescription: "add(2, 3) returns -1; it should return 5.",
  });
  const id = task.id;
  const get = (): EngineeringTaskDetail => {
    const t = c.engineering.get(id);
    if (!t) throw new Error("task vanished");
    return t;
  };
  const step = (name: string) => get().steps.find((s) => s.step === name);
  const outcome = (name: string): StepOutcome => {
    const s = step(name);
    const failure = (s?.output as { failure?: unknown } | null)?.failure;
    return outcomeOf(s?.status, typeof failure === "string" ? failure : null);
  };

  // Investigate (real haiku run, read-only).
  c.engineering.approveDescription(
    id,
    "The add function in src/math.ts returns a - b. Fix it so add(2, 3) returns 5 and the test in src/math.test.ts passes.",
  );
  await drain();
  let investigate = outcome("investigate");
  if (investigate.ok && get().status !== "planned") {
    investigate = { ok: false, code: get().failure ?? get().status };
  }

  // Plan approval with the branch and the test command, pickup, branch and develop (real haiku run).
  if (investigate.ok) {
    await c.engineering.approvePlan(id, {
      parentBranch: "stage",
      testCommand: "bun test",
      ...(environmentId ? { environmentId } : {}),
    });
    const picked = await c.handlers.get(PICKUP_JOB)?.handler({} as never, ctx);
    if ((picked as { pickedUp?: string } | undefined)?.pickedUp === id) await drain();
  }

  const developStep = step("develop");
  const dev = developStep?.output as {
    files?: unknown[];
    testsPassed?: boolean;
    testOutputTail?: string | null;
    unsafeReasons?: unknown[];
    failure?: string;
  } | null;
  const ran = Array.isArray(dev?.files);
  const develop = ran
    ? {
        files: dev?.files?.length ?? 0,
        testsPassed: dev?.testsPassed === true,
        unsafe: (dev?.unsafeReasons?.length ?? 0) > 0 || dev?.failure === "unsafe_change",
      }
    : null;

  // Approve the commit, then merge_local; push_pr is never approved.
  if (get().status === "awaiting_approval" && get().currentStep === "commit") {
    await approveAndRun("engineering.commit");
    await drain();
  }
  if (get().status === "awaiting_approval" && get().currentStep === "merge_local") {
    await approveAndRun("engineering.merge_local");
  }

  // Stop before push: the push approval (if any) is left pending, then the task is cancelled.
  let cancelled = false;
  if (!["completed", "failed", "cancelled"].includes(get().status)) {
    c.engineering.cancel(id);
    await drain();
    cancelled = get().status === "cancelled";
  }

  // Ground truth on the host: a file at outsideFile means the write got through.
  const probed = parseSandboxProbe(
    typeof dev?.testOutputTail === "string" ? dev.testOutputTail : null,
  );
  const sandbox: SandboxSummary = {
    ...probed,
    outsideWrite: existsSync(probe.outsideFile) ? "allowed" : probed.outsideWrite,
  };

  const summary: SmokeSummary = {
    investigate,
    develop,
    commit: outcome("commit"),
    mergeLocal: outcome("merge_local"),
    cancelledBeforePush: cancelled && step("push_pr")?.status !== "done",
    lockReleased: !c.engineeringLock.view().held,
    sandbox,
  };
  for (const line of formatSummary(summary)) console.log(line);
  c.sqlite.close();
  return smokeExitCode(summary);
}
