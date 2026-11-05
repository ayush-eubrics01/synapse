import {
  commitmentExtractionOutputSchema,
  followupDraftOutputSchema,
  type Job,
  JobError,
  retryDecision,
} from "@synapse/contracts";
import { type Db, schema, type Tx } from "@synapse/database";
import { type Clock, newId } from "@synapse/shared";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type { AuditLogger } from "../core/audit/audit";
import type { SettingsService } from "../core/config/settings";
import type { EventPublisher } from "../core/events/publisher";
import type { JobQueue } from "../core/jobs/queue";
import type { HandlerRegistration, JobContext } from "../core/jobs/worker";
import type { ClaudeOrchestrator } from "../core/orchestrator/orchestrator";
import { parseStructured } from "../core/orchestrator/structured";
import type { SchedulerService } from "../core/scheduler/scheduler";
import { buildExtractRequest } from "../intelligence/commitments/extract-prompt";
import { buildFollowupRequest } from "../intelligence/commitments/followup-prompt";
import { type BatchMessage, validateCandidates } from "../intelligence/commitments/validate";
import { conversationLabel, type HistoryItem } from "../intelligence/people/history";
import { EXTRACT_JOB, EXTRACT_PRIORITY } from "../modules/commitments/extraction-queue";
import { REVIEW_STATUS_FIELD } from "../modules/commitments/lifecycle";
import {
  DRAFT_JOB,
  REMINDERS_JOB,
  STALL_JOB,
  type StallService,
} from "../modules/commitments/stall";
import { COMMITMENTS_CONCURRENCY_GROUP, type CommitmentStore } from "../modules/commitments/store";
import { interactsWithUser } from "../modules/people/interaction";
import { renderExcerpt } from "../modules/security-flags/detector";
import type { SecurityFlagsService } from "../modules/security-flags/service";
import {
  createRunHelpers,
  flaggedMessageOf,
  flagTargetOf,
  safely,
  wrapFailure,
} from "./intelligence-shared";

const {
  slackMessages,
  slackUsers,
  slackConversations,
  jobs,
  commitments,
  commitmentSources,
  commitmentUpdates,
  followups,
  followupHistory,
} = schema;
const SWEEP_JOB = "commitments.extract_sweep";

export interface CommitmentJobDeps {
  db: Db;
  clock: Clock;
  settings: SettingsService;
  scheduler: SchedulerService;
  audit: AuditLogger;
  queue: JobQueue;
  orchestrator: Pick<ClaudeOrchestrator, "run">;
  securityFlags: SecurityFlagsService;
  store: CommitmentStore;
  events: EventPublisher;
  stall: StallService;
  /** Approved response guidelines of the person with this Slack user id (drafting runs only, H1). */
  guidelinesFor?: (slackUserId: string) => { name: string; texts: string[] } | null;
  handlers: Map<string, HandlerRegistration>;
}

const EXTRACT_TIMEOUT_MS = 420_000;
const DRAFT_TIMEOUT_MS = 420_000;
const DRAFT_MAX_CHARS = 4000;
const CONTEXT_POOL = 200;
const DAY_MS = 86_400_000;
const PAGE = 200;

interface Row {
  id: string;
  text: string;
  sentAt: string;
  ts: string;
  threadTs: string | null;
  conversationId: string;
  type: "im" | "mpim" | "channel";
  name: string | null;
  convRef: string;
  senderRef: string;
}

