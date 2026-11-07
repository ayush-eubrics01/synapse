import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { type Job, JobError, SANDBOX_MASKED_ROOTS, SANDBOX_ROOT_MASKED } from "@synapse/contracts";
import { type Db, schema } from "@synapse/database";
import { desc, eq, sql } from "drizzle-orm";
import { defaultRunScratchRoot } from "../../core/config/config";
import type { SettingsService } from "../../core/config/settings";
import type { HandlerRegistration, JobContext } from "../../core/jobs/worker";
import type { ClaudeOrchestrator } from "../../core/orchestrator/orchestrator";
import {
  buildDevelopRequest,
  REPO_IN_MASKED_PATH,
  repoInDenyMask,
  repoInMaskedPath,
  runRootMasked,
  SANDBOX_PATH_TOO_LONG,
} from "../../intelligence/engineering/develop-prompt";
import { STEP_JOB } from "../../modules/engineering-tasks/lock";
import {
  type EngineeringStepService,
  JOB_STEPS,
  type JobStep,
} from "../../modules/engineering-tasks/steps";

/**
 * The handler timeout: the develop run's longest allowed timeout (the setting's maximum, 120 min)
 * plus time waiting for a Claude slot. Fixed, so a later settings change can never outlast it.
 */
const STEP_TIMEOUT_MS = (120 + 10) * 60_000;

export interface StepJobDeps {
  db: Db;
  settings: Pick<SettingsService, "get">;
  orchestrator: Pick<ClaudeOrchestrator, "run">;
  steps: Pick<EngineeringStepService, "runBranch" | "runDevelop" | "runUpdateParent" | "cleanup">;
  handlers: Map<string, HandlerRegistration>;
  /**
   * ADR-040. Each develop run gets `<runRoot>/r/<hex>` (runScratchDir), removed when the run ends,
   * with the sandbox `tmpDir` `<that>/t` inside it (at most RUN_TMP_MAX_BYTES). `runRoot` (default `~/.cache/synapse`, Task 4b) must be outside
   * the data and backup dirs: a TMPDIR under a sandbox mask breaks every Bash call, and rule M
   * refuses it. `runRoot` and `r` are kept 0700. `home` and `protectedDirs` (the data and
   * backup dirs) feed the deny list. `maskedRoots` defaults to SANDBOX_MASKED_ROOTS: a repository
   * at or under one is refused (`repo_in_masked_path`). Tests, whose repositories live under the
   * OS temp dir, pass [].
   */
  sandbox: {
    runRoot: string;
    home: string;
    protectedDirs: string[];
    maskedRoots?: readonly string[];
  };
}

/**
 * ADR-040, fix round 2: the longest tmpDir a develop run may use, in bytes. The sandbox creates
 * its unix bridge sockets under TMPDIR, and AF_UNIX paths are limited to 108 bytes (with the NUL);
 * a ~89-byte TMPDIR failed on the real CLI ("Failed to create bridge sockets after 5 attempts").
 */
export const RUN_TMP_MAX_BYTES = 64;

/** True when `<runRoot>/r/<8hex>/t` (the fixed-length shape of a run's tmpDir) is over the cap. */
export function runTmpTooLong(runRoot: string): boolean {
  return Buffer.byteLength(join(runRoot, "r", "00000000", "t")) > RUN_TMP_MAX_BYTES;
}

/**
 * A develop run's scratch dir: `<runRoot>/r/<first 8 hex of sha256(jobId)>`, short on purpose
 * (RUN_TMP_MAX_BYTES). If that name is taken (a leftover), 12 then 16 hex; null when all three are
 * taken, and the run is refused rather than sharing a dir.
 */
export function runScratchDir(
  runRoot: string,
  jobId: string,
  exists: (path: string) => boolean = existsSync,
): string | null {
  const hex = createHash("sha256").update(jobId).digest("hex");
  for (const n of [8, 12, 16]) {
    const dir = join(runRoot, "r", hex.slice(0, n));
    if (!exists(dir)) return dir;
  }
  return null;
}

/**
 * Removes leftover `<runRoot>/r/*` entries (develop runs whose process was killed before its
 * `finally` ran). Called once by main.ts after the port bind (never from createContainer), when no engineering step runs in this process. Best
 * effort: an entry that cannot be removed logs one fixed line and the others still go.
 */
