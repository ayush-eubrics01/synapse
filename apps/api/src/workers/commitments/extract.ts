import {
  commitmentExtractionOutputSchema,
  type Job,
  JobError,
  retryDecision,
} from "@synapse/contracts";
import { schema, type Tx } from "@synapse/database";
import { newId } from "@synapse/shared";
import { and, asc, eq, gte, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type { JobContext } from "../../core/jobs/worker";
import { parseStructured } from "../../core/orchestrator/structured";
import { buildExtractRequest } from "../../intelligence/commitments/extract-prompt";
import { type BatchMessage, validateCandidates } from "../../intelligence/commitments/validate";
import { conversationLabel, type HistoryItem } from "../../intelligence/people/history";
import { EXTRACT_JOB, EXTRACT_PRIORITY } from "../../modules/commitments/extraction-queue";
import { COMMITMENTS_CONCURRENCY_GROUP } from "../../modules/commitments/store";
import { interactsWithUser } from "../../modules/people/interaction";
import { flaggedMessageOf, flagTargetOf, safely, wrapFailure } from "../intelligence-shared";
import type { CommitmentContext } from "./context";
import type { CommitmentJobDeps } from "./shared";
import { DAY_MS, EXTRACT_TIMEOUT_MS, PAGE, type Row, SWEEP_JOB } from "./shared";

const { slackMessages, slackUsers, slackConversations, jobs } = schema;

export function registerExtract(deps: CommitmentJobDeps, c: CommitmentContext): void {
  const { db, settings, queue, orchestrator, securityFlags, store, scheduler, audit } = deps;
  const { latestRunId, runIdBefore, runtimeFlags, failedRunFlags } = c;

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

  deps.handlers.set(SWEEP_JOB, { handler: sweep, timeoutMs: 60_000 });
  scheduler.upsert({ name: SWEEP_JOB, jobType: SWEEP_JOB, intervalSeconds: 3_600, coalesce: true });
  deps.handlers.set(EXTRACT_JOB, { handler: extract, timeoutMs: EXTRACT_TIMEOUT_MS });
}
