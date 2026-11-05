import {
  type Job,
  JobError,
  retryDecision,
  type ScreeningRecord,
  suggestedResponseSchema,
  type UrgencyLevel,
  urgencyAssessmentSchema,
} from "@synapse/contracts";
import { type Db, schema, type Tx } from "@synapse/database";
import { type Clock, newId } from "@synapse/shared";
import { and, asc, desc, eq, inArray, isNotNull, lt, ne, or, sql } from "drizzle-orm";
import type { SettingsService } from "../core/config/settings";
import type { EventPublisher } from "../core/events/publisher";
import type { JobQueue } from "../core/jobs/queue";
import type { HandlerRegistration, JobContext } from "../core/jobs/worker";
import type { NotificationService } from "../core/notifications/notifications";
import type { ClaudeOrchestrator } from "../core/orchestrator/orchestrator";
import { parseStructured } from "../core/orchestrator/structured";
import { type AssessBatchItem, buildAssessRequest } from "../intelligence/urgency/assess-prompt";
import {
  buildSuggestRequest,
  MAX_CONTEXT_MESSAGES,
  type SuggestContextItem,
} from "../intelligence/urgency/suggest-prompt";
import { renderExcerpt } from "../modules/security-flags/detector";
import type { SecurityFlagsService } from "../modules/security-flags/service";
import { createRunHelpers, wrapFailure } from "./urgency-shared";

const { slackMessages, slackConversations, slackUsers, messageDrafts, jobs } = schema;

export interface UrgencyJobDeps {
  db: Db;
  clock: Clock;
  settings: SettingsService;
  events: EventPublisher;
  queue: JobQueue;
  notifications: NotificationService;
  orchestrator: Pick<ClaudeOrchestrator, "run">;
  securityFlags: SecurityFlagsService;
  handlers: Map<string, HandlerRegistration>;
}

const ASSESS_TIMEOUT_MS = 360_000;
const SUGGEST_TIMEOUT_MS = 360_000;
const DRAFT_MAX_CHARS = 2000;
const FALLBACK_REASON = "Rule-based (assessment unavailable)";
const LEVEL_TITLE: Record<UrgencyLevel, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

interface BatchRow extends AssessBatchItem {
  conversationType: "im" | "mpim" | "channel";
}

const conversationLabel = (type: "im" | "mpim" | "channel", name: string | null, ref: string) =>
  type === "im" ? "a DM" : type === "mpim" ? "a group DM" : `#${name ?? ref}`;

/** Flag bookkeeping on a failure path must never replace the original error. */
const safely = (fn: () => void) => {
  try {
    fn();
  } catch {
    console.error("urgency: runtime flag recording failed");
  }
};

const isUrgent = (l: UrgencyLevel): l is "critical" | "high" => l === "critical" || l === "high";

