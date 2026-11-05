import {
  type Confidence,
  initialProfileOutputSchema,
  type Job,
  JobError,
  type ProfileContent,
  profileContentSchema,
  profileUpdateOutputSchema,
  type SuspectedInjection,
  unknownAssessmentOutputSchema,
} from "@synapse/contracts";
import { type Db, schema } from "@synapse/database";
import { type Clock, isoNow } from "@synapse/shared";
import { and, asc, desc, eq, gte, isNull, max } from "drizzle-orm";
import { z } from "zod";
import type { SettingsService } from "../core/config/settings";
import type { JobQueue } from "../core/jobs/queue";
import type { HandlerRegistration, JobContext } from "../core/jobs/worker";
import type { ClaudeOrchestrator } from "../core/orchestrator/orchestrator";
import { parseStructured } from "../core/orchestrator/structured";
import type { SchedulerService } from "../core/scheduler/scheduler";
import {
  observationCount,
  observationHash,
  validateEvidence,
  validateUpdate,
} from "../intelligence/people/evidence";
import { selectHistory } from "../intelligence/people/history";
import { buildInitialRequest } from "../intelligence/people/initial-prompt";
import { buildUnknownRequest } from "../intelligence/people/unknown-prompt";
import { buildUpdateRequest } from "../intelligence/people/update-prompt";
import { applyDiff } from "../modules/people/profiles";
import {
  ASSESS_UNKNOWN_JOB,
  ASSESS_UNKNOWN_PRIORITY,
  INITIAL_PROFILE_JOB,
  PEOPLE_CONCURRENCY_GROUP,
  type ProfileRecommendations,
  UPDATE_PROFILE_JOB,
  UPDATE_PROFILE_PRIORITY,
  UPDATE_SCHEDULE_JOB,
} from "../modules/people/recommendations";
import type { TemporaryContacts } from "../modules/people/temporary";
import { renderExcerpt } from "../modules/security-flags/detector";
import type { SecurityFlagsService } from "../modules/security-flags/service";
import { createRunHelpers, safely, wrapFailure } from "./intelligence-shared";

export interface PeopleJobDeps {
  db: Db;
  clock: Clock;
  settings: SettingsService;
  scheduler: SchedulerService;
  queue: JobQueue;
  temporary: TemporaryContacts;
  recommendations: ProfileRecommendations;
  orchestrator: Pick<ClaudeOrchestrator, "run">;
  securityFlags: SecurityFlagsService;
  handlers: Map<string, HandlerRegistration>;
}

const EXPIRY_TIMEOUT_MS = 60_000;
const INITIAL_TIMEOUT_MS = 420_000;
const UPDATE_TIMEOUT_MS = 300_000;
const UNKNOWN_TIMEOUT_MS = 300_000;
const SECTION_NAMES = ["professionalContext", "communication", "responseGuidelines"] as const;
const UNKNOWN_BATCH = 10;
const UNKNOWN_MESSAGES = 5;
const HOUR_MS = 3_600_000;
const MIN_HISTORY_ITEMS = 3;

const inputSchema = z.object({ personId: z.string().min(1) });

