import { followupDraftOutputSchema, type Job, JobError } from "@synapse/contracts";
import { schema, type Tx } from "@synapse/database";
import { newId } from "@synapse/shared";
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { JobContext } from "../../core/jobs/worker";
import { parseStructured } from "../../core/orchestrator/structured";
import { buildFollowupRequest } from "../../intelligence/commitments/followup-prompt";
import { conversationLabel, type HistoryItem } from "../../intelligence/people/history";
import { REVIEW_STATUS_FIELD } from "../../modules/commitments/lifecycle";
import { DRAFT_JOB } from "../../modules/commitments/stall";
import { followupThreadTs } from "../../modules/commitments/thread";
import { renderExcerpt } from "../../modules/security-flags/detector";
import { flaggedMessageOf, flagTargetOf, safely, wrapFailure } from "../intelligence-shared";
import type { CommitmentContext } from "./context";
import type { CommitmentJobDeps } from "./shared";
import { CONTEXT_POOL, DRAFT_MAX_CHARS, DRAFT_TIMEOUT_MS } from "./shared";

const {
  slackMessages,
  slackUsers,
  slackConversations,
  commitments,
  commitmentSources,
  commitmentUpdates,
  followups,
  followupHistory,
} = schema;

export function registerDraftFollowup(deps: CommitmentJobDeps, c: CommitmentContext): void {
  const { db, settings, orchestrator, securityFlags } = deps;
  const { latestRunId, runIdBefore, runtimeFlags, failedRunFlags } = c;

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
    const input = job.input as {
      commitmentId?: unknown;
      stalledAt?: unknown;
      manual?: unknown;
      origin?: unknown;
    } | null;
    const commitmentId = typeof input?.commitmentId === "string" ? input.commitmentId : null;
    if (!commitmentId) {
      throw new JobError({ kind: "invalid_input", message: "commitmentId is required" });
    }
    // A manual request (the user asked for it) skips the stall check only.
    const manual = input?.manual === true;
    const origin =
      manual && input?.origin === "manual" ? ("manual" as const) : ("stalled" as const);
    const selfId = settings.get("slack.selfUserId");
    if (!selfId) {
      // Clear the stall so the commitment can stall again (and be drafted) once identity is set.
      if (!manual)
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
        !manual &&
        (c.stalledAt === null ||
          (typeof input?.stalledAt === "string" && input.stalledAt !== c.stalledAt))
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
      const sourceConv = tx
        .select({ type: slackConversations.type })
        .from(slackConversations)
        .where(eq(slackConversations.id, conversationId))
        .get();
      // R17: a DM or group DM follow-up reaches that conversation's members, so the owner must be one
      // (an owner only mentioned there, e.g. "<@Y> will handle it" in a DM with X, is not).
      if (sourceConv && sourceConv.type !== "channel") {
        const ownerPosted = tx
          .select({ id: slackMessages.id })
          .from(slackMessages)
          .innerJoin(slackUsers, eq(slackUsers.id, slackMessages.senderUserId))
          .where(
            and(
              eq(slackMessages.conversationId, conversationId),
              eq(slackUsers.externalId, c.ownerSlackUserId),
            ),
          )
          .limit(1)
          .get();
        if (!ownerPosted) return { skipped: "owner_not_in_conversation" as const };
      }
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
      const threadTs =
        !newest || !sourceConv
          ? null
          : followupThreadTs(sourceConv.type, newest.threadTs, newest.ts as string);
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
          if (
            !c ||
            (!manual && c.stalledAt === null) ||
            isClosed(c) ||
            hasLiveFollowup(tx, commitmentId)
          ) {
            return { skipped: "raced" };
          }
          const now = deps.clock.now().toISOString();
          const followupId = newId();
          tx.insert(followups)
            .values({
              id: followupId,
              commitmentId,
              origin,
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
          history("draft_created", origin);
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

  deps.handlers.set(DRAFT_JOB, { handler: draftFollowup, timeoutMs: DRAFT_TIMEOUT_MS });
}
