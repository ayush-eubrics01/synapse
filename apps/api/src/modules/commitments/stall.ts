import { type Db, schema, type Tx } from "@synapse/database";
import { type Clock, newId } from "@synapse/shared";
import { and, desc, eq, gt, inArray, isNotNull, isNull, notInArray } from "drizzle-orm";
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

  /** Newest source message time, or the commitment's creation when no source message survives. */
  private newestSourceAt(tx: Tx, id: string, createdAt: string): string {
    const row = tx
      .select({ sentAt: slackMessages.sentAt })
      .from(commitmentSources)
      .innerJoin(slackMessages, eq(slackMessages.id, commitmentSources.messageId))
      .where(eq(commitmentSources.commitmentId, id))
      .orderBy(desc(slackMessages.sentAt))
      .limit(1)
      .get();
    return row?.sentAt ?? createdAt;
  }

  /** Only existence matters: messages with null text, or expired text, count. */
  private ownerRepliedAfter(tx: Tx, id: string, owner: string, after: string): boolean {
    const convs = tx
      .select({ c: commitmentSources.conversationId })
      .from(commitmentSources)
      .where(eq(commitmentSources.commitmentId, id))
      .all()
      .map((r) => r.c);
    if (convs.length === 0) return false;
    return (
      tx
        .select({ id: slackMessages.id })
        .from(slackMessages)
        .innerJoin(slackUsers, eq(slackUsers.id, slackMessages.senderUserId))
        .where(
          and(
            eq(slackUsers.externalId, owner),
            inArray(slackMessages.conversationId, convs),
            gt(slackMessages.sentAt, after),
          ),
        )
        .limit(1)
        .get() !== undefined
    );
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
          if (c.stalledAt !== null) {
            const followedUp = c.lastFollowupAt !== null && c.lastFollowupAt > c.stalledAt;
            if (!followedUp && !this.ownerRepliedAfter(tx, c.id, c.ownerSlackUserId, c.stalledAt)) {
              return; // still the same stall
            }
            tx.update(commitments)
              .set({ stalledAt: null, updatedAt: now })
              .where(eq(commitments.id, c.id))
              .run();
            out.cleared++;
          }
          const newest = this.newestSourceAt(tx, c.id, c.createdAt);
          const since =
            c.lastFollowupAt !== null && c.lastFollowupAt > newest ? c.lastFollowupAt : newest;
          if (this.ownerRepliedAfter(tx, c.id, c.ownerSlackUserId, since)) return;
          const quiet = nowMs - Date.parse(since) >= waitMs;
          // Past due stalls early, but never again right after a follow-up (same wait applies).
          const pastDue = c.dueAt !== null && c.dueAt < now;
          const coolingDown =
            c.lastFollowupAt !== null && nowMs - Date.parse(c.lastFollowupAt) < waitMs;
          if (!quiet && !(pastDue && !coolingDown)) return;
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
