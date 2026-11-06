import { type Job, JobError, retryDecision, urgencyAssessmentSchema } from "@synapse/contracts";
import type { JobContext } from "../../core/jobs/worker";
import { parseStructured } from "../../core/orchestrator/structured";
import { buildAssessRequest } from "../../intelligence/urgency/assess-prompt";
import { renderExcerpt } from "../../modules/security-flags/detector";
import { safely, wrapFailure } from "../intelligence-shared";
import type { UrgencyContext } from "./context";
import type { BatchRow } from "./shared";
import { ASSESS_TIMEOUT_MS, FALLBACK_REASON, type UrgencyJobDeps } from "./shared";

export function registerAssess(deps: UrgencyJobDeps, c: UrgencyContext): void {
  const { db, settings, orchestrator, securityFlags } = deps;
  const { latestRunId, runIdBefore, runtimeFlags, failedRunFlags } = c;
  const { select, skipStale, writeLevel, enqueueNext, onDeferral, onTerminal } = c;

  const assess = async (job: Job, ctx: JobContext) => {
    db.transaction((tx) => skipStale(tx), { behavior: "immediate" });
    const batch = select(settings.get("urgency.assess.batchMax"));
    if (batch.length === 0) return { assessed: 0 };
    const byId = new Map(batch.map((m) => [m.messageId, m]));

    const before = runIdBefore(job.id);
    let ran = false;
    try {
      const req = buildAssessRequest(batch, job.id, settings.get("urgency.model"));
      const result = await orchestrator.run(req, ctx.signal);
      ran = true;
      runtimeFlags(
        job.id,
        batch.map((b) => b.messageId),
        result,
      );
      const parsed = parseStructured(result.finalText, urgencyAssessmentSchema);
      if (!parsed.ok) {
        throw new JobError({ kind: "incomplete_ai_output", message: parsed.reason });
      }
      const value = parsed.value;

      const seen = new Set<string>();
      for (const a of value.assessments) {
        if (!byId.has(a.messageId) || seen.has(a.messageId)) {
          throw new JobError({
            kind: "incomplete_ai_output",
            message: "assessment output has an unknown or duplicate message id",
          });
        }
        seen.add(a.messageId);
      }

      const runId = latestRunId(job.id);
      let fallbacks = 0;
      for (const a of value.assessments) {
        const m = byId.get(a.messageId) as BatchRow;
        writeLevel(m, a.level, renderExcerpt(a.reason, 300) || "Assessed", false, (tx) => {
          if (a.suspectedInjection.detected) {
            securityFlags.recordAiFlag(tx, m.messageId, runId, a.suspectedInjection);
          }
        });
      }
      for (const m of batch) {
        if (seen.has(m.messageId)) continue;
        fallbacks++;
        writeLevel(m, m.ruleLevel, FALLBACK_REASON, true);
      }
      db.transaction((tx) => enqueueNext(tx, job.id), { behavior: "immediate" });
      return { assessed: seen.size, fallbacks };
    } catch (err) {
      const { classified, rethrow } = wrapFailure(err);
      if (!ran) {
        safely(() =>
          failedRunFlags(
            job.id,
            batch.map((b) => b.messageId),
            classified,
            before,
          ),
        );
      }
      const decision = retryDecision(classified.kind);
      if (decision === "defer") onDeferral(batch);
      else if (
        decision === "needs_attention" ||
        decision === "fail" ||
        job.attempts >= job.maxAttempts
      ) {
        onTerminal(batch, job.id);
      }
      throw rethrow;
    }
  };

  deps.handlers.set("urgency.assess", { handler: assess, timeoutMs: ASSESS_TIMEOUT_MS });
}
