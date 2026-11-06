import { type Job, JobError, retryDecision } from "@synapse/contracts";
import { type Db, schema } from "@synapse/database";
import { desc, eq, sql } from "drizzle-orm";
import type { SettingsService } from "../../core/config/settings";
import type { HandlerRegistration, JobContext } from "../../core/jobs/worker";
import type { ClaudeOrchestrator } from "../../core/orchestrator/orchestrator";
import {
  buildInvestigateRequest,
  finaliseInvestigation,
  parseInvestigation,
} from "../../intelligence/engineering/investigate-prompt";
import { hasInspectionToolResult } from "../../modules/engineering-brain/evidence";
import {
  type EngineeringTaskService,
  INVESTIGATE_JOB,
} from "../../modules/engineering-tasks/service";

/** The run's own timeout; there is no setting for it (the develop run has one). */
export const INVESTIGATE_TIMEOUT_MINUTES = 20;
/** The run's timeout plus time waiting for a Claude slot. */
const HANDLER_TIMEOUT_MS = (INVESTIGATE_TIMEOUT_MINUTES + 5) * 60_000;
const NO_READ_MESSAGE = "no successful Read, Grep or Glob result";

/** `max_turns` or `timeout` when the run stopped on its budget; null for any other failure. */
function stopKind(err: unknown): "max_turns" | "timeout" | null {
  if (!(err instanceof JobError)) return null;
  if (err.classified.details?.maxTurns === true) return "max_turns";
  return err.classified.kind === "timeout" ? "timeout" : null;
}

export interface InvestigateJobDeps {
  db: Db;
  settings: Pick<SettingsService, "get">;
  orchestrator: Pick<ClaudeOrchestrator, "run">;
  service: EngineeringTaskService;
  handlers: Map<string, HandlerRegistration>;
}

/**
 * Registers `engineering.investigate` (E3): one read-only, path-scoped engineering run per
 * approved description, one attempt (the job is enqueued with maxAttempts 1). Any failure puts
 * the task back to `proposed` with a fixed code. Model text is never logged or audited.
 */
export function registerInvestigateJob(deps: InvestigateJobDeps): void {
  const { db, settings, orchestrator, service } = deps;

  const latestRunId = (jobId: string): string | null =>
    db
      .select({ id: schema.claudeRuns.id })
      .from(schema.claudeRuns)
      .where(eq(schema.claudeRuns.jobId, jobId))
      .orderBy(desc(schema.claudeRuns.startedAt), sql`${schema.claudeRuns}.rowid desc`)
      .limit(1)
      .get()?.id ?? null;

  const investigate = async (job: Job, ctx: JobContext) => {
    const input = job.input as { taskId?: unknown } | null;
    const taskId = typeof input?.taskId === "string" ? input.taskId : null;
    if (!taskId) throw new JobError({ kind: "invalid_input", message: "taskId is required" });
    const prepared = await service.prepareInvestigation(taskId);
    if (!prepared.ok) return { skipped: prepared.reason };
    const { target } = prepared;

    const request = buildInvestigateRequest(
      {
        name: target.name,
        localPath: target.localPath,
        approvedDescription: target.approvedDescription,
      },
      job.id,
      {
        model: settings.get("engineering.model"),
        maxTurns: settings.get("engineering.investigate.maxTurns"),
        timeoutMinutes: INVESTIGATE_TIMEOUT_MINUTES,
      },
    );
    const fail = (code: string, error: JobError): never => {
      service.recordInvestigationFailure(taskId, code, latestRunId(job.id));
      throw error;
    };
    const readNothing = (): never =>
      fail(
        "incomplete_ai_output",
        new JobError({ kind: "incomplete_ai_output", message: NO_READ_MESSAGE }),
      );

    let result: Awaited<ReturnType<typeof orchestrator.run>>;
    try {
      result = await orchestrator.run(request, ctx.signal);
    } catch (err) {
      // Quota or auth pause: the queue runs the job again later, so the task stays investigating.
      if (err instanceof JobError && retryDecision(err.classified.kind) === "defer") {
        service.markInvestigationDeferred(taskId);
        throw err;
      }
      if (err instanceof JobError && err.classified.kind === "incomplete_ai_output") readNothing();
      const stop = stopKind(err);
      if (stop) {
        fail(
          stop,
          new JobError({ kind: "needs_attention", message: `investigation run stopped (${stop})` }),
        );
      }
      const kind = err instanceof JobError ? err.classified.kind : "unknown";
      return fail(
        kind,
        err instanceof JobError ? err : new JobError({ kind, message: "run failed" }),
      );
    }
    // ADR-026: a run with no successful read looked at nothing; its plan is not evidence.
    if (!hasInspectionToolResult(result.toolResults)) readNothing();
    const parsed = parseInvestigation(result.finalText);
    if (!parsed.ok) {
      fail("parse_failed", new JobError({ kind: "parse_failed", message: parsed.reason }));
      return;
    }
    const final = finaliseInvestigation(target.localPath, parsed.value);
    return service.recordInvestigation(taskId, {
      ...final,
      claudeRunId: latestRunId(job.id),
      permissionDenials: result.permissionDenials,
    });
  };

  deps.handlers.set(INVESTIGATE_JOB, { handler: investigate, timeoutMs: HANDLER_TIMEOUT_MS });
}
