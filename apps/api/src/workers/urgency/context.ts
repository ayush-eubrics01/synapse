import type { ScreeningRecord, UrgencyLevel } from "@synapse/contracts";
import { schema, type Tx } from "@synapse/database";
import { newId } from "@synapse/shared";
import { and, asc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { createRunHelpers } from "../intelligence-shared";

import {
  type BatchRow,
  conversationLabel,
  FALLBACK_REASON,
  isUrgent,
  LEVEL_TITLE,
  type UrgencyJobDeps,
} from "./shared";

const { slackMessages, slackConversations, slackUsers, jobs } = schema;

/**
 * K5.2: `skipStale` scans only `[cutoff - window, cutoff)`. Screening routes a message to `assess`
 * only while it is fresh, so older pending rows exist only after a week without an assess run; they
 * are never eligible (`eligibleWhere` needs `sentAt >= cutoff`), so leaving them is harmless.
 */
export const STALE_SCAN_WINDOW_MS = 7 * 86_400_000;

/** The helpers both urgency jobs share: batch selection, screening state, notifications, recovery. */
export function createUrgencyContext(deps: UrgencyJobDeps) {
  const { db, settings, events, queue, notifications, securityFlags } = deps;
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
    const cutoff = cutoffIso();
    const windowStart = new Date(Date.parse(cutoff) - STALE_SCAN_WINDOW_MS).toISOString();
    const stale = tx
      .select({ id: slackMessages.id })
      .from(slackMessages)
      .where(
        sql`${slackMessages.sentAt} >= ${windowStart} and ${slackMessages.sentAt} < ${cutoff} and ${pendingAssess}`,
      )
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

  return {
    latestRunId,
    runIdBefore,
    runtimeFlags,
    failedRunFlags,
    select,
    skipStale,
    writeLevel,
    enqueueNext,
    onDeferral,
    onTerminal,
    recoverySweep,
  };
}

export type UrgencyContext = ReturnType<typeof createUrgencyContext>;
