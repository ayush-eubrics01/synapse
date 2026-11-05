import { commitmentExtractionOutputSchema, type Job, JobError } from "@synapse/contracts";
import { type Db, schema, type Tx } from "@synapse/database";
import { type Clock, newId } from "@synapse/shared";
import { and, asc, eq, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { SettingsService } from "../core/config/settings";
import type { JobQueue } from "../core/jobs/queue";
import type { HandlerRegistration, JobContext } from "../core/jobs/worker";
import type { ClaudeOrchestrator } from "../core/orchestrator/orchestrator";
import { parseStructured } from "../core/orchestrator/structured";
import { buildExtractRequest } from "../intelligence/commitments/extract-prompt";
import { type BatchMessage, validateCandidates } from "../intelligence/commitments/validate";
import { conversationLabel, type HistoryItem } from "../intelligence/people/history";
import { EXTRACT_JOB, EXTRACT_PRIORITY } from "../modules/commitments/extraction-queue";
import { COMMITMENTS_CONCURRENCY_GROUP, type CommitmentStore } from "../modules/commitments/store";
import { interactsWithUser } from "../modules/people/interaction";
import type { SecurityFlagsService } from "../modules/security-flags/service";
import {
  createRunHelpers,
  flaggedMessageOf,
  flagTargetOf,
  safely,
  wrapFailure,
} from "./intelligence-shared";

const { slackMessages, slackUsers, slackConversations } = schema;

export interface CommitmentJobDeps {
  db: Db;
  clock: Clock;
  settings: SettingsService;
  queue: JobQueue;
  orchestrator: Pick<ClaudeOrchestrator, "run">;
  securityFlags: SecurityFlagsService;
  store: CommitmentStore;
  handlers: Map<string, HandlerRegistration>;
}

const EXTRACT_TIMEOUT_MS = 420_000;
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
  const { db, settings, queue, orchestrator, securityFlags, store } = deps;
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
    try {
      const { request, used } = buildExtractRequest(
        items,
        job.id,
        settings.get("commitments.models.extract"),
      );
      const rowById = new Map(rows.map((r) => [r.id, r]));
      // Only what was really sent can be cited.
      const batch: BatchMessage[] = used.map((i) => ({
        messageId: i.messageId,
        authorRef: i.authorRef as string,
        sentAt: i.sentAt,
        text: i.text,
        conversationId: (rowById.get(i.messageId) as Row).conversationId,
        sourceRef: i.sourceRef,
      }));
      const batchById = new Map(batch.map((b) => [b.messageId, b]));
      const result = await orchestrator.run(request, ctx.signal);
      ran = true;
      runtimeFlags(job.id, targets, result);
      const parsed = parseStructured(result.finalText, commitmentExtractionOutputSchema);
      if (!parsed.ok) throw new JobError({ kind: "incomplete_ai_output", message: parsed.reason });
      const { candidates, suspectedInjection } = parsed.value;
      const { valid, dropped } = validateCandidates(candidates, batch);
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
      throw rethrow;
    }
  };

  deps.handlers.set(EXTRACT_JOB, { handler: extract, timeoutMs: EXTRACT_TIMEOUT_MS });
}
