import { type Db, schema, type Tx } from "@synapse/database";
import { type Clock, newId } from "@synapse/shared";
import { and, desc, eq, gt, isNotNull, isNull, notInArray, or, type SQL } from "drizzle-orm";
import type { SettingsService } from "../../core/config/settings";
import type { EventPublisher } from "../../core/events/publisher";
import type { JobQueue } from "../../core/jobs/queue";
import type { NotificationService } from "../../core/notifications/notifications";
import { COMMITMENTS_CONCURRENCY_GROUP } from "./store";

const { commitments, commitmentSources, commitmentUpdates, slackMessages, slackUsers } = schema;

export const STALL_JOB = "commitments.check_stalled";
export const REMINDERS_JOB = "commitments.reminders";
export const DRAFT_JOB = "commitments.draft_followup";
export const DRAFT_PRIORITY = 70;
/** `commitment_updates.field` marking that `commitment.overdue` was emitted (`to_value` = due date). */
export const OVERDUE_NOTIFIED_FIELD = "overdue_notified";
export const REMINDER_KIND = "commitment.reminder";

const HOUR_MS = 3_600_000;

/** The latest of the given ISO timestamps, ignoring nulls; null when all are null. */
function latest(...times: (string | null)[]): string | null {
  let out: string | null = null;
  for (const t of times) if (t !== null && (out === null || t > out)) out = t;
  return out;
}
const CLOSED = ["completed", "cancelled"] as const;

export interface StallServiceDeps {
  db: Db;
  clock: Clock;
  settings: SettingsService;
  events: EventPublisher;
  queue: JobQueue;
  notifications: NotificationService;
}

export type ReminderState = "due_soon" | "overdue";

/**
 * Deterministic (no AI) stall detection, overdue events and user reminders. Everything it writes
 * or emits is content-free: ids, states and counts only.
 */
export class StallService {
  constructor(private readonly deps: StallServiceDeps) {}

  /** Newest and oldest source message times (newest falls back to the commitment's creation). */
  private sourceTimes(
    tx: Tx,
    id: string,
    createdAt: string,
  ): { newest: string; oldest: string | null } {
    const rows = tx
      .select({ sentAt: slackMessages.sentAt })
      .from(commitmentSources)
      .innerJoin(slackMessages, eq(slackMessages.id, commitmentSources.messageId))
      .where(eq(commitmentSources.commitmentId, id))
      .orderBy(desc(slackMessages.sentAt))
      .all();
    return { newest: rows[0]?.sentAt ?? createdAt, oldest: rows.at(-1)?.sentAt ?? null };
  }

  /**
   * R16: the owner's latest message in the source scope sent after `after` (when given). The scope is
   * the source thread for a source that is a thread reply (root included), else the source
   * conversation. Only existence and time matter: messages with null or expired text count.
   */
  private ownerLatestAt(tx: Tx, id: string, owner: string, after: string | null): string | null {
    const sources = tx
      .select({ conv: commitmentSources.conversationId, threadTs: slackMessages.threadTs })
      .from(commitmentSources)
      .leftJoin(slackMessages, eq(slackMessages.id, commitmentSources.messageId))
      .where(eq(commitmentSources.commitmentId, id))
      .all();
    const scopes: SQL[] = [];
    for (const s of sources) {
      if (s.conv === null) continue;
      if (s.threadTs) {
        const inConv = eq(slackMessages.conversationId, s.conv);
        const inThread = or(
          eq(slackMessages.threadTs, s.threadTs),
          eq(slackMessages.ts, s.threadTs),
        );
        scopes.push(and(inConv, inThread) as SQL);
      } else {
        scopes.push(eq(slackMessages.conversationId, s.conv));
      }
    }
    if (scopes.length === 0) return null;
    const row = tx
      .select({ sentAt: slackMessages.sentAt })
      .from(slackMessages)
      .innerJoin(slackUsers, eq(slackUsers.id, slackMessages.senderUserId))
      .where(
        and(
          eq(slackUsers.externalId, owner),
          or(...scopes),
          after === null ? undefined : gt(slackMessages.sentAt, after),
        ),
      )
      .orderBy(desc(slackMessages.sentAt))
      .limit(1)
      .get();
    return row?.sentAt ?? null;
  }