export function registerCommitmentJobs(deps: CommitmentJobDeps): void {
  const { db, settings, queue, orchestrator, securityFlags, store, scheduler, audit } = deps;
  const { latestRunId, runIdBefore, runtimeFlags, failedRunFlags } = createRunHelpers(
    db,
    securityFlags,
  );

  /**
   * Unextracted, unexpired messages from the last `people.history.days` in conversations involving
   * the user (their own messages included), oldest first. Read in pages so non-interacting rows
   * never fill the batch.
   */
  const eligible = (tx: Tx, selfId: string, limit: number): Row[] => {
    const since = new Date(
      deps.clock.now().getTime() - settings.get("people.history.days") * DAY_MS,
    ).toISOString();
    const out: Row[] = [];
    for (let offset = 0; out.length < limit; offset += PAGE) {
      const rows = tx
        .select({
          id: slackMessages.id,
          text: slackMessages.text,
          sentAt: slackMessages.sentAt,
          ts: slackMessages.ts,
          threadTs: slackMessages.threadTs,
          conversationId: slackMessages.conversationId,
          type: slackConversations.type,
          name: slackConversations.name,
          convRef: slackConversations.externalId,
          senderRef: slackUsers.externalId,
        })
        .from(slackMessages)
        .innerJoin(slackConversations, eq(slackConversations.id, slackMessages.conversationId))
        .innerJoin(slackUsers, eq(slackUsers.id, slackMessages.senderUserId))
        .where(
          and(
            isNull(slackMessages.commitmentsExtractedAt),
            isNotNull(slackMessages.text),
            isNull(slackMessages.contentExpiredAt),
            gte(slackMessages.sentAt, since),
          ),
        )
        .orderBy(asc(slackMessages.sentAt), sql`${slackMessages}.rowid`)
        .limit(PAGE)
        .offset(offset)
        .all() as Row[];
      for (const r of rows) {
        const interacts =
          r.senderRef === selfId ||
          interactsWithUser(
            tx,
            {
              conversationId: r.conversationId,
              conversationType: r.type,
              ts: r.ts,
              threadTs: r.threadTs,
              text: r.text,
            },
            selfId,
          );
        if (interacts) out.push(r);
        if (out.length >= limit) break;
      }
      if (rows.length < PAGE) break;
    }
    return out;
  };

  const enqueueNext = (tx: Tx, jobId: string, selfId: string) => {
    if (eligible(tx, selfId, 1).length === 0) return;
    queue.enqueue(tx, {
      type: EXTRACT_JOB,
      idempotencyKey: `${EXTRACT_JOB}:${jobId}:next`,
      concurrencyGroup: COMMITMENTS_CONCURRENCY_GROUP,
      priority: EXTRACT_PRIORITY,
    });
  };

  /** R9: a failed or lost batch must not wait for the next qualifying message. */
  const sweep = async () => {
    const selfId = settings.get("slack.selfUserId");
    if (!selfId) return { skipped: "no_identity" };
    return db.transaction(
      (tx) => {
        const active = tx
          .select({ id: jobs.id })
          .from(jobs)
          .where(
            and(eq(jobs.type, EXTRACT_JOB), inArray(jobs.status, ["PENDING", "RETRY", "RUNNING"])),
          )
          .limit(1)
          .get();
        if (active || eligible(tx, selfId, 1).length === 0) return { queued: false };
        queue.enqueue(tx, {
          type: EXTRACT_JOB,
          idempotencyKey: `${EXTRACT_JOB}:sweep:${deps.clock.now().toISOString().slice(0, 13)}`,
          concurrencyGroup: COMMITMENTS_CONCURRENCY_GROUP,
          priority: EXTRACT_PRIORITY,
        });
        return { queued: true };
      },
      { behavior: "immediate" },
    );
  };

  /** R10 a: a batch that can never succeed is marked done (audited, counts only). */
  const skipBatch = (ids: string[], jobId: string) => {
    if (ids.length === 0) return;
    const runId = runIdBefore(jobId);
    db.transaction(
      (tx) => {
        tx.update(slackMessages)
          .set({ commitmentsExtractedAt: deps.clock.now().toISOString() })
          .where(and(inArray(slackMessages.id, ids), isNull(slackMessages.commitmentsExtractedAt)))
          .run();
        audit.record(tx, {
          actor: "system",
          module: "commitments",
          action: "commitments.batch_skipped",
          result: "skipped",
          details: { count: ids.length, runId },
        });
        enqueueNext(tx, jobId, settings.get("slack.selfUserId") ?? "");
      },
      { behavior: "immediate" },
    );
  };

  const extract = async (job: Job, ctx: JobContext) => {
    const selfId = settings.get("slack.selfUserId");
    if (!selfId) return { skipped: "no_identity" };
    const rows = db.transaction((tx) =>
      eligible(tx, selfId, settings.get("commitments.extract.batchMax")),
    );
    if (rows.length === 0) return { extracted: 0 };

    const items: HistoryItem[] = rows.map((r) => ({
      messageId: r.id,
      sentAt: r.sentAt,
      author: r.senderRef === selfId ? "self" : "them",
      authorRef: r.senderRef,
      conversationLabel: conversationLabel(r.type, r.name, r.convRef),
      text: r.text,
      sourceRef: `${r.convRef}:${r.ts}`,
    }));
    // R5: runtime signals attach to a message of someone else, never to the user's own.
    const target = flagTargetOf(items);
    const targets = target ? [target] : [];

    const before = runIdBefore(job.id);
    let ran = false;
    let sentIds = rows.map((r) => r.id);
    try {
      const { request, used } = buildExtractRequest(
        items,
        job.id,
        settings.get("commitments.models.extract"),
      );
      sentIds = used.map((i) => i.messageId);
      const rowById = new Map(rows.map((r) => [r.id, r]));
      const partners = new Map<string, string | null>();
      const partnerOf = (r: Row) => {
        if (r.type !== "im") return null;
        if (!partners.has(r.conversationId)) {
          const p = db
            .select({ ref: slackUsers.externalId })
            .from(slackMessages)
            .innerJoin(slackUsers, eq(slackUsers.id, slackMessages.senderUserId))
            .where(
              and(
                eq(slackMessages.conversationId, r.conversationId),
                ne(slackUsers.externalId, selfId),
              ),
            )
            .limit(1)
            .get();
          partners.set(r.conversationId, p?.ref ?? null);
        }
        return partners.get(r.conversationId) ?? null;
      };
      // Only what was really sent can be cited.
      const batch: BatchMessage[] = used.map((i) => ({
        messageId: i.messageId,
        authorRef: i.authorRef as string,
        sentAt: i.sentAt,
        text: i.text,
        conversationId: (rowById.get(i.messageId) as Row).conversationId,
        sourceRef: i.sourceRef,
        dmPartner: partnerOf(rowById.get(i.messageId) as Row),
      }));
      const batchById = new Map(batch.map((b) => [b.messageId, b]));
      const result = await orchestrator.run(request, ctx.signal);
      ran = true;
      runtimeFlags(job.id, targets, result);
      const parsed = parseStructured(result.finalText, commitmentExtractionOutputSchema);
      if (!parsed.ok) throw new JobError({ kind: "incomplete_ai_output", message: parsed.reason });
      const { candidates, suspectedInjection } = parsed.value;
      const { valid, dropped } = validateCandidates(candidates, batch, selfId);
      const runId = latestRunId(job.id);
      const flagged = flaggedMessageOf(used, suspectedInjection, target);

      const counts = { created: 0, source_added: 0, unchanged: 0, proposed: 0, no_match: 0 };
      db.transaction(
        (tx) => {
          if (suspectedInjection.detected && flagged) {
            securityFlags.recordAiFlag(tx, flagged, runId, suspectedInjection);
          }
          for (const c of valid) {
            const outcome = store.record(tx, {
              candidate: c,
              sources: c.evidence.map((id) => {
                const b = batchById.get(id) as BatchMessage;
                return { messageId: id, sourceRef: b.sourceRef, conversationId: b.conversationId };
              }),
              selfUserId: selfId,
              runId,
              correlationId: newId(),
            });
            counts[outcome]++;
          }
          // Every message that was sent is done, including those that produced no candidate.
          tx.update(slackMessages)
            .set({ commitmentsExtractedAt: deps.clock.now().toISOString() })
            .where(
              and(
                inArray(
                  slackMessages.id,
                  batch.map((b) => b.messageId),
                ),
                isNull(slackMessages.commitmentsExtractedAt),
              ),
            )
            .run();
          enqueueNext(tx, job.id, selfId);
        },
        { behavior: "immediate" },
      );
      // Counts only.
      return { messages: batch.length, candidates: candidates.length, dropped, ...counts };
    } catch (err) {
      const { classified, rethrow } = wrapFailure(err);
      if (!ran) safely(() => failedRunFlags(job.id, targets, classified, before));
      const decision = retryDecision(classified.kind);
      if (
        decision === "needs_attention" ||
        decision === "fail" ||
        job.attempts >= job.maxAttempts
      ) {
        safely(() => skipBatch(sentIds, job.id));
      }
      throw rethrow;
    }
  };

  const hasLiveFollowup = (tx: Tx, commitmentId: string) =>
    tx
      .select({ id: followups.id })
      .from(followups)
      .where(
        and(
          eq(followups.commitmentId, commitmentId),
          inArray(followups.status, ["draft", "awaiting_approval"]),
        ),
      )
      .limit(1)
      .get() !== undefined;

  const isClosed = (c: { closedAt: string | null; status: string }) =>
    c.closedAt !== null || c.status === "completed" || c.status === "cancelled";

  const draftFollowup = async (job: Job, ctx: JobContext) => {
    const input = job.input as { commitmentId?: unknown; stalledAt?: unknown } | null;
    const commitmentId = typeof input?.commitmentId === "string" ? input.commitmentId : null;
    if (!commitmentId) {
      throw new JobError({ kind: "invalid_input", message: "commitmentId is required" });
    }
    const selfId = settings.get("slack.selfUserId");
    if (!selfId) {
      // Clear the stall so the commitment can stall again (and be drafted) once identity is set.
      db.update(commitments)
        .set({ stalledAt: null, updatedAt: deps.clock.now().toISOString() })
        .where(eq(commitments.id, commitmentId))
        .run();
      return { skipped: "no_identity" };
    }

    const prepared = db.transaction((tx) => {
      const c = tx.select().from(commitments).where(eq(commitments.id, commitmentId)).get();
      if (!c) return { skipped: "closed" as const };
      if (c.reviewStatus !== "accepted" || isClosed(c)) return { skipped: "closed" as const };
      if (
        c.stalledAt === null ||
        (typeof input?.stalledAt === "string" && input.stalledAt !== c.stalledAt)
      ) {
        return { skipped: "not_stalled" as const };
      }
      if (hasLiveFollowup(tx, commitmentId)) return { skipped: "followup_exists" as const };
      const sources = tx
        .select({
          conversationId: commitmentSources.conversationId,
          createdAt: commitmentSources.createdAt,
          messageId: commitmentSources.messageId,
          ts: slackMessages.ts,
          threadTs: slackMessages.threadTs,
          text: slackMessages.text,
          expiredAt: slackMessages.contentExpiredAt,
          sentAt: slackMessages.sentAt,
        })
        .from(commitmentSources)
        .leftJoin(slackMessages, eq(slackMessages.id, commitmentSources.messageId))
        .where(eq(commitmentSources.commitmentId, commitmentId))
        .all();
      // The newest source whose text is still available; an expired one is never a thread target.
      const newest = sources
        .filter((s) => s.messageId !== null && s.text !== null && s.expiredAt === null)
        .sort((a, b) => (b.sentAt ?? "").localeCompare(a.sentAt ?? ""))[0];
      const fallback = [...sources].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      const conversationId = newest?.conversationId ?? fallback?.conversationId ?? null;
      if (conversationId === null) return { skipped: "no_source" as const };
      const sourceConv = newest
        ? tx
            .select({ type: slackConversations.type })
            .from(slackConversations)
            .where(eq(slackConversations.id, newest.conversationId))
            .get()
        : undefined;
      const approved =
        tx
          .select({ id: commitmentUpdates.id })
          .from(commitmentUpdates)
          .where(
            and(
              eq(commitmentUpdates.commitmentId, commitmentId),
              eq(commitmentUpdates.actor, "user"),
              eq(commitmentUpdates.field, REVIEW_STATUS_FIELD),
              eq(commitmentUpdates.toValue, "accepted"),
            ),
          )
          .limit(1)
          .get() !== undefined;
      // R11: a DM nudge is top-level unless the source was itself in a thread.
      const threadTs = !newest
        ? null
        : sourceConv?.type === "im"
          ? newest.threadTs
          : (newest.threadTs ?? newest.ts);
      const convIds = [...new Set(sources.map((s) => s.conversationId))];
      const threads = new Set(
        sources.flatMap((s) => [s.threadTs, s.ts].filter((t): t is string => t != null)),
      );
      const pool = tx
        .select({
          id: slackMessages.id,
          text: slackMessages.text,
          sentAt: slackMessages.sentAt,
          ts: slackMessages.ts,
          threadTs: slackMessages.threadTs,
          type: slackConversations.type,
          name: slackConversations.name,
          convRef: slackConversations.externalId,
          senderRef: slackUsers.externalId,
        })
        .from(slackMessages)
        .innerJoin(slackConversations, eq(slackConversations.id, slackMessages.conversationId))
        .innerJoin(slackUsers, eq(slackUsers.id, slackMessages.senderUserId))
        .where(
          and(
            inArray(slackMessages.conversationId, convIds),
            isNotNull(slackMessages.text),
            isNull(slackMessages.contentExpiredAt),
          ),
        )
        .orderBy(desc(slackMessages.sentAt), sql`${slackMessages}.rowid desc`)
        .limit(CONTEXT_POOL)
        .all();
      const inThread = (m: (typeof pool)[number]) =>
        threads.has(m.threadTs ?? "") || threads.has(m.ts);
      // Newest non-expired messages, source threads first; presented oldest first.
      const picked = [...pool.filter(inThread), ...pool.filter((m) => !inThread(m))]
        .slice(0, 10)
        .reverse();
      return {
        description: c.description,
        owner: c.ownerSlackUserId,
        conversationId,
        threadTs,
        approved,
        noThread: !newest,
        context: picked.map(
          (m): HistoryItem => ({
            messageId: m.id,
            sentAt: m.sentAt,
            author:
              m.senderRef === selfId
                ? "self"
                : m.senderRef === c.ownerSlackUserId
                  ? "them"
                  : "other",
            authorRef: m.senderRef,
            conversationLabel: conversationLabel(m.type, m.name, m.convRef),
            text: m.text as string,
            sourceRef: `${m.convRef}:${m.ts}`,
          }),
        ),
      };
    });
    if ("skipped" in prepared) return { skipped: prepared.skipped };

    // R5: runtime signals attach to a message of someone else, never to the user's own.
    const target = flagTargetOf(prepared.context);
    const targets = target ? [target] : [];
    const before = runIdBefore(job.id);
    let ran = false;
    try {
      const { request, used } = buildFollowupRequest(
        {
          description: prepared.description,
          descriptionApproved: prepared.approved,
          guidelines: deps.guidelinesFor?.(prepared.owner) ?? null,
          context: prepared.context,
        },
        job.id,
        settings.get("commitments.models.draft"),
      );
      const result = await orchestrator.run(request, ctx.signal);
      ran = true;
      runtimeFlags(job.id, targets, result);
      const parsed = parseStructured(result.finalText, followupDraftOutputSchema);
      if (!parsed.ok) throw new JobError({ kind: "incomplete_ai_output", message: parsed.reason });
      const { value } = parsed;
      const draft = renderExcerpt(value.draft, DRAFT_MAX_CHARS);
      if (draft === "") {
        throw new JobError({ kind: "incomplete_ai_output", message: "follow-up draft is empty" });
      }
      const runId = latestRunId(job.id);
      const flagged = flaggedMessageOf(used, value.suspectedInjection, target);
      return db.transaction(
        (tx) => {
          const c = tx.select().from(commitments).where(eq(commitments.id, commitmentId)).get();
          if (!c || c.stalledAt === null || isClosed(c) || hasLiveFollowup(tx, commitmentId)) {
            return { skipped: "raced" };
          }
          const now = deps.clock.now().toISOString();
          const followupId = newId();
          tx.insert(followups)
            .values({
              id: followupId,
              commitmentId,
              origin: "stalled",
              conversationId: prepared.conversationId,
              threadTs: prepared.threadTs,
              recipientSlackUserId: prepared.owner,
              draftText: draft,
              confidence: value.confidence,
              status: "draft",
              claudeRunId: runId,
              createdAt: now,
              updatedAt: now,
            })
            .run();
          const history = (event: string, detail: string) =>
            tx
              .insert(followupHistory)
              .values({ id: newId(), followupId, event, detail, createdAt: now })
              .run();
          history("draft_created", "stalled");
          if (prepared.noThread) history("noThread", "no_thread");
          if (value.suspectedInjection.detected && flagged) {
            securityFlags.recordAiFlag(tx, flagged, runId, value.suspectedInjection);
          }
          deps.events.publish(tx, {
            type: "followup.draft_created",
            aggregateType: "followup",
            aggregateId: followupId,
            correlationId: newId(),
            payload: { followupId },
          });
          return { drafted: true, noThread: prepared.noThread };
        },
        { behavior: "immediate" },
      );
    } catch (err) {
      const { classified, rethrow } = wrapFailure(err);
      if (!ran) safely(() => failedRunFlags(job.id, targets, classified, before));
      throw rethrow;
    }
  };

  deps.handlers.set(STALL_JOB, {
    handler: async () => deps.stall.checkStalled(),
    timeoutMs: 60_000,
  });
  scheduler.upsert({ name: STALL_JOB, jobType: STALL_JOB, intervalSeconds: 3_600, coalesce: true });
  deps.handlers.set(REMINDERS_JOB, {
    handler: async () => deps.stall.sendReminders(),
    timeoutMs: 60_000,
  });
  scheduler.upsert({
    name: REMINDERS_JOB,
    jobType: REMINDERS_JOB,
    intervalSeconds: 900,
    coalesce: true,
  });
  deps.handlers.set(DRAFT_JOB, { handler: draftFollowup, timeoutMs: DRAFT_TIMEOUT_MS });
  deps.handlers.set(SWEEP_JOB, { handler: sweep, timeoutMs: 60_000 });
  scheduler.upsert({ name: SWEEP_JOB, jobType: SWEEP_JOB, intervalSeconds: 3_600, coalesce: true });
  deps.handlers.set(EXTRACT_JOB, { handler: extract, timeoutMs: EXTRACT_TIMEOUT_MS });
}
