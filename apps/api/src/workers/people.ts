import {
  type Confidence,
  initialProfileOutputSchema,
  type Job,
  JobError,
  type ProfileContent,
} from "@synapse/contracts";
import { type Db, schema } from "@synapse/database";
import type { Clock } from "@synapse/shared";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { SettingsService } from "../core/config/settings";
import type { HandlerRegistration, JobContext } from "../core/jobs/worker";
import type { ClaudeOrchestrator } from "../core/orchestrator/orchestrator";
import { parseStructured } from "../core/orchestrator/structured";
import type { SchedulerService } from "../core/scheduler/scheduler";
import { observationCount, validateEvidence } from "../intelligence/people/evidence";
import { selectHistory } from "../intelligence/people/history";
import { buildInitialRequest } from "../intelligence/people/initial-prompt";
import {
  INITIAL_PROFILE_JOB,
  type ProfileRecommendations,
} from "../modules/people/recommendations";
import type { TemporaryContacts } from "../modules/people/temporary";
import type { SecurityFlagsService } from "../modules/security-flags/service";
import { createRunHelpers, safely, wrapFailure } from "./intelligence-shared";

export interface PeopleJobDeps {
  db: Db;
  clock: Clock;
  settings: SettingsService;
  scheduler: SchedulerService;
  temporary: TemporaryContacts;
  recommendations: ProfileRecommendations;
  orchestrator: Pick<ClaudeOrchestrator, "run">;
  securityFlags: SecurityFlagsService;
  handlers: Map<string, HandlerRegistration>;
}

const EXPIRY_TIMEOUT_MS = 60_000;
const INITIAL_TIMEOUT_MS = 420_000;
const MIN_HISTORY_ITEMS = 3;

const inputSchema = z.object({ personId: z.string().min(1) });

/** People Memory jobs. Later tasks add the update and unknown-assessment jobs here. */
export function registerPeopleJobs(deps: PeopleJobDeps): void {
  const { db, clock, settings, scheduler, temporary, recommendations, orchestrator, handlers } =
    deps;
  const { latestRunId, runIdBefore, runtimeFlags, failedRunFlags } = createRunHelpers(
    db,
    deps.securityFlags,
  );

  // Idempotent (a delete by predicate), so a repeated daily run needs no dedupe key; the
  // scheduler has no per-tick key, and `coalesce` stops a backlog.
  handlers.set("people.expire_temporary", {
    handler: async () => ({ deleted: temporary.expire() }),
    timeoutMs: EXPIRY_TIMEOUT_MS,
  });
  scheduler.upsert({
    name: "people.expire_temporary",
    jobType: "people.expire_temporary",
    intervalSeconds: 86_400,
    coalesce: true,
  });

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
    if (recommendations.hasPending(db, personId)) return { skipped: "pending_recommendation" };

    const items = selectHistory(db, person.slackUserId, {
      days: settings.get("people.history.days"),
      maxMessages: settings.get("people.history.maxMessages"),
      selfUserId: settings.get("slack.selfUserId"),
      now: clock.now(),
    });
    if (items.length < MIN_HISTORY_ITEMS) return { skipped: "insufficient_history" };
    const byId = new Map(items.map((i) => [i.messageId, i]));
    // R1: runtime signals attach to one message, not to all 150 the run read.
    const newest = (items[items.length - 1] as (typeof items)[number]).messageId;

    const before = runIdBefore(job.id);
    let ran = false;
    try {
      const req = buildInitialRequest(items, job.id, settings.get("people.models.initial"));
      const result = await orchestrator.run(req, ctx.signal);
      ran = true;
      runtimeFlags(job.id, [newest], result);
      const parsed = parseStructured(result.finalText, initialProfileOutputSchema);
      if (!parsed.ok) throw new JobError({ kind: "incomplete_ai_output", message: parsed.reason });
      const { profile, suspectedInjection } = parsed.value;
      const { content } = validateEvidence(
        profile,
        new Set(byId.keys()),
        settings.get("people.recommendation.minConfidence") as Confidence,
      );
      const runId = latestRunId(job.id);
      // R1: the message whose text holds the model's quote, else the newest provided one.
      const quote = suspectedInjection.quote.trim();
      const flagged =
        (quote !== "" && items.find((i) => i.text.includes(quote))?.messageId) || newest;

      return db.transaction(
        (tx) => {
          if (suspectedInjection.detected) {
            deps.securityFlags.recordAiFlag(tx, flagged, runId, suspectedInjection);
          }
          if (observationCount(content) === 0) return { empty: true };
          const stored = recommendations.storeInitial(tx, {
            personId,
            runId,
            content,
            evidence: evidenceRows(content, byId),
          });
          return stored ? { recommendationId: stored.recommendationId } : { skipped: "raced" };
        },
        { behavior: "immediate" },
      );
    } catch (err) {
      const { classified, rethrow } = wrapFailure(err);
      if (!ran) safely(() => failedRunFlags(job.id, [newest], classified, before));
      throw rethrow;
    }
  };

  handlers.set(INITIAL_PROFILE_JOB, { handler: generateInitial, timeoutMs: INITIAL_TIMEOUT_MS });
}

function evidenceRows(
  content: ProfileContent,
  byId: Map<string, { sentAt: string; sourceRef: string }>,
) {
  const rows = [];
  for (const section of ["professionalContext", "communication", "responseGuidelines"] as const) {
    for (const o of content[section]) {
      for (const id of o.evidence) {
        const m = byId.get(id);
        if (!m) continue; // unreachable after validateEvidence
        rows.push({
          observationKey: o.key,
          messageId: id,
          sourceExternalRef: m.sourceRef,
          confidence: o.confidence,
          observedAt: m.sentAt,
        });
      }
    }
  }
  return rows;
}
