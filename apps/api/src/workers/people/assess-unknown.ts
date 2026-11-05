import { type Job, JobError, unknownAssessmentOutputSchema } from "@synapse/contracts";
import { schema } from "@synapse/database";
import { isoNow } from "@synapse/shared";
import { and, asc, desc, eq, gte, isNull, notExists } from "drizzle-orm";
import type { JobContext } from "../../core/jobs/worker";
import { parseStructured } from "../../core/orchestrator/structured";
import { buildUnknownRequest } from "../../intelligence/people/unknown-prompt";
import {
  ASSESS_UNKNOWN_JOB,
  ASSESS_UNKNOWN_PRIORITY,
  PEOPLE_CONCURRENCY_GROUP,
} from "../../modules/people/recommendations";
import { renderExcerpt } from "../../modules/security-flags/detector";
import { safely, wrapFailure } from "../intelligence-shared";
import type { PeopleContext } from "./context";
import type { PeopleJobDeps } from "./shared";
import { HOUR_MS, UNKNOWN_BATCH, UNKNOWN_MESSAGES, UNKNOWN_TIMEOUT_MS } from "./shared";

export function registerAssessUnknown(deps: PeopleJobDeps, c: PeopleContext): void {
  const { db, clock, settings, recommendations, orchestrator, handlers } = deps;
  const { queue } = deps;
  const { latestRunId, runIdBefore, runtimeFlags, failedRunFlags } = c;

  const assessUnknown = async (job: Job, ctx: JobContext) => {
    const nowIso = isoNow(clock);
    const candidates = db
      .select()
      .from(schema.temporaryContacts)
      .where(
        and(
          isNull(schema.temporaryContacts.assessedAt),
          gte(schema.temporaryContacts.messageCount, settings.get("people.unknown.minMessages")),
          // R7 M-1: someone with a people row (a priority set, a profile requested) is known.
          notExists(
            db
              .select({ id: schema.people.id })
              .from(schema.people)
              .where(eq(schema.people.slackUserId, schema.temporaryContacts.slackUserId)),
          ),
        ),
      )
      .orderBy(asc(schema.temporaryContacts.firstSeenAt), asc(schema.temporaryContacts.id))
      .all();
    const batch: {
      contactId: string;
      slackUserId: string;
      messages: { id: string; sentAt: string; text: string }[];
    }[] = [];
    let more = false;
    for (const c of candidates) {
      const rows = db
        .select({
          id: schema.slackMessages.id,
          sentAt: schema.slackMessages.sentAt,
          text: schema.slackMessages.text,
        })
        .from(schema.slackMessages)
        .innerJoin(schema.slackUsers, eq(schema.slackUsers.id, schema.slackMessages.senderUserId))
        .where(
          and(
            eq(schema.slackUsers.externalId, c.slackUserId),
            isNull(schema.slackMessages.contentExpiredAt),
          ),
        )
        .orderBy(desc(schema.slackMessages.sentAt), desc(schema.slackMessages.id))
        .limit(UNKNOWN_MESSAGES)
        .all()
        .filter((r): r is typeof r & { text: string } => r.text !== null);
      if (rows.length === 0) continue; // nothing left to show the model
      if (batch.length === UNKNOWN_BATCH) {
        more = true;
        break;
      }
      batch.push({
        contactId: c.id,
        slackUserId: c.slackUserId,
        messages: rows.reverse(),
      });
    }
    const first = batch[0];
    if (!first) return { skipped: "nothing_to_assess" };
    // R1/R5: runtime signals attach to one message: the newest of the first contact (every batch
    // message is a contact's own, never the user's).
    const newest = (first.messages[first.messages.length - 1] as { id: string }).id;
    const targets = [newest];
    const all = batch.flatMap((c) => c.messages);

    const before = runIdBefore(job.id);
    let ran = false;
    try {
      const req = buildUnknownRequest(
        batch.map((c) => ({ slackUserId: c.slackUserId, messages: c.messages })),
        job.id,
        settings.get("people.models.update"),
      );
      const result = await orchestrator.run(req, ctx.signal);
      ran = true;
      runtimeFlags(job.id, targets, result);
      const parsed = parseStructured(result.finalText, unknownAssessmentOutputSchema);
      if (!parsed.ok) throw new JobError({ kind: "incomplete_ai_output", message: parsed.reason });
      const inBatch = new Map(batch.map((c) => [c.slackUserId, c]));
      const seen = new Set<string>();
      for (const a of parsed.value.assessments) {
        if (!inBatch.has(a.slackUserId) || seen.has(a.slackUserId)) {
          throw new JobError({
            kind: "incomplete_ai_output",
            message: "assessment names a contact outside the batch or twice",
          });
        }
        seen.add(a.slackUserId);
      }
      const runId = latestRunId(job.id);
      const { suspectedInjection } = parsed.value;
      const quote = suspectedInjection.quote.trim();
      const flagged = (quote !== "" && all.find((m) => m.text.includes(quote))?.id) || newest;

      return db.transaction(
        (tx) => {
          if (suspectedInjection.detected) {
            deps.securityFlags.recordAiFlag(tx, flagged, runId, suspectedInjection);
          }
          let suggested = 0;
          for (const a of parsed.value.assessments) {
            const reason = renderExcerpt(a.reason, 300);
            tx.update(schema.temporaryContacts)
              .set({
                profileAssessment: { worthProfile: a.worthProfile, reason },
                assessedAt: nowIso,
              })
              .where(
                eq(
                  schema.temporaryContacts.id,
                  (inBatch.get(a.slackUserId) as { contactId: string }).contactId,
                ),
              )
              .run();
            if (a.worthProfile && recommendations.storeSuggestion(tx, a.slackUserId, reason)) {
              suggested++;
            }
          }
          // R7 M-2: a contact the model left out is stamped too, so it leaves the batch.
          for (const c of batch) {
            if (seen.has(c.slackUserId)) continue;
            tx.update(schema.temporaryContacts)
              .set({ profileAssessment: { omitted: true }, assessedAt: nowIso })
              .where(eq(schema.temporaryContacts.id, c.contactId))
              .run();
          }
          if (more) {
            const bucket = new Date(Math.floor(clock.now().getTime() / HOUR_MS + 1) * HOUR_MS);
            queue.enqueue(tx, {
              type: ASSESS_UNKNOWN_JOB,
              idempotencyKey: `people.assess:${bucket.toISOString().slice(0, 13)}`,
              runAfter: bucket.toISOString(),
              concurrencyGroup: PEOPLE_CONCURRENCY_GROUP,
              priority: ASSESS_UNKNOWN_PRIORITY,
            });
          }
          return { assessed: parsed.value.assessments.length, suggested };
        },
        { behavior: "immediate" },
      );
    } catch (err) {
      const { classified, rethrow } = wrapFailure(err);
      if (!ran) safely(() => failedRunFlags(job.id, targets, classified, before));
      throw rethrow;
    }
  };
  handlers.set(ASSESS_UNKNOWN_JOB, { handler: assessUnknown, timeoutMs: UNKNOWN_TIMEOUT_MS });
}