  /**
   * Hourly. Marks stalled commitments owed by others (once per stall), and emits `commitment.overdue`
   * once for past-due commitments of the user. Returns counts only.
   */
  checkStalled(): { stalled: number; cleared: number; overdue: number } {
    const { db, clock, settings } = this.deps;
    const nowMs = clock.now().getTime();
    const now = new Date(nowMs).toISOString();
    const waitMs = settings.get("commitments.stall.waitHours") * HOUR_MS;
    const out = { stalled: 0, cleared: 0, overdue: 0 };
    const active = db.transaction((tx) =>
      tx
        .select()
        .from(commitments)
        .where(
          and(
            eq(commitments.reviewStatus, "accepted"),
            isNull(commitments.closedAt),
            notInArray(commitments.status, [...CLOSED]),
          ),
        )
        .all(),
    );
    for (const c of active) {
      db.transaction(
        (tx) => {
          if (c.direction === "mine") {
            if (c.dueAt !== null && c.dueAt < now && this.markOverdue(tx, c.id, c.dueAt, now)) {
              out.overdue++;
            }
            return;
          }
          if (c.status === "blocked") return;
          const { newest, oldest } = this.sourceTimes(tx, c.id, c.createdAt);
          // The owner's latest reply: messages after the oldest source, so an owner-authored source
          // message ("I'll do X") is not itself a reply.
          const ownerAt = this.ownerLatestAt(tx, c.id, c.ownerSlackUserId, oldest);
          if (c.stalledAt !== null) {
            const followedUp = c.lastFollowupAt !== null && c.lastFollowupAt > c.stalledAt;
            const ownerReplied = ownerAt !== null && ownerAt > c.stalledAt;
            if (!followedUp && !ownerReplied) return; // still the same stall
            tx.update(commitments)
              .set({ stalledAt: null, updatedAt: now })
              .where(eq(commitments.id, c.id))
              .run();
            out.cleared++;
          }
          // R16: stalled when nothing happened for waitHours since the latest of the newest source,
          // the last follow-up and the owner's latest reply. One old reply never stops detection.
          const reference = latest(newest, c.lastFollowupAt, ownerAt) as string;
          const quiet = nowMs - Date.parse(reference) >= waitMs;
          // Past due stalls early, once waitHours have passed since the last contact (the owner's
          // latest reply or our last follow-up), or at once when there was none.
          const pastDue = c.dueAt !== null && c.dueAt < now;
          const lastContact = latest(ownerAt, c.lastFollowupAt);
          const contactAged = lastContact === null || nowMs - Date.parse(lastContact) >= waitMs;
          if (!quiet && !(pastDue && contactAged)) return;
          tx.update(commitments)
            .set({ stalledAt: now, nextAction: c.nextAction ?? "Follow up", updatedAt: now })
            .where(eq(commitments.id, c.id))
            .run();
          this.deps.events.publish(tx, {
            type: "commitment.stalled",
            aggregateType: "commitment",
            aggregateId: c.id,
            correlationId: newId(),
            payload: { commitmentId: c.id },
          });
          this.deps.queue.enqueue(tx, {
            type: DRAFT_JOB,
            idempotencyKey: `commitments.draft:${c.id}:${now}`,
            input: { commitmentId: c.id, stalledAt: now },
            concurrencyGroup: COMMITMENTS_CONCURRENCY_GROUP,
            priority: DRAFT_PRIORITY,
          });
          out.stalled++;
        },
        { behavior: "immediate" },
      );
    }
    return out;
  }

  private markOverdue(tx: Tx, id: string, dueAt: string, now: string): boolean {
    const done = tx
      .select({ id: commitmentUpdates.id })
      .from(commitmentUpdates)
      .where(
        and(
          eq(commitmentUpdates.commitmentId, id),
          eq(commitmentUpdates.field, OVERDUE_NOTIFIED_FIELD),
        ),
      )
      .limit(1)
      .get();
    if (done) return false;
    tx.insert(commitmentUpdates)
      .values({
        id: newId(),
        commitmentId: id,
        actor: "system",
        field: OVERDUE_NOTIFIED_FIELD,
        fromValue: null,
        toValue: dueAt,
        reason: null,
        createdAt: now,
      })
      .run();
    this.deps.events.publish(tx, {
      type: "commitment.overdue",
      aggregateType: "commitment",
      aggregateId: id,
      correlationId: newId(),
      payload: { commitmentId: id },
    });
    return true;
  }

  /** Every 15 minutes. One notification per (commitment, state). Returns the number sent. */
  sendReminders(): { notified: number } {
    const { db, clock, settings, notifications } = this.deps;
    const nowMs = clock.now().getTime();
    const now = new Date(nowMs).toISOString();
    const soon = new Date(
      nowMs + settings.get("commitments.reminder.dueSoonHours") * HOUR_MS,
    ).toISOString();
    let notified = 0;
    const mine = db
      .select({
        id: commitments.id,
        dueAt: commitments.dueAt,
        counterparty: commitments.counterpartySlackUserId,
      })
      .from(commitments)
      .where(
        and(
          eq(commitments.reviewStatus, "accepted"),
          eq(commitments.direction, "mine"),
          isNull(commitments.closedAt),
          notInArray(commitments.status, [...CLOSED]),
          isNotNull(commitments.dueAt),
        ),
      )
      .all();
    for (const c of mine) {
      const due = c.dueAt as string;
      const state: ReminderState | null = due < now ? "overdue" : due <= soon ? "due_soon" : null;
      if (!state) continue;
      const ref = `commitment:${c.id}:${state}`;
      db.transaction(
        (tx) => {
          const sent = tx
            .select({ id: schema.notifications.id })
            .from(schema.notifications)
            .where(
              and(eq(schema.notifications.kind, REMINDER_KIND), eq(schema.notifications.ref, ref)),
            )
            .limit(1)
            .get();
          if (sent) return;
          const name = c.counterparty
            ? tx
                .select({ name: slackUsers.name })
                .from(slackUsers)
                .where(eq(slackUsers.externalId, c.counterparty))
                .get()?.name
            : null;
          const label = name ? [...name.replace(/\s+/g, " ").trim()].slice(0, 80).join("") : "";
          const prefix = state === "overdue" ? "Overdue" : "Due soon";
          notifications.notify(tx, {
            kind: REMINDER_KIND,
            severity: state === "overdue" ? "high" : "warning",
            title: label ? `${prefix}: commitment to ${label}` : `${prefix}: your commitment`,
            ref,
          });
          notified++;
        },
        { behavior: "immediate" },
      );
    }
    return { notified };
  }
}
