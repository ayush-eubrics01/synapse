import { type Job, JobError } from "@synapse/contracts";
import { type Db, schema } from "@synapse/database";
import { desc, eq, sql } from "drizzle-orm";
import type { SettingsService } from "../../core/config/settings";
import type { HandlerRegistration, JobContext } from "../../core/jobs/worker";
import type { ClaudeOrchestrator } from "../../core/orchestrator/orchestrator";
import { buildDevelopRequest } from "../../intelligence/engineering/develop-prompt";
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
}

/**
 * Registers `engineering.step {taskId, step}` (E8, E9, E11, E15): `branch`, `develop` (the one
 * scoped engineering run, one attempt), `update_parent` (enqueued by the commit executor, so the
 * approval execution stays short) and `cleanup`. The approval-gated steps (commit, merge_local,
 * push_pr, merge_pr) run from their approval executors, not from here. Model text is never logged.
 */
export function registerStepJob(deps: StepJobDeps): void {
  const { db, settings, orchestrator, steps } = deps;

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
          run: (t) =>
            orchestrator.run(
              buildDevelopRequest(
                { approvedDescription: t.approvedDescription, plan: t.plan },
                { localPath: t.localPath, testCommand: t.testCommand },
                {
                  model: settings.get("engineering.model"),
                  maxTurns: settings.get("engineering.develop.maxTurns"),
                  timeoutMinutes: settings.get("engineering.develop.timeoutMinutes"),
                },
                job.id,
              ),
              ctx.signal,
            ),
          runId: () => latestRunId(job.id),
        });
    }
  };

  deps.handlers.set(STEP_JOB, { handler, timeoutMs: STEP_TIMEOUT_MS });
}
