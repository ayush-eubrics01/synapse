import {
  type Confidence,
  initialProfileOutputSchema,
  type Job,
  JobError,
} from "@synapse/contracts";
import { schema } from "@synapse/database";
import { eq } from "drizzle-orm";
import type { JobContext } from "../../core/jobs/worker";
import { parseStructured } from "../../core/orchestrator/structured";
import { observationCount, validateEvidence } from "../../intelligence/people/evidence";
import { selectHistory } from "../../intelligence/people/history";
import { buildInitialRequest } from "../../intelligence/people/initial-prompt";
import { hasProfile, INITIAL_PROFILE_JOB } from "../../modules/people/recommendations";
import { safely, wrapFailure } from "../intelligence-shared";
import type { PeopleContext } from "./context";
import { evidenceRows } from "./evidence-rows";
import type { PeopleJobDeps } from "./shared";
import {
  flaggedMessage,
  flagTarget,
  INITIAL_TIMEOUT_MS,
  inputSchema,
  MIN_HISTORY_ITEMS,
} from "./shared";

export function registerInitialProfile(deps: PeopleJobDeps, c: PeopleContext): void {
  const { db, clock, settings, recommendations, orchestrator, handlers } = deps;
  const { latestRunId, runIdBefore, runtimeFlags, failedRunFlags } = c;

  const generateInitial = async (job: Job, ctx: JobContext) => {
    const input = inputSchema.safeParse(job.input);
    if (!input.success)
      throw new JobError({ kind: "invalid_input", message: "personId is required" });
    const { personId } = input.data;
    const person = db
      .select({ slackUserId: schema.people.slackUserId })
      .from(schema.people)
      .where(eq(schema.people.id, personId))
      .get();
    if (!person) throw new JobError({ kind: "invalid_input", message: "unknown person" });
    // R7 M-1: a profile approved after the job was queued; an initial could never apply.
    if (hasProfile(db, personId)) return { skipped: "profile_exists" };
    if (recommendations.hasPending(db, personId)) return { skipped: "pending_recommendation" };

    const items = selectHistory(db, person.slackUserId, {
      days: settings.get("people.history.days"),
      maxMessages: settings.get("people.history.maxMessages"),
      selfUserId: settings.get("slack.selfUserId"),
      now: clock.now(),
    });
    if (items.length < MIN_HISTORY_ITEMS) return { skipped: "insufficient_history" };
    // R1/R5: runtime signals attach to one message of the person, never to the user's own.
    const target = flagTarget(items);
    const targets = target ? [target] : [];

    const before = runIdBefore(job.id);
    let ran = false;
    try {
      const { request: req, used } = buildInitialRequest(
        items,
        job.id,
        settings.get("people.models.initial"),
      );
      // Only what was really sent can be cited.
      const byId = new Map(used.map((i) => [i.messageId, i]));
      const result = await orchestrator.run(req, ctx.signal);
      ran = true;
      runtimeFlags(job.id, targets, result);
      const parsed = parseStructured(result.finalText, initialProfileOutputSchema);
      if (!parsed.ok) throw new JobError({ kind: "incomplete_ai_output", message: parsed.reason });
      const { profile, suspectedInjection } = parsed.value;
      const { content, dropped } = validateEvidence(
        profile,
        new Set(byId.keys()),
        settings.get("people.recommendation.minConfidence") as Confidence,
      );
      const runId = latestRunId(job.id);
      // R1/R5: the person's (or a bystander's) message holding the model's quote, else the target.
      const flagged = flaggedMessage(used, suspectedInjection, target);

      const outcome = db.transaction(
        (tx) => {
          if (suspectedInjection.detected && flagged) {
            deps.securityFlags.recordAiFlag(tx, flagged, runId, suspectedInjection);
          }
          if (observationCount(content) === 0) return { empty: true };
          const stored = recommendations.storeInitial(tx, {
            personId,
            runId,
            content,
            evidence: evidenceRows(content, byId),
          });
          return "skipped" in stored
            ? { skipped: stored.skipped }
            : { recommendationId: stored.recommendationId };
        },
        { behavior: "immediate" },
      );
      // Counts only (the smoke script reads them): history sent, observations dropped by validation.
      return { ...outcome, history: items.length, dropped };
    } catch (err) {
      const { classified, rethrow } = wrapFailure(err);
      if (!ran) safely(() => failedRunFlags(job.id, targets, classified, before));
      throw rethrow;
    }
  };

  handlers.set(INITIAL_PROFILE_JOB, { handler: generateInitial, timeoutMs: INITIAL_TIMEOUT_MS });
}