export function registerUrgencyJobs(deps: UrgencyJobDeps): {
  recoverySweep: (tx: Tx) => void;
} {
  const { db, settings, events, queue, notifications, orchestrator, securityFlags } = deps;
  const { latestRunId, runIdBefore, runtimeFlags, failedRunFlags } = createRunHelpers(
    db,
    securityFlags,
  );

  const cutoffIso = () =>
    new Date(
      deps.clock.now().getTime() - settings.get("urgency.maxAgeHours") * 3_600_000,
    ).toISOString();

  const pendingAssess = sql`json_extract(${slackMessages.screening}, '$.route') = 'assess'
    and coalesce(json_extract(${slackMessages.screening}, '$.assessed'), 0) = 0
    and ${slackMessages.text} is not null`;

  /** R18 (2): still within `urgency.maxAgeHours` when the job runs (the sent_at index serves the range). */
  const eligibleWhere = () => sql`${slackMessages.sentAt} >= ${cutoffIso()} and ${pendingAssess}`;

  /**
   * R18 (2): a row that aged past `urgency.maxAgeHours` before its job ran (a long pause, a backlog)
   * becomes `skip`/`too_old`: never assessed, never notified, no Claude run.
   */
  const skipStale = (tx: Tx) => {
    const stale = tx
      .select({ id: slackMessages.id })
      .from(slackMessages)
      .where(sql`${slackMessages.sentAt} < ${cutoffIso()} and ${pendingAssess}`)
      .all();
    for (const r of stale) mergeScreening(tx, r.id, { route: "skip", skipReason: "too_old" });
  };

  const select = (limit: number): BatchRow[] =>
    db
      .select({
        id: slackMessages.id,
        text: slackMessages.text,
        sentAt: slackMessages.sentAt,
        screening: slackMessages.screening,
        convType: slackConversations.type,
        convName: slackConversations.name,
        convRef: slackConversations.externalId,
        senderName: slackUsers.name,
        senderRef: slackUsers.externalId,
      })
      .from(slackMessages)
      .innerJoin(slackConversations, eq(slackConversations.id, slackMessages.conversationId))
      .innerJoin(slackUsers, eq(slackUsers.id, slackMessages.senderUserId))
      .where(eligibleWhere())
      .orderBy(asc(slackMessages.sentAt), sql`${slackMessages}.rowid`)
      .limit(limit)
      .all()
      .map((r) => {
        const s = (r.screening ?? {}) as Partial<ScreeningRecord>;
        return {
          messageId: r.id,
          senderName: r.senderName ?? r.senderRef,
          conversationLabel: conversationLabel(r.convType, r.convName, r.convRef),
          conversationType: r.convType,
          sentAt: r.sentAt,
          text: r.text as string,
          ruleLevel: s.ruleLevel ?? "low",
          matchedRules: s.matchedRules ?? [],
        };
      });

  const hasMore = (tx: Tx): boolean =>
    tx.select({ id: slackMessages.id }).from(slackMessages).where(eligibleWhere()).limit(1).all()
      .length > 0;

  /** Merges into the stored screening JSON; every other field is preserved. */
  const mergeScreening = (tx: Tx, messageId: string, patch: Partial<ScreeningRecord>) => {
    const cur = tx
      .select({ screening: slackMessages.screening })
      .from(slackMessages)
      .where(eq(slackMessages.id, messageId))
      .get();
    tx.update(slackMessages)
      .set({ screening: { ...((cur?.screening ?? {}) as Record<string, unknown>), ...patch } })
      .where(eq(slackMessages.id, messageId))
      .run();
  };

  const screeningOf = (tx: Tx, messageId: string): Partial<ScreeningRecord> => {
    const row = tx
      .select({ screening: slackMessages.screening })
      .from(slackMessages)
      .where(eq(slackMessages.id, messageId))
      .get();
    return (row?.screening ?? {}) as Partial<ScreeningRecord>;
  };

  const alreadyNotified = (tx: Tx, messageId: string): boolean =>
    screeningOf(tx, messageId).notified === true;

  /**
   * R17: another message of the same thread root (conversation + (thread_ts ?? ts)) was notified
   * as urgent (critical/high, or unassessed after a deferral) and is still open.
   */
  const hasOpenUrgentAnchor = (tx: Tx, messageId: string): boolean => {
    const m = tx
      .select({
        conversationId: slackMessages.conversationId,
        ts: slackMessages.ts,
        threadTs: slackMessages.threadTs,
      })
      .from(slackMessages)
      .where(eq(slackMessages.id, messageId))
      .get();
    if (!m) return false;
    const root = m.threadTs ?? m.ts;
    const hit = tx
      .select({ id: slackMessages.id })
      .from(slackMessages)
      .where(
        and(
          eq(slackMessages.conversationId, m.conversationId),
          or(eq(slackMessages.threadTs, root), eq(slackMessages.ts, root)),
          ne(slackMessages.id, messageId),
          sql`json_extract(${slackMessages.screening}, '$.notified') = 1`,
          sql`(${slackMessages.urgencyLevel} is null or ${slackMessages.urgencyLevel} in ('critical','high'))`,
          sql`coalesce(${slackMessages.urgencyStatus}, 'new') in ('new','acknowledged','in_progress')`,
        ),
      )
      .limit(1)
      .get();
    return hit !== undefined;
  };

  /**
   * R17 (product rule, revisitable): an urgent follow-up in a thread whose earlier urgent message
   * is notified and still open gets no notification and no draft; it is listed as `coalesced`.
   * Decided once and stored: a message that notified itself is never coalesced, and a coalesced
   * one stays coalesced.
   */
  const coalesced = (tx: Tx, messageId: string): boolean => {
    const s = screeningOf(tx, messageId);
    if (s.notified === true) return false;
    if (s.coalesced === true) return true;
    if (!hasOpenUrgentAnchor(tx, messageId)) return false;
    mergeScreening(tx, messageId, { coalesced: true });
    return true;
  };

  /**
   * R18 (7): until the user confirms their Slack identity, own messages cannot be told apart, so
   * candidates are assessed and listed but nothing notifies and no draft is made (the dashboard's
   * identity banner explains why).
   */
  const identityConfirmed = () => settings.get("slack.selfUserId") !== null;

  /** Notification, event, suggest job and `notified` flag, once per message. Never carries text. */
  const notifyOnce = (tx: Tx, m: BatchRow, level: UrgencyLevel, assessed: boolean) => {
    if (!settings.get("urgency.notify.levels").includes(level)) return;
    if (alreadyNotified(tx, m.messageId)) return;
    const who = `message from ${m.senderName} in ${m.conversationLabel}`;
    notifications.notify(tx, {
      kind: "urgency.urgent",
      severity: level === "critical" ? "high" : level === "high" ? "warning" : "info",
      title: `${LEVEL_TITLE[level]}: ${who}`,
      ref: m.messageId,
    });
    if (isUrgent(level)) {
      events.publish(tx, {
        type: "message.urgent_detected",
        aggregateType: "slack_message",
        aggregateId: m.messageId,
        correlationId: newId(),
        payload: { messageId: m.messageId, level, assessed },
      });
    }
    mergeScreening(tx, m.messageId, { notified: true });
  };

  const enqueueSuggest = (tx: Tx, messageId: string, level: UrgencyLevel) => {
    if (!isUrgent(level)) return;
    queue.enqueue(tx, {
      type: "urgency.suggest_response",
      idempotencyKey: `urgency.suggest:${messageId}`,
      input: { messageId },
      concurrencyGroup: "urgency.suggest",
      priority: 150,
    });
  };

  /** One immediate transaction: level, status (only when unset), screening merge, notification. */
  const writeLevel = (
    m: BatchRow,
    level: UrgencyLevel,
    reason: string,
    fallback: boolean,
    after?: (tx: Tx) => void,
  ) =>
    db.transaction(
      (tx) => {
        const cur = tx
          .select({
            status: slackMessages.urgencyStatus,
            screening: slackMessages.screening,
          })
          .from(slackMessages)
          .where(eq(slackMessages.id, m.messageId))
          .get();
        if (!cur) return;
        if ((cur.screening as Partial<ScreeningRecord> | null)?.assessed === true) return;
        tx.update(slackMessages)
          .set({
            urgencyLevel: level,
            urgencyReason: reason,
            urgencyStatus: cur.status ?? "new",
            screening: {
              ...((cur.screening ?? {}) as Record<string, unknown>),
              assessed: true,
              fallback,
            },
          })
          .where(eq(slackMessages.id, m.messageId))
          .run();
        after?.(tx);
        if (!identityConfirmed()) return;
        const acts = isUrgent(level) || settings.get("urgency.notify.levels").includes(level);
        if (acts && coalesced(tx, m.messageId)) return;
        notifyOnce(tx, m, level, !fallback);
        // R18 (8): a rule-level fallback gets no draft; the model never saw the message.
        if (!fallback) enqueueSuggest(tx, m.messageId, level);
      },
      { behavior: "immediate" },
    );

  const enqueueNext = (tx: Tx, jobId: string) => {
    if (!hasMore(tx)) return;
    queue.enqueue(tx, {
      type: "urgency.assess",
      idempotencyKey: `urgency.batch:${jobId}:next`,
      concurrencyGroup: "urgency.assess",
      priority: 200,
    });
  };

  /** Deferral: likely incidents are announced from the rule level alone; nothing is assessed. */
  const onDeferral = (batch: BatchRow[]) => {
    // R18 (3): the announcement is a critical-level notification, so it follows the levels setting.
    if (!settings.get("urgency.notify.levels").includes("critical")) return;
    if (!identityConfirmed()) return;
    for (const m of batch) {
      if (m.ruleLevel !== "critical") continue;
      db.transaction(
        (tx) => {
          if (alreadyNotified(tx, m.messageId)) return;
          if (coalesced(tx, m.messageId)) return;
          notifications.notify(tx, {
            kind: "urgency.urgent",
            severity: "high",
            title: `Likely incident (not yet assessed): message from ${m.senderName} in ${m.conversationLabel}`,
            ref: m.messageId,
          });
          events.publish(tx, {
            type: "message.urgent_detected",
            aggregateType: "slack_message",
            aggregateId: m.messageId,
            correlationId: newId(),
            payload: { messageId: m.messageId, level: "critical", assessed: false },
          });
          mergeScreening(tx, m.messageId, { notified: true });
        },
        { behavior: "immediate" },
      );
    }
  };

  /** Terminal failure: rule level stands, flagged as fallback. */
  const onTerminal = (batch: BatchRow[], jobId: string) => {
    for (const m of batch) writeLevel(m, m.ruleLevel, FALLBACK_REASON, true);
    db.transaction((tx) => enqueueNext(tx, jobId), { behavior: "immediate" });
  };

  /**
   * R18 (1): run at startup and on every reaper pass. Eligible rows with no PENDING, RETRY or
   * RUNNING `urgency.assess` job (a job lost to a crash, a cancelled or parked job) get one.
   */
  const recoverySweep = (tx: Tx) => {
    const active = tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(eq(jobs.type, "urgency.assess"), inArray(jobs.status, ["PENDING", "RETRY", "RUNNING"])),
      )
      .limit(1)
      .get();
    if (active || !hasMore(tx)) return;
    queue.enqueue(tx, {
      type: "urgency.assess",
      // One recover job per clock hour: a deterministic crash loop costs at most 3 runs an hour.
      idempotencyKey: `urgency.batch:recover:${deps.clock.now().toISOString().slice(0, 13)}`,
      concurrencyGroup: "urgency.assess",
      priority: 200,
    });
  };

  const assess = async (job: Job, ctx: JobContext) => {
    db.transaction((tx) => skipStale(tx), { behavior: "immediate" });
    const batch = select(settings.get("urgency.assess.batchMax"));
    if (batch.length === 0) return { assessed: 0 };
    const byId = new Map(batch.map((m) => [m.messageId, m]));

    const before = runIdBefore(job.id);
    let ran = false;
    try {
      const req = buildAssessRequest(batch, job.id, settings.get("urgency.model"));
      const result = await orchestrator.run(req, ctx.signal);
      ran = true;
      runtimeFlags(
        job.id,
        batch.map((b) => b.messageId),
        result,
      );
      const parsed = parseStructured(result.finalText, urgencyAssessmentSchema);
      if (!parsed.ok) {
        throw new JobError({ kind: "incomplete_ai_output", message: parsed.reason });
      }
      const value = parsed.value;

      const seen = new Set<string>();
      for (const a of value.assessments) {
        if (!byId.has(a.messageId) || seen.has(a.messageId)) {
          throw new JobError({
            kind: "incomplete_ai_output",
            message: "assessment output has an unknown or duplicate message id",
          });
        }
        seen.add(a.messageId);
      }

      const runId = latestRunId(job.id);
      let fallbacks = 0;
      for (const a of value.assessments) {
        const m = byId.get(a.messageId) as BatchRow;
        writeLevel(m, a.level, renderExcerpt(a.reason, 300) || "Assessed", false, (tx) => {
          if (a.suspectedInjection.detected) {
            securityFlags.recordAiFlag(tx, m.messageId, runId, a.suspectedInjection);
          }
        });
      }
      for (const m of batch) {
        if (seen.has(m.messageId)) continue;
        fallbacks++;
        writeLevel(m, m.ruleLevel, FALLBACK_REASON, true);
      }
      db.transaction((tx) => enqueueNext(tx, job.id), { behavior: "immediate" });
      return { assessed: seen.size, fallbacks };
    } catch (err) {
      const { classified, rethrow } = wrapFailure(err);
      if (!ran) {
        safely(() =>
          failedRunFlags(
            job.id,
            batch.map((b) => b.messageId),
            classified,
            before,
          ),
        );
      }
      const decision = retryDecision(classified.kind);
      if (decision === "defer") onDeferral(batch);
      else if (
        decision === "needs_attention" ||
        decision === "fail" ||
        job.attempts >= job.maxAttempts
      ) {
        onTerminal(batch, job.id);
      }
      throw rethrow;
    }
  };

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

  deps.handlers.set("urgency.assess", { handler: assess, timeoutMs: ASSESS_TIMEOUT_MS });
  deps.handlers.set("urgency.suggest_response", {
    handler: suggest,
    timeoutMs: SUGGEST_TIMEOUT_MS,
  });
  return { recoverySweep };
}
