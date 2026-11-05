import {
  type ClassifiedError,
  type Job,
  JobError,
  retryDecision,
  type ScreeningRecord,
  type UrgencyLevel,
  urgencyAssessmentSchema,
} from "@synapse/contracts";
import { type Db, schema, type Tx } from "@synapse/database";
import { type Clock, newId } from "@synapse/shared";
import { asc, desc, eq, sql } from "drizzle-orm";
import type { SettingsService } from "../core/config/settings";
import type { EventPublisher } from "../core/events/publisher";
import type { JobQueue } from "../core/jobs/queue";
import type { HandlerRegistration, JobContext } from "../core/jobs/worker";
import type { NotificationService } from "../core/notifications/notifications";
import type { ClaudeOrchestrator } from "../core/orchestrator/orchestrator";
import { parseStructured } from "../core/orchestrator/structured";
import { classifyTool } from "../core/orchestrator/tool-catalog";
import { type AssessBatchItem, buildAssessRequest } from "../intelligence/urgency/assess-prompt";
import { renderExcerpt } from "../modules/security-flags/detector";
import type { SecurityFlagsService } from "../modules/security-flags/service";

const { slackMessages, slackConversations, slackUsers, claudeRuns } = schema;

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

const isUrgent = (l: UrgencyLevel): l is "critical" | "high" => l === "critical" || l === "high";

export function registerUrgencyJobs(deps: UrgencyJobDeps): void {
  const { db, settings, events, queue, notifications, orchestrator, securityFlags } = deps;

  const eligibleWhere = sql`json_extract(${slackMessages.screening}, '$.route') = 'assess'
    and coalesce(json_extract(${slackMessages.screening}, '$.assessed'), 0) = 0
    and ${slackMessages.text} is not null`;

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
      .where(eligibleWhere)
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
    tx.select({ id: slackMessages.id }).from(slackMessages).where(eligibleWhere).limit(1).all()
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

  const alreadyNotified = (tx: Tx, messageId: string): boolean => {
    const row = tx
      .select({ screening: slackMessages.screening })
      .from(slackMessages)
      .where(eq(slackMessages.id, messageId))
      .get();
    return (row?.screening as Partial<ScreeningRecord> | null)?.notified === true;
  };

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
        notifyOnce(tx, m, level, !fallback);
        enqueueSuggest(tx, m.messageId, level);
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

  const latestRunId = (jobId: string): string => {
    const row = db
      .select({ id: claudeRuns.id })
      .from(claudeRuns)
      .where(eq(claudeRuns.jobId, jobId))
      .orderBy(desc(claudeRuns.startedAt), sql`${claudeRuns}.rowid desc`)
      .limit(1)
      .get();
    if (!row) throw new JobError({ kind: "unknown", message: "claude run record unavailable" });
    return row.id;
  };

  const runtimeFlags = (
    jobId: string,
    batch: BatchRow[],
    result: { permissionDenials: string[]; toolResults: { toolName: string }[] },
  ) => {
    const used = result.toolResults.map((t) => t.toolName).filter((n) => n !== "ToolSearch");
    const denied = result.permissionDenials;
    if (denied.length === 0 && used.length === 0) return;
    const names = [...new Set([...denied, ...used])];
    const severity = names.some((n) => {
      const c = classifyTool(n);
      return c === "write" || c === "builtin_write";
    })
      ? "high"
      : "warning";
    const parts: string[] = [];
    if (denied.length > 0) parts.push(`denied tools: ${[...new Set(denied)].join(", ")}`);
    if (used.length > 0) parts.push(`unexpected tools used: ${[...new Set(used)].join(", ")}`);
    const runId = latestRunId(jobId);
    db.transaction(
      (tx) => {
        securityFlags.recordRuntimeFlag(
          tx,
          batch.map((b) => b.messageId),
          runId,
          parts.join("; "),
          severity,
        );
      },
      { behavior: "immediate" },
    );
  };

  /** Deferral: likely incidents are announced from the rule level alone; nothing is assessed. */
  const onDeferral = (batch: BatchRow[]) => {
    for (const m of batch) {
      if (m.ruleLevel !== "critical") continue;
      db.transaction(
        (tx) => {
          if (alreadyNotified(tx, m.messageId)) return;
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

  const assess = async (job: Job, ctx: JobContext) => {
    const batch = select(settings.get("urgency.assess.batchMax"));
    if (batch.length === 0) return { assessed: 0 };
    const byId = new Map(batch.map((m) => [m.messageId, m]));

    try {
      const req = buildAssessRequest(batch, job.id, settings.get("urgency.model"));
      const result = await orchestrator.run(req, ctx.signal);
      runtimeFlags(job.id, batch, result);
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
      const classified: ClassifiedError =
        err instanceof JobError
          ? err.classified
          : { kind: "unknown", message: "unexpected urgency assessment failure" };
      const rethrow = err instanceof JobError ? err : new JobError(classified);
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

  deps.handlers.set("urgency.assess", { handler: assess, timeoutMs: ASSESS_TIMEOUT_MS });
}
