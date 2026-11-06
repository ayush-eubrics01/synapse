import {
  type Confidence,
  type Job,
  JobError,
  type ProfileContent,
  profileContentSchema,
  profileUpdateOutputSchema,
} from "@synapse/contracts";
import { schema } from "@synapse/database";
import { eq } from "drizzle-orm";
import type { JobContext } from "../../core/jobs/worker";
import { parseStructured } from "../../core/orchestrator/structured";
import { observationHash, validateUpdate } from "../../intelligence/people/evidence";
import { selectHistory } from "../../intelligence/people/history";
import { buildUpdateRequest } from "../../intelligence/people/update-prompt";
import { applyDiff } from "../../modules/people/profiles";
import { UPDATE_PROFILE_JOB } from "../../modules/people/recommendations";
import { safely, wrapFailure } from "../intelligence-shared";
import type { PeopleContext } from "./context";
import { evidenceRows, removalEvidenceRows } from "./evidence-rows";
import type { PeopleJobDeps } from "./shared";
import {
  flaggedMessage,
  flagTarget,
  inputSchema,
  SECTION_NAMES,
  UPDATE_TIMEOUT_MS,
} from "./shared";

export function registerUpdateProfile(deps: PeopleJobDeps, c: PeopleContext): void {
  const { db, settings, recommendations, orchestrator, handlers } = deps;
  const { latestRunId, runIdBefore, runtimeFlags, failedRunFlags, baselineOf, historyOpts } = c;

  const updateProfile = async (job: Job, ctx: JobContext) => {
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
    const profile = db
      .select()
      .from(schema.peopleProfiles)
      .where(eq(schema.peopleProfiles.personId, personId))
      .get();
    if (!profile) return { skipped: "no_profile" };
    const current = profileContentSchema.safeParse(profile.content);
    if (!current.success) throw new JobError({ kind: "invalid_input", message: "invalid profile" });
    if (recommendations.hasPending(db, personId)) return { skipped: "pending_recommendation" };

    const items = selectHistory(
      db,
      person.slackUserId,
      historyOpts(baselineOf(profile), settings.get("people.history.maxMessages")),
    );
    if (items.length === 0) return { skipped: "no_new_history" };
    const target = flagTarget(items);
    const targets = target ? [target] : [];

    const before = runIdBefore(job.id);
    let ran = false;
    try {
      const { request: req, used } = buildUpdateRequest(
        current.data,
        items,
        job.id,
        settings.get("people.models.update"),
      );
      const byId = new Map(used.map((i) => [i.messageId, i]));
      const result = await orchestrator.run(req, ctx.signal);
      ran = true;
      runtimeFlags(job.id, targets, result);
      const parsed = parseStructured(result.finalText, profileUpdateOutputSchema);
      if (!parsed.ok) throw new JobError({ kind: "incomplete_ai_output", message: parsed.reason });
      const { suspectedInjection } = parsed.value;
      const valid = validateUpdate(
        current.data,
        parsed.value,
        new Set(byId.keys()),
        settings.get("people.recommendation.minConfidence") as Confidence,
      );
      const runId = latestRunId(job.id);
      const flagged = flaggedMessage(used, suspectedInjection, target);
      let adds = valid.add;
      const build = () => {
        const d = { add: adds, remove: valid.remove, suspectedInjection };
        return { diff: d, resultContent: applyDiff(current.data, d, new Set()) };
      };
      let { diff, resultContent } = build();
      // The executor parses the result with profileContentSchema (max 20 per section): drop the
      // last-added observations of an overfull section until it fits, else propose nothing.
      let full = false;
      for (;;) {
        const over = SECTION_NAMES.find((n) => resultContent[n].length > 20);
        if (!over) break;
        const at = adds.map((a) => a.section).lastIndexOf(over);
        if (at < 0) {
          full = true;
          break;
        }
        adds = adds.filter((_, i) => i !== at);
        ({ diff, resultContent } = build());
      }
      if (full || !profileContentSchema.safeParse(resultContent).success) {
        return db.transaction(
          (tx) => {
            if (suspectedInjection.detected && flagged) {
              deps.securityFlags.recordAiFlag(tx, flagged, runId, suspectedInjection);
            }
            return { skipped: "section_full" };
          },
          { behavior: "immediate" },
        );
      }
      const added = {
        professionalContext: [],
        communication: [],
        responseGuidelines: [],
      } as ProfileContent;
      for (const { section, ...ob } of adds) added[section].push(ob);
      // A diff that changes nothing (or only re-states the current text) proposes nothing.
      const empty =
        adds.length + valid.remove.length === 0 ||
        observationHash(resultContent) === observationHash(current.data);

      return db.transaction(
        (tx) => {
          if (suspectedInjection.detected && flagged) {
            deps.securityFlags.recordAiFlag(tx, flagged, runId, suspectedInjection);
          }
          if (empty) return { empty: true };
          const stored = recommendations.storeUpdate(tx, {
            personId,
            runId,
            baseVersion: profile.currentVersion,
            diff,
            resultContent,
            evidence: [
              ...evidenceRows(added, byId),
              ...removalEvidenceRows(current.data, valid.remove, byId),
            ],
          });
          return "skipped" in stored
            ? { skipped: stored.skipped }
            : { recommendationId: stored.recommendationId };
        },
        { behavior: "immediate" },
      );
    } catch (err) {
      const { classified, rethrow } = wrapFailure(err);
      if (!ran) safely(() => failedRunFlags(job.id, targets, classified, before));
      throw rethrow;
    }
  };
  handlers.set(UPDATE_PROFILE_JOB, { handler: updateProfile, timeoutMs: UPDATE_TIMEOUT_MS });
}
