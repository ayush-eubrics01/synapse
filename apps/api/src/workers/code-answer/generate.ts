import { type Job, JobError, retryDecision } from "@synapse/contracts";
import { type Db, schema } from "@synapse/database";
import { desc, eq, sql } from "drizzle-orm";
import type { SettingsService } from "../../core/config/settings";
import type { HandlerRegistration, JobContext } from "../../core/jobs/worker";
import type { ClaudeOrchestrator } from "../../core/orchestrator/orchestrator";
import { buildCodeAnswerRequest, parseCodeAnswer } from "../../intelligence/code-answer/prompt";
import {
  type AfterFinish,
  CODE_ANSWER_JOB,
  type CodeAnswerService,
} from "../../modules/code-answers/service";
import {
  hasInspectionToolResult,
  observedPaths,
  verifyCitations,
} from "../../modules/engineering-brain/evidence";

const NO_READ_MESSAGE = "no successful Read, Grep or Glob result";

/** `max_turns` or `timeout` when the run stopped on its budget; null for any other failure. */
function stopKind(err: unknown): "max_turns" | "timeout" | null {
  if (!(err instanceof JobError)) return null;
  if (err.classified.details?.maxTurns === true) return "max_turns";
  return err.classified.kind === "timeout" ? "timeout" : null;
}

export interface CodeAnswerJobDeps {
  db: Db;
  settings: Pick<SettingsService, "get">;
  orchestrator: Pick<ClaudeOrchestrator, "run">;
  service: CodeAnswerService;
  /** Task 10: runs in the transaction that settles the row, for every final status of a run. */
  onFinished?: AfterFinish;
  handlers: Map<string, HandlerRegistration>;
}

/**
 * Registers `code_answer.generate` (C2, C3): one read-only, path-scoped `reader` run, one attempt.
 * A run with no successful Read, Grep or Glob result has failed (ADR-026); cited paths count only
 * when observed in raw tool results. Question text, answer text and paths are never logged,
 * audited or put in a job error.
 */
export function registerCodeAnswerJob(deps: CodeAnswerJobDeps): void {
  const { db, settings, orchestrator, service, onFinished } = deps;
  const after: AfterFinish | undefined = onFinished;

  const latestRunId = (jobId: string): string | null =>
    db
      .select({ id: schema.claudeRuns.id })
      .from(schema.claudeRuns)
      .where(eq(schema.claudeRuns.jobId, jobId))
      .orderBy(desc(schema.claudeRuns.startedAt), sql`${schema.claudeRuns}.rowid desc`)
      .limit(1)
      .get()?.id ?? null;

  const generate = async (job: Job, ctx: JobContext) => {
    const input = job.input as { codeAnswerId?: unknown } | null;
    const id = typeof input?.codeAnswerId === "string" ? input.codeAnswerId : null;
    if (!id) throw new JobError({ kind: "invalid_input", message: "codeAnswerId is required" });
    const prepared = service.prepare(id);
    if (!prepared.ok) {
      // prepare already settled the row as failed; let the trigger react to it.
      if (after && prepared.reason !== "not_found" && prepared.reason !== "not_queued") {
        const row = service.get(id);
        if (row)
          db.transaction((tx) => after(tx, { id, trigger: row.trigger, status: row.status }));
      }
      return { skipped: prepared.reason };
    }
    const { target } = prepared;

    const request = buildCodeAnswerRequest(
      {
        repository: { name: target.repository.name, root: target.repository.root },
        question: target.question,
        thread: target.thread,
        facts: target.facts,
      },
      job.id,
      {
        model: settings.get("codeAnswer.model"),
        maxTurns: settings.get("codeAnswer.maxTurns"),
        timeoutMinutes: settings.get("codeAnswer.timeoutMinutes"),
      },
      target.trigger,
    );
    const fail = (code: string, error: JobError): never => {
      service.recordFailure(id, code, latestRunId(job.id), after);
      throw error;
    };
    const readNothing = (): never =>
      fail(
        "no_tool_result",
        new JobError({ kind: "incomplete_ai_output", message: NO_READ_MESSAGE }),
      );

    let result: Awaited<ReturnType<typeof orchestrator.run>>;
    try {
      result = await orchestrator.run(request, ctx.signal);
    } catch (err) {
      if (err instanceof JobError && retryDecision(err.classified.kind) === "defer") {
        service.markQueued(id);
        throw err;
      }
      if (err instanceof JobError && err.classified.kind === "incomplete_ai_output") readNothing();
      const stop = stopKind(err);
      if (stop) {
        fail(
          stop,
          new JobError({ kind: "needs_attention", message: `code answer run stopped (${stop})` }),
        );
      }
      const kind = err instanceof JobError ? err.classified.kind : "unknown";
      return fail(
        kind,
        err instanceof JobError ? err : new JobError({ kind, message: "run failed" }),
      );
    }
    // ADR-026: a run that read nothing is not evidence, whatever it says.
    if (!hasInspectionToolResult(result.toolResults)) readNothing();
    const parsed = parseCodeAnswer(result.finalText);
    if (!parsed.ok) {
      fail("parse_failed", new JobError({ kind: "parse_failed", message: parsed.reason }));
      return;
    }
    const output = parsed.value;
    const verified = output.answerable
      ? verifyCitations(
          target.repository.root,
          output.evidence,
          observedPaths(target.repository.root, result.toolResults),
        )
      : { kept: [], dropped: 0 };
    const status = service.recordResult(
      id,
      {
        output,
        kept: verified.kept,
        dropped: verified.dropped,
        claudeRunId: latestRunId(job.id),
        permissionDenials: result.permissionDenials,
      },
      after,
    );
    return { status, kept: verified.kept.length, dropped: verified.dropped };
  };

  deps.handlers.set(CODE_ANSWER_JOB, {
    handler: generate,
    timeoutMs: (settings.get("codeAnswer.timeoutMinutes") + 5) * 60_000,
  });
}
