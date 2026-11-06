import { type Job, JobError } from "@synapse/contracts";
import { type Db, schema } from "@synapse/database";
import type { Clock } from "@synapse/shared";
import { desc, eq, sql } from "drizzle-orm";
import type { AuditLogger } from "../../core/audit/audit";
import type { SettingsService } from "../../core/config/settings";
import type { OutboxDispatcher } from "../../core/events/dispatcher";
import type { EventPublisher } from "../../core/events/publisher";
import type { JobQueue } from "../../core/jobs/queue";
import type { HandlerRegistration, JobContext } from "../../core/jobs/worker";
import type { ClaudeOrchestrator } from "../../core/orchestrator/orchestrator";
import type { SchedulerService } from "../../core/scheduler/scheduler";
import { buildInspectRequest, parseInspection } from "../../intelligence/brain/inspect-prompt";
import { hasInspectionToolResult } from "../../modules/engineering-brain/evidence";
import {
  INSPECT_JOB,
  INSPECT_WEEKLY_JOB,
  InspectionService,
  type InspectionServiceDeps,
} from "../../modules/engineering-brain/inspection";

const WEEK_SECONDS = 7 * 86_400;
/** The run's own timeout is at most 60 min (setting); the rest covers a queued Claude slot. */
const INSPECT_HANDLER_TIMEOUT_MS = 65 * 60_000;
/** A few git calls per repository, each with a 10 s timeout. */
const WEEKLY_HANDLER_TIMEOUT_MS = 10 * 60_000;
const REGISTERED_CONSUMER = "brain.inspect_on_register";
const NO_READ_MESSAGE = "no successful Read, Grep or Glob result";

/** `max_turns` or `timeout` when the run stopped on its budget; null for any other failure. */
function stopKind(err: unknown): "max_turns" | "timeout" | null {
  if (!(err instanceof JobError)) return null;
  if (err.classified.details?.maxTurns === true) return "max_turns";
  return err.classified.kind === "timeout" ? "timeout" : null;
}

export interface InspectionJobDeps extends InspectionServiceDeps {
  db: Db;
  clock: Clock;
  settings: Pick<SettingsService, "get">;
  events: Pick<EventPublisher, "publish">;
  audit: Pick<AuditLogger, "record">;
  queue: Pick<JobQueue, "enqueue">;
  orchestrator: Pick<ClaudeOrchestrator, "run">;
  scheduler: Pick<SchedulerService, "upsert">;
  dispatcher: Pick<OutboxDispatcher, "subscribe">;
  handlers: Map<string, HandlerRegistration>;
}

/**
 * Registers `brain.inspect_repository` (C6: one read-only, path-scoped engineering run per
 * repository), the weekly head check that enqueues it, and the `repo.registered` consumer that
 * enqueues the first one. Returns the service so the API can offer "Inspect now".
 */
export function registerInspectionJobs(deps: InspectionJobDeps): InspectionService {
  const { db, settings, orchestrator } = deps;
  const service = new InspectionService(deps);

  const latestRunId = (jobId: string): string | null =>
    db
      .select({ id: schema.claudeRuns.id })
      .from(schema.claudeRuns)
      .where(eq(schema.claudeRuns.jobId, jobId))
      .orderBy(desc(schema.claudeRuns.startedAt), sql`${schema.claudeRuns}.rowid desc`)
      .limit(1)
      .get()?.id ?? null;

  const inspect = async (job: Job, ctx: JobContext) => {
    const input = job.input as { repositoryId?: unknown } | null;
    const repositoryId = typeof input?.repositoryId === "string" ? input.repositoryId : null;
    if (!repositoryId) {
      throw new JobError({ kind: "invalid_input", message: "repositoryId is required" });
    }
    const prepared = await service.prepare(repositoryId);
    if (!prepared.ok) return { skipped: prepared.reason };
    const { target } = prepared;

    const request = buildInspectRequest(
      { name: target.name, localPath: target.localPath },
      job.id,
      {
        model: settings.get("brain.inspect.model"),
        maxTurns: settings.get("brain.inspect.maxTurns"),
        timeoutMinutes: settings.get("brain.inspect.timeoutMinutes"),
      },
    );
    // ADR-026: a run with no successful Read, Grep or Glob result read nothing, so its reply is
    // not evidence of anything. The provider enforces it (expectedToolNames) and so does this.
    const readNothing = (): never => {
      service.recordFailure(repositoryId, "incomplete_ai_output");
      throw new JobError({ kind: "incomplete_ai_output", message: NO_READ_MESSAGE });
    };
    let result: Awaited<ReturnType<typeof orchestrator.run>>;
    try {
      result = await orchestrator.run(request, ctx.signal);
    } catch (err) {
      if (err instanceof JobError && err.classified.kind === "incomplete_ai_output") readNothing();
      const stop = stopKind(err);
      if (!stop) throw err;
      // A run that ran out of turns or time is not retried: the user can "Inspect now".
      service.recordFailure(repositoryId, stop);
      throw new JobError({ kind: "needs_attention", message: `inspection run stopped (${stop})` });
    }
    if (!hasInspectionToolResult(result.toolResults)) readNothing();
    const parsed = parseInspection(result.finalText);
    // Not retried: a second expensive run is unlikely to fix the shape. Reason is content-free.
    if (!parsed.ok) throw new JobError({ kind: "parse_failed", message: parsed.reason });
    return service.record({
      target,
      output: parsed.value,
      claudeRunId: latestRunId(job.id),
      permissionDenials: result.permissionDenials,
      toolResults: result.toolResults,
    });
  };

  deps.handlers.set(INSPECT_JOB, { handler: inspect, timeoutMs: INSPECT_HANDLER_TIMEOUT_MS });
  deps.handlers.set(INSPECT_WEEKLY_JOB, {
    handler: async () => service.weeklyCheck(),
    timeoutMs: WEEKLY_HANDLER_TIMEOUT_MS,
  });
  deps.scheduler.upsert({
    name: INSPECT_WEEKLY_JOB,
    jobType: INSPECT_WEEKLY_JOB,
    intervalSeconds: WEEK_SECONDS,
    coalesce: true,
  });
  deps.dispatcher.subscribe("repo.registered", REGISTERED_CONSUMER, (event, tx) => {
    const payload = event.payload as { repositoryId?: unknown };
    if (typeof payload.repositoryId === "string") service.onRegistered(tx, payload.repositoryId);
  });
  return service;
}
