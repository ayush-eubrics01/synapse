import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type Job, JobError, SANDBOX_MASKED_ROOTS } from "@synapse/contracts";
import { type Db, schema } from "@synapse/database";
import { desc, eq, sql } from "drizzle-orm";
import type { SettingsService } from "../../core/config/settings";
import type { HandlerRegistration, JobContext } from "../../core/jobs/worker";
import type { ClaudeOrchestrator } from "../../core/orchestrator/orchestrator";
import {
  buildDevelopRequest,
  REPO_IN_MASKED_PATH,
  repoInDenyMask,
  repoInMaskedPath,
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
   * ADR-040. Each develop run gets `<scratchDir>/runs/<jobId>`, removed when the run ends, with the
   * sandbox `tmpDir` inside it. `home` and `protectedDirs` (the data and backup dirs) feed the
   * deny list. `maskedRoots` defaults to SANDBOX_MASKED_ROOTS: a repository at or under one is
   * refused (`repo_in_masked_path`). Tests, whose repositories live under the OS temp dir, pass [].
   */
  sandbox: {
    scratchDir: string;
    home: string;
    protectedDirs: string[];
    maskedRoots?: readonly string[];
  };
}

/**
 * Removes leftover `<scratchDir>/runs/*` entries (develop runs whose process was killed before its
 * `finally` ran). Called once at API start, when no engineering step runs in this process. Best
 * effort: an entry that cannot be removed logs one fixed line and the others still go.
 */
export function sweepRunScratch(scratchDir: string): void {
  const runs = join(scratchDir, "runs");
  let entries: string[];
  try {
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
            const runScratch = join(sandbox.scratchDir, "runs", job.id);
            try {
              return await orchestrator.run(
                buildDevelopRequest(
                  { approvedDescription: t.approvedDescription, plan: t.plan },
                  { localPath: t.localPath, testCommand: t.testCommand },
                  {
                    model: settings.get("engineering.model"),
                    maxTurns: settings.get("engineering.develop.maxTurns"),
                    timeoutMinutes: settings.get("engineering.develop.timeoutMinutes"),
                    // Off: no sandbox, so validator rule M refuses the run (never unsandboxed).
                    sandbox: sandboxed
                      ? {
                          tmpDir: join(runScratch, "tmp"),
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
              // Also after a throw, timeout or abort: stale run dirs must not fill the data dir.
              // A failure never replaces the run's result or error; the startup sweep retries.
              try {
                rmSync(runScratch, { recursive: true, force: true });
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