export function sweepRunScratch(runRoot: string): void {
  const runs = join(runRoot, "r");
  let entries: string[];
  try {
    // Like prepareRunsDir: `r` must be a real directory owned by this user (not a symlink).
    const st = lstatSync(runs);
    const uid = process.getuid?.();
    if (!st.isDirectory() || (uid !== undefined && st.uid !== uid)) {
      console.error("engineering.step: run scratch sweep skipped, run dir is not private");
      return;
    }
    entries = readdirSync(runs);
  } catch {
    return; // no runs dir yet
  }
  for (const e of entries) {
    try {
      rmSync(join(runs, e), { recursive: true, force: true });
    } catch {
      console.error("engineering.step: run scratch sweep failed");
    }
  }
}

export const INSTANCE_ROOT_MAX_AGE_MS = 7 * 86_400_000;

/** Newest lstat mtime of `p` and everything below it. Never follows a symlink. */
function newestMtimeMs(p: string): number {
  const st = lstatSync(p);
  let newest = st.mtimeMs;
  if (st.isDirectory()) {
    for (const e of readdirSync(p)) newest = Math.max(newest, newestMtimeMs(join(p, e)));
  }
  return newest;
}

/**
 * The base directory `pruneInstanceRoots` may walk at startup, or null: only a real instance base
 * (`<cache>/synapse`, the default scratch root). An in-memory database and a run root under any
 * other base (a test's, an override's) are never pruned.
 */
export function pruneBaseFor(
  dbPath: string,
  runRoot: string,
  env: NodeJS.ProcessEnv,
): string | null {
  if (dbPath === ":memory:") return null;
  const base = dirname(runRoot);
  return base === defaultRunScratchRoot(env) ? base : null;
}

/**
 * Removes old instance run roots (`<base>/<8 hex>`) left by other data dirs or smokes (ADR-040).
 * Only a real directory (not a symlink) owned by this user, other than `keepRoot`, with nothing
 * modified inside for `maxAgeMs`. Anything else counts as kept; errors are swallowed per entry.
 */
export function pruneInstanceRoots(
  base: string,
  keepRoot: string,
  opts: { nowMs?: number; maxAgeMs?: number } = {},
): { removed: number; kept: number } {
  const nowMs = opts.nowMs ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? INSTANCE_ROOT_MAX_AGE_MS;
  let entries: string[];
  try {
    // The base itself must be a real directory, not a symlink that would redirect the pruning.
    if (!lstatSync(base).isDirectory()) return { removed: 0, kept: 0 };
    entries = readdirSync(base);
  } catch {
    return { removed: 0, kept: 0 };
  }
  const uid = process.getuid?.();
  const keepName = basename(keepRoot);
  let removed = 0;
  let kept = 0;
  for (const e of entries) {
    if (!/^[0-9a-f]{8}$/.test(e) || e === keepName) continue;
    const dir = join(base, e);
    try {
      const st = lstatSync(dir);
      if (!st.isDirectory() || (uid !== undefined && st.uid !== uid)) {
        kept++;
        continue;
      }
      if (nowMs - newestMtimeMs(dir) <= maxAgeMs) {
        kept++;
        continue;
      }
      rmSync(dir, { recursive: true, force: true });
      removed++;
    } catch {
      kept++;
    }
  }
  return { removed, kept };
}

/**
 * Creates `<runRoot>/r` (every level it creates 0700) and keeps `runRoot` and `r` at 0700
 * (Task 4b). Each must be a real directory owned by this user, not a symlink that chmod would
 * follow or a dir another user planted. Throws on any failure (the run never starts).
 */
function prepareRunsDir(runRoot: string): void {
  const runs = join(runRoot, "r");
  mkdirSync(runs, { recursive: true, mode: 0o700 });
  const uid = process.getuid?.();
  for (const d of [runRoot, runs]) {
    const st = lstatSync(d);
    if (!st.isDirectory() || (uid !== undefined && st.uid !== uid)) {
      throw new Error("engineering.step: run root is not a private directory");
    }
    chmodSync(d, 0o700);
  }
}

/**
 * Registers `engineering.step {taskId, step}` (E8, E9, E11, E15): `branch`, `develop` (the one
 * scoped engineering run, one attempt), `update_parent` (enqueued by the commit executor, so the
 * approval execution stays short) and `cleanup`. The approval-gated steps (commit, merge_local,
 * push_pr, merge_pr) run from their approval executors, not from here. Model text is never logged.
 */
