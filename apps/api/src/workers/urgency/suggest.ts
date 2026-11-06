import { type Job, JobError, suggestedResponseSchema } from "@synapse/contracts";
import { type Db, schema, type Tx } from "@synapse/database";
import { newId } from "@synapse/shared";
import { and, desc, eq, isNotNull, lt, or } from "drizzle-orm";
import type { JobContext } from "../../core/jobs/worker";
import { parseStructured } from "../../core/orchestrator/structured";
import {
  buildSuggestRequest,
  MAX_CONTEXT_MESSAGES,
  type SuggestContextItem,
} from "../../intelligence/urgency/suggest-prompt";
import { renderExcerpt } from "../../modules/security-flags/detector";
import { safely, wrapFailure } from "../intelligence-shared";
import type { UrgencyContext } from "./context";
import {
  conversationLabel,
  DRAFT_MAX_CHARS,
  SUGGEST_TIMEOUT_MS,
  type UrgencyJobDeps,
} from "./shared";

const { slackMessages, slackConversations, slackUsers, messageDrafts } = schema;

export function registerSuggest(deps: UrgencyJobDeps, c: UrgencyContext): void {
  const { db, settings, orchestrator, securityFlags } = deps;
  const { latestRunId, runIdBefore, runtimeFlags, failedRunFlags } = c;

  /** `urgency.suggest_response`: a display-only draft; nothing is ever sent. */
  const suggest = async (job: Job, ctx: JobContext) => {
    const messageId = (job.input as { messageId?: string } | null)?.messageId;
    if (!messageId) throw new JobError({ kind: "invalid_input", message: "messageId is required" });

    const target = db
      .select({
        id: slackMessages.id,
        conversationId: slackMessages.conversationId,
        ts: slackMessages.ts,
        threadTs: slackMessages.threadTs,
        text: slackMessages.text,
        sentAt: slackMessages.sentAt,
        level: slackMessages.urgencyLevel,
        convType: slackConversations.type,
        convName: slackConversations.name,
        convRef: slackConversations.externalId,
        senderName: slackUsers.name,
        senderRef: slackUsers.externalId,
      })
      .from(slackMessages)
      .innerJoin(slackConversations, eq(slackConversations.id, slackMessages.conversationId))
      .innerJoin(slackUsers, eq(slackUsers.id, slackMessages.senderUserId))
      .where(eq(slackMessages.id, messageId))
      .get();
    if (!target || target.text === null) return { skipped: "expired_or_missing" };
    if (target.level !== "critical" && target.level !== "high") return { skipped: "not_urgent" };
    const draftExists = (d: Db | Tx) =>
      d
        .select({ id: messageDrafts.id })
        .from(messageDrafts)
        .where(
          and(eq(messageDrafts.messageId, messageId), eq(messageDrafts.kind, "suggested_response")),
        )
        .get() !== undefined;
    if (draftExists(db)) return { skipped: "draft_exists" };

    const sameThread = target.threadTs
      ? or(eq(slackMessages.threadTs, target.threadTs), eq(slackMessages.ts, target.threadTs))
      : undefined;
    const context: SuggestContextItem[] = db
      .select({
        senderName: slackUsers.name,
        senderRef: slackUsers.externalId,
        text: slackMessages.text,
        sentAt: slackMessages.sentAt,
      })
      .from(slackMessages)
      .innerJoin(slackUsers, eq(slackUsers.id, slackMessages.senderUserId))
      .where(
        and(
          eq(slackMessages.conversationId, target.conversationId),
          lt(slackMessages.ts, target.ts),
          isNotNull(slackMessages.text),
          sameThread,
        ),
      )
      .orderBy(desc(slackMessages.ts))
      .limit(MAX_CONTEXT_MESSAGES)
      .all()
      .reverse()
      .map((r) => ({
        senderName: r.senderName ?? r.senderRef,
        text: r.text as string,
        sentAt: r.sentAt,
      }));

    const before = runIdBefore(job.id);
    let ran = false;
    try {
      const req = buildSuggestRequest(
        {
          messageId,
          senderName: target.senderName ?? target.senderRef,
          conversationLabel: conversationLabel(target.convType, target.convName, target.convRef),
          sentAt: target.sentAt,
          text: target.text,
        },
        context,
        job.id,
        settings.get("urgency.suggest.model"),
        deps.guidelinesFor?.(target.senderRef) ?? null,
      );
      const result = await orchestrator.run(req, ctx.signal);
      ran = true;
      runtimeFlags(job.id, [messageId], result);
      const parsed = parseStructured(result.finalText, suggestedResponseSchema);
      if (!parsed.ok) {
        throw new JobError({ kind: "incomplete_ai_output", message: parsed.reason });
      }
      const value = parsed.value;
      const draft = renderExcerpt(value.draft, DRAFT_MAX_CHARS);
      if (draft === "") {
        throw new JobError({
          kind: "incomplete_ai_output",
          message: "suggested response draft is empty",
        });
      }
      const runId = latestRunId(job.id);
      return db.transaction(
        (tx) => {
          const cur = tx
            .select({ text: slackMessages.text })
            .from(slackMessages)
            .where(eq(slackMessages.id, messageId))
            .get();
          if (!cur || cur.text === null || draftExists(tx)) return { skipped: "raced" };
          tx.insert(messageDrafts)
            .values({
              id: newId(),
              messageId,
              kind: "suggested_response",
              text: draft,
              confidence: value.confidence,
              status: "proposed",
              claudeRunId: runId,
              createdAt: deps.clock.now().toISOString(),
            })
            .run();
          if (value.suspectedInjection.detected) {
            securityFlags.recordAiFlag(tx, messageId, runId, value.suspectedInjection);
          }
          return { drafted: true };
        },
        { behavior: "immediate" },
      );
    } catch (err) {
      const { classified, rethrow } = wrapFailure(err);
      if (!ran) safely(() => failedRunFlags(job.id, [messageId], classified, before));
      throw rethrow;
    }
  };

  deps.handlers.set("urgency.suggest_response", {
    handler: suggest,
    timeoutMs: SUGGEST_TIMEOUT_MS,
  });
}