/** People Memory jobs: temporary-contact expiry, initial profile, updates, unknown assessment. */
export function registerPeopleJobs(deps: PeopleJobDeps): void {
  const { db, clock, settings, scheduler, temporary, recommendations, orchestrator, handlers } =
    deps;
  const { queue } = deps;
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
    // R1: runtime signals attach to one message, not to all 150 the run read.
    const newest = (items[items.length - 1] as (typeof items)[number]).messageId;

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
      const flagged = flaggedMessage(used, suspectedInjection, newest);

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
          return "skipped" in stored
            ? { skipped: stored.skipped }
            : { recommendationId: stored.recommendationId };
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

  // The newest evidence date of the current version (the version's own date when it has none):
  // history newer than this is "new".
  const baselineOf = (profile: { id: string; currentVersion: number; updatedAt: string }) => {
    const version = db
      .select({
        id: schema.peopleProfileVersions.id,
        createdAt: schema.peopleProfileVersions.createdAt,
      })
      .from(schema.peopleProfileVersions)
      .where(
        and(
          eq(schema.peopleProfileVersions.profileId, profile.id),
          eq(schema.peopleProfileVersions.version, profile.currentVersion),
        ),
      )
      .get();
    if (!version) return profile.updatedAt;
    const row = db
      .select({ newest: max(schema.peopleProfileEvidence.observedAt) })
      .from(schema.peopleProfileEvidence)
      .where(eq(schema.peopleProfileEvidence.versionId, version.id))
      .get();
    return row?.newest ?? version.createdAt;
  };
  const historyOpts = (after: string, maxMessages: number) => ({
    days: settings.get("people.history.days"),
    maxMessages,
    selfUserId: settings.get("slack.selfUserId"),
    now: clock.now(),
    after,
  });

  // Tick: one job per profiled person with history newer than their evidence and nothing pending.
  handlers.set(UPDATE_SCHEDULE_JOB, {
    handler: async () => {
      const profiled = db
        .select({
          personId: schema.people.id,
          slackUserId: schema.people.slackUserId,
          profile: schema.peopleProfiles,
        })
        .from(schema.peopleProfiles)
        .innerJoin(schema.people, eq(schema.people.id, schema.peopleProfiles.personId))
        .all();
      let enqueued = 0;
      for (const p of profiled) {
        if (recommendations.hasPending(db, p.personId)) continue;
        const [newest] = selectHistory(db, p.slackUserId, historyOpts(baselineOf(p.profile), 1));
        if (!newest) continue;
        const { created } = db.transaction(
          (tx) =>
            queue.enqueue(tx, {
              type: UPDATE_PROFILE_JOB,
              idempotencyKey: `people.update:${p.personId}:${newest.sentAt}`,
              input: { personId: p.personId },
              concurrencyGroup: PEOPLE_CONCURRENCY_GROUP,
              priority: UPDATE_PROFILE_PRIORITY,
            }),
          { behavior: "immediate" },
        );
        if (created) enqueued++;
      }
      return { enqueued };
    },
    timeoutMs: EXPIRY_TIMEOUT_MS,
  });
  scheduler.upsert({
    name: UPDATE_SCHEDULE_JOB,
    jobType: UPDATE_SCHEDULE_JOB,
    intervalSeconds: settings.get("people.update.intervalSeconds"),
    priority: UPDATE_PROFILE_PRIORITY,
    coalesce: true,
  });

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
    const newest = (items[items.length - 1] as (typeof items)[number]).messageId;

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
      runtimeFlags(job.id, [newest], result);
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
      const flagged = flaggedMessage(used, suspectedInjection, newest);
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
            if (suspectedInjection.detected) {
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
          if (suspectedInjection.detected) {
            deps.securityFlags.recordAiFlag(tx, flagged, runId, suspectedInjection);
          }
          if (empty) return { empty: true };
          const stored = recommendations.storeUpdate(tx, {
            personId,
            runId,
            baseVersion: profile.currentVersion,
            diff,
            resultContent,
            evidence: evidenceRows(added, byId),
          });
          return "skipped" in stored
            ? { skipped: stored.skipped }
            : { recommendationId: stored.recommendationId };
        },
        { behavior: "immediate" },
      );
    } catch (err) {
      const { classified, rethrow } = wrapFailure(err);
      if (!ran) safely(() => failedRunFlags(job.id, [newest], classified, before));
      throw rethrow;
    }
  };
  handlers.set(UPDATE_PROFILE_JOB, { handler: updateProfile, timeoutMs: UPDATE_TIMEOUT_MS });

  const assessUnknown = async (job: Job, ctx: JobContext) => {
    const nowIso = isoNow(clock);
    const candidates = db
      .select()
      .from(schema.temporaryContacts)
      .where(
        and(
          isNull(schema.temporaryContacts.assessedAt),
          gte(schema.temporaryContacts.messageCount, settings.get("people.unknown.minMessages")),
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
    // R1: runtime signals attach to one message: the newest of the first contact.
    const newest = (first.messages[first.messages.length - 1] as { id: string }).id;
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
      runtimeFlags(job.id, [newest], result);
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
      if (!ran) safely(() => failedRunFlags(job.id, [newest], classified, before));
      throw rethrow;
    }
  };
  handlers.set(ASSESS_UNKNOWN_JOB, { handler: assessUnknown, timeoutMs: UNKNOWN_TIMEOUT_MS });
}

/** R1: the provided message whose text holds the model's quote, else the newest provided one. */
function flaggedMessage(
  used: { messageId: string; text: string }[],
  s: SuspectedInjection,
  newest: string,
): string {
  const quote = s.quote.trim();
  return (quote !== "" && used.find((i) => i.text.includes(quote))?.messageId) || newest;
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
          observationKey: `${section}.${o.key}`,
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