export function registerStepJob(deps: StepJobDeps): void {
  const { db, settings, orchestrator, steps, sandbox } = deps;
  const maskedRoots = sandbox.maskedRoots ?? SANDBOX_MASKED_ROOTS;

  const latestRunId = (jobId: string): string | null =>
    db
      .select({ id: schema.claudeRuns.id })
      .from(schema.claudeRuns)
      .where(eq(schema.claudeRuns.jobId, jobId))
      .orderBy(desc(schema.claudeRuns.startedAt), sql`${schema.claudeRuns}.rowid desc`)
      .limit(1)
      .get()?.id ?? null;

  const handler = async (job: Job, ctx: JobContext) => {
    const input = job.input as { taskId?: unknown; step?: unknown } | null;
    const taskId = typeof input?.taskId === "string" ? input.taskId : null;
    const step = JOB_STEPS.find((s) => s === input?.step) as JobStep | undefined;
    if (!taskId || !step) {
      throw new JobError({ kind: "invalid_input", message: "taskId and a step are required" });
    }
    switch (step) {
      case "branch":
        return steps.runBranch(taskId);
      case "update_parent":
        return steps.runUpdateParent(taskId);
      case "cleanup":
        return steps.cleanup(taskId);
      case "develop":
        return steps.runDevelop(taskId, {
          run: async (t) => {
            const sandboxed = settings.get("engineering.sandbox.enabled");
            if (
              sandboxed &&
              (repoInMaskedPath(t.localPath, maskedRoots) ||
                repoInDenyMask(sandbox.home, sandbox.protectedDirs, t.localPath))
            ) {
              // Refused before any run: the sandbox would hide the repository from itself, or
              // unmasking it would expose a credential dir, synapse.db or the backups.
              throw new JobError({ kind: "invalid_input", message: REPO_IN_MASKED_PATH });
            }
            if (
              sandboxed &&
              runRootMasked(sandbox.runRoot, sandbox.home, sandbox.protectedDirs, maskedRoots)
            ) {
              // Every run's TMPDIR would be masked: refused before anything is created (H4.6).
              throw new JobError({ kind: "invalid_input", message: SANDBOX_ROOT_MASKED });
            }
            // Off: no sandbox and no scratch; rule M refuses the run.
            const runScratch = sandboxed ? runScratchDir(sandbox.runRoot, job.id) : null;
            const tmpDir = runScratch === null ? null : join(runScratch, "t");
            if (sandboxed && tmpDir === null) {
              // Three leftover dirs with this job's prefixes: never share one (the sweep clears them).
              throw new JobError({
                kind: "provider_error",
                message: "run scratch dir unavailable",
              });
            }
            if (tmpDir !== null && Buffer.byteLength(tmpDir) > RUN_TMP_MAX_BYTES) {
              // Refused before anything is created: the sandbox's sockets would not fit.
              throw new JobError({ kind: "invalid_input", message: SANDBOX_PATH_TOO_LONG });
            }
            try {
              if (sandboxed) prepareRunsDir(sandbox.runRoot);
              return await orchestrator.run(
                buildDevelopRequest(
                  { approvedDescription: t.approvedDescription, plan: t.plan },
                  { localPath: t.localPath, testCommand: t.testCommand },
                  {
                    model: settings.get("engineering.model"),
                    maxTurns: settings.get("engineering.develop.maxTurns"),
                    timeoutMinutes: settings.get("engineering.develop.timeoutMinutes"),
                    // Off: no sandbox, so validator rule M refuses the run (never unsandboxed).
                    sandbox: tmpDir
                      ? {
                          tmpDir,
                          home: sandbox.home,
                          protectedDirs: sandbox.protectedDirs,
                        }
                      : null,
                  },
                  job.id,
                ),
                ctx.signal,
              );
            } finally {
              // Also after a throw, timeout or abort: stale run dirs must not pile up in the cache.
              // A failure never replaces the run's result or error; the startup sweep retries.
              try {
                if (runScratch !== null) rmSync(runScratch, { recursive: true, force: true });
              } catch {
                console.error("engineering.step: run scratch cleanup failed");
              }
            }
          },
          runId: () => latestRunId(job.id),
        });
    }
  };

  deps.handlers.set(STEP_JOB, { handler, timeoutMs: STEP_TIMEOUT_MS });
}
