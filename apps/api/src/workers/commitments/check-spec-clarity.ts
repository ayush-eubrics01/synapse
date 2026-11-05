import { type Job, JobError, specClarityOutputSchema } from "@synapse/contracts";
import { schema } from "@synapse/database";
import { newId } from "@synapse/shared";
import { and, desc, eq, gt, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { JobContext } from "../../core/jobs/worker";
import { parseStructured } from "../../core/orchestrator/structured";
import {
  buildClarityRequest,
  MAX_SPEC_CONTEXT,
} from "../../intelligence/commitments/clarity-prompt";
import { conversationLabel, type HistoryItem } from "../../intelligence/people/history";
import { SPEC_JOB } from "../../modules/commitments/extraction-queue";
import { followupThreadTs } from "../../modules/commitments/thread";
import { renderExcerpt } from "../../modules/security-flags/detector";
import { flaggedMessageOf, flagTargetOf, safely, wrapFailure } from "../intelligence-shared";
import type { CommitmentContext } from "./context";
import type { CommitmentJobDeps } from "./shared";
import { DRAFT_MAX_CHARS, SPEC_LEAD, SPEC_TIMEOUT_MS } from "./shared";

const {
  slackMessages,
  slackUsers,
  slackConversations,
  jobs,
  commitments,
  followups,
  followupHistory,
} = schema;

export function registerSpecClarity(deps: CommitmentJobDeps, c: CommitmentContext): void {
  const { db, settings, queue, orchestrator, securityFlags } = deps;
  const { latestRunId, runIdBefore, runtimeFlags, failedRunFlags } = c;

  const checkSpecClarity = async (job: Job, ctx: JobContext) => {
    const input = job.input as { messageId?: unknown } | null;
    const messageId = typeof input?.messageId === "string" ? input.messageId : null;
    if (!messageId) throw new JobError({ kind: "invalid_input", message: "messageId is required" });
    const selfId = settings.get("slack.selfUserId");
    if (!selfId) return { skipped: "no_identity" };

    const prepared = db.transaction((tx) => {
      const exists = tx
        .select({ id: followups.id })
        .from(followups)
        .where(and(eq(followups.originMessageId, messageId), eq(followups.origin, "spec_clarity")))
        .limit(1)
        .get();
      if (exists) return { skipped: "followup_exists" as const };
      const base = {
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
        expiredAt: slackMessages.contentExpiredAt,
      };
      const target = tx
        .select(base)
        .from(slackMessages)
        .innerJoin(slackConversations, eq(slackConversations.id, slackMessages.conversationId))
        .innerJoin(slackUsers, eq(slackUsers.id, slackMessages.senderUserId))
        .where(eq(slackMessages.id, messageId))
        .get();
      if (!target || target.text === null || target.senderRef === selfId) {
        return { skipped: "ineligible" as const };
      }
      if (target.expiredAt !== null) return { skipped: "ineligible" as const };
      // Already handled: the user posted in the conversation (or thread) after the request.
      const answered = tx
        .select({ id: slackMessages.id })
        .from(slackMessages)
        .innerJoin(slackUsers, eq(slackUsers.id, slackMessages.senderUserId))
        .where(
          and(
            eq(slackMessages.conversationId, target.conversationId),
            eq(slackUsers.externalId, selfId),
            gt(slackMessages.sentAt, target.sentAt),
            target.threadTs
              ? or(
                  eq(slackMessages.threadTs, target.threadTs),
                  eq(slackMessages.ts, target.threadTs),
                )
              : undefined,
          ),
        )
        .limit(1)
        .get();
      if (answered) return { skipped: "answered" as const };

      // Earlier messages only: same instant means an earlier row.
      const before = or(
        lt(slackMessages.sentAt, target.sentAt),
        and(
          eq(slackMessages.sentAt, target.sentAt),
          sql`${slackMessages}.rowid < (SELECT rowid FROM slack_messages WHERE id = ${messageId})`,
        ),
      );
      const root = target.threadTs;
      const scope = root
        ? or(eq(slackMessages.threadTs, root), eq(slackMessages.ts, root))
        : undefined;
      const earlier = tx
        .select(base)
        .from(slackMessages)
        .innerJoin(slackConversations, eq(slackConversations.id, slackMessages.conversationId))
        .innerJoin(slackUsers, eq(slackUsers.id, slackMessages.senderUserId))
        .where(
          and(
            eq(slackMessages.conversationId, target.conversationId),
            ne(slackMessages.id, messageId),
            isNotNull(slackMessages.text),
            isNull(slackMessages.contentExpiredAt),
            before,
            scope,
          ),
        )
        .orderBy(desc(slackMessages.sentAt), sql`${slackMessages}.rowid desc`)
        .limit(MAX_SPEC_CONTEXT)
        .all()
        .reverse();
      const asItem = (m: typeof target): HistoryItem => ({
        messageId: m.id,
        sentAt: m.sentAt,
        author:
          m.senderRef === selfId ? "self" : m.senderRef === target.senderRef ? "them" : "other",
        authorRef: m.senderRef,
        conversationLabel: conversationLabel(m.type, m.name, m.convRef),
        text: m.text as string,
        sourceRef: `${m.convRef}:${m.ts}`,
      });
      return {
        conversationId: target.conversationId,
        // R11: top-level in a DM unless the request was itself a thread reply; else under the request.
        threadTs: followupThreadTs(target.type, target.threadTs, target.ts),
        sender: target.senderRef,
        items: [...earlier, target].map(asItem),
      };
    });
    if ("skipped" in prepared) return { skipped: prepared.skipped };

    // R5: runtime signals attach to a message of someone else, never to the user's own.
    const target = flagTargetOf(prepared.items);
    const targets = target ? [target] : [];
    const before = runIdBefore(job.id);
    let ran = false;
    try {
      const { request, used } = buildClarityRequest(
        prepared.items,
        job.id,
        settings.get("commitments.models.extract"),
      );
      const result = await orchestrator.run(request, ctx.signal);
      ran = true;
      runtimeFlags(job.id, targets, result);
      const parsed = parseStructured(result.finalText, specClarityOutputSchema);
      if (!parsed.ok) throw new JobError({ kind: "incomplete_ai_output", message: parsed.reason });
      const { value } = parsed;
      const questions = value.questions.map((q) => renderExcerpt(q, 300).trim()).filter(Boolean);
      const runId = latestRunId(job.id);
      const flagged = flaggedMessageOf(used, value.suspectedInjection, target);
      return db.transaction(
        (tx) => {
          if (value.suspectedInjection.detected && flagged) {
            securityFlags.recordAiFlag(tx, flagged, runId, value.suspectedInjection);
          }
          if (value.clear || questions.length === 0) return { clear: true };
          const raced = tx
            .select({ id: followups.id })
            .from(followups)
            .where(
              and(eq(followups.originMessageId, messageId), eq(followups.origin, "spec_clarity")),
            )
            .limit(1)
            .get();
          if (raced) return { skipped: "raced" };
          const now = deps.clock.now().toISOString();
          const followupId = newId();
          const draft = [...`${SPEC_LEAD}\n${questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}`]
            .slice(0, DRAFT_MAX_CHARS)
            .join("");
          tx.insert(followups)
            .values({
              id: followupId,
              commitmentId: null,
              origin: "spec_clarity",
              originMessageId: messageId,
              conversationId: prepared.conversationId,
              threadTs: prepared.threadTs,
              recipientSlackUserId: prepared.sender,
              draftText: draft,
              confidence: null,
              status: "draft",
              claudeRunId: runId,
              createdAt: now,
              updatedAt: now,
            })
            .run();
          // Content-free enums only.
          tx.insert(followupHistory)
            .values({
              id: newId(),
              followupId,
              event: "clarity_missing",
              detail: value.missing.join(","),
              createdAt: now,
            })
            .run();
          deps.events.publish(tx, {
            type: "followup.draft_created",
            aggregateType: "followup",
            aggregateId: followupId,
            correlationId: newId(),
            payload: { followupId },
          });
          return { drafted: true, questions: questions.length };
        },
        { behavior: "immediate" },
      );
    } catch (err) {
      const { classified, rethrow } = wrapFailure(err);
      if (!ran) safely(() => failedRunFlags(job.id, targets, classified, before));
      throw rethrow;
    }
  };

  deps.handlers.set(SPEC_JOB, { handler: checkSpecClarity, timeoutMs: SPEC_TIMEOUT_MS });
}
