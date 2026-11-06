import type { FollowupAction, FollowupStatus, FollowupView } from "@synapse/contracts";
import { type Db, type DbOrTx, schema, type Tx } from "@synapse/database";
import { type Clock, isoNow, newId } from "@synapse/shared";
import { and, desc, eq, inArray, isNotNull, lt, ne, or, sql } from "drizzle-orm";
import type { AuditLogger } from "../../core/audit/audit";
import type { EventPublisher } from "../../core/events/publisher";
import type { JobQueue } from "../../core/jobs/queue";
import { participantLabel } from "../outgoing/preview";
import { FollowupNotFound, InvalidOutgoingText, type OutgoingService } from "../outgoing/service";
import { resolveActions } from "../outgoing/urgent-reply";
import { UnknownCommitment } from "./lifecycle";
import { DRAFT_JOB, DRAFT_PRIORITY } from "./stall";
import { COMMITMENTS_CONCURRENCY_GROUP, LIVE_FOLLOWUP } from "./store";

const {
  commitments,
  followups,
  followupHistory,
  outgoingMessages,
  slackConversations,
  slackUsers,
  jobs,
} = schema;

const MAX_TEXT = 4000;
const LIVE_OUTGOING = ["pending", "sending", "sent_unverified", "needs_attention"] as const;
/**
 * A draft in these states can be edited and sent for approval. The enum's `failed` is never written
 * (a failed send returns its follow-up to `draft`), so it is neither sendable nor active.
 */
const SENDABLE: FollowupStatus[] = ["draft"];
/** Active drafts: everything the user can still act on. */
const ACTIVE: FollowupStatus[] = ["draft", "awaiting_approval", "sending", "needs_attention"];

/** The follow-up is discarded, sent, or has a live send (409). */
export class FollowupNotSendable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "FollowupNotSendable";
  }
}
/** The follow-up cannot be discarded in its current state (409). */
export class FollowupNotDiscardable extends Error {
  constructor() {
    super("follow-up cannot be discarded now");
    this.name = "FollowupNotDiscardable";
  }
}
/** A manual draft was requested for a commitment that does not qualify (409). */
export class InvalidManualDraft extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "InvalidManualDraft";
  }
}

export interface FollowupServiceDeps {
  db: Db;
  clock: Clock;
  audit: AuditLogger;
  events: EventPublisher;
  queue: Pick<JobQueue, "enqueue">;
  outgoing: Pick<OutgoingService, "requestSend">;
  /** The user's Slack id (`slack.selfUserId`), for DM participant labels (R17). */
  selfUserId: () => string | null;
}

type FollowupRow = typeof followups.$inferSelect;

/**
 * User-facing follow-up drafts: the list view, send for approval, discard, a manual draft request
 * and the `followup.sent` consumer. No AI here. Text is stored only in the module tables; audit
 * rows, events and logs carry ids and fixed reasons.
 */
export class FollowupService {
  constructor(private readonly deps: FollowupServiceDeps) {}

  /** `status` is one status, or `active` (the default) for every draft the user can act on. */
  listViews(status: FollowupStatus | "active" = "active", limit = 200): FollowupView[] {
    const { db } = this.deps;
    const rows = db
      .select()
      .from(followups)
      .where(
        and(
          // Urgent replies are shown with their urgent message.
          ne(followups.origin, "urgent_reply"),
          status === "active" ? inArray(followups.status, ACTIVE) : eq(followups.status, status),
        ),
      )
      .orderBy(desc(followups.createdAt), desc(followups.id))
      .limit(Math.min(Math.max(Math.trunc(limit) || 200, 1), 500))
      .all();
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const noThread = new Set(
      db
        .select({ followupId: followupHistory.followupId })
        .from(followupHistory)
        .where(and(inArray(followupHistory.followupId, ids), eq(followupHistory.event, "noThread")))
        .all()
        .map((h) => h.followupId),
    );
    const outgoing = new Map(
      db
        .select({
          id: outgoingMessages.id,
          status: outgoingMessages.status,
          failure: outgoingMessages.failure,
        })
        .from(outgoingMessages)
        .where(
          inArray(
            outgoingMessages.id,
            rows.map((r) => r.outgoingId ?? ""),
          ),
        )
        .all()
        .map((o) => [o.id, o]),
    );
    const refs = [...new Set(rows.map((r) => r.conversationId))];
    const convs = db
      .select()
      .from(slackConversations)
      .where(or(inArray(slackConversations.id, refs), inArray(slackConversations.externalId, refs)))
      .all();
    const convOf = (ref: string) =>
      convs.find((c) => c.id === ref) ?? convs.find((c) => c.externalId === ref);
    const slackIds = [...new Set(rows.map((r) => r.recipientSlackUserId ?? ""))].filter(
      (x) => x !== "",
    );
    const names = new Map(
      db
        .select({ externalId: slackUsers.externalId, name: slackUsers.name })
        .from(slackUsers)
        .where(inArray(slackUsers.externalId, slackIds))
        .all()
        .map((u) => [u.externalId, u.name]),
    );
    const selfId = this.deps.selfUserId();
    return rows.map((r) => {
      const o = r.outgoingId === null ? undefined : outgoing.get(r.outgoingId);
      const conv = convOf(r.conversationId);
      const live = o !== undefined && (LIVE_OUTGOING as readonly string[]).includes(o.status);
      const actions: FollowupAction[] = [];
      if (SENDABLE.includes(r.status) && !live) {
        // Sending needs a resolvable conversation; discarding never does.
        if (conv) actions.push("send");
        actions.push("discard");
      }
      return {
        id: r.id,
        commitmentId: r.commitmentId,
        origin: r.origin,
        recipient:
          r.recipientSlackUserId === null
            ? null
            : { id: r.recipientSlackUserId, name: names.get(r.recipientSlackUserId) ?? null },
        conversationLabel: conv ? participantLabel(db, conv, selfId) : null,
        threadReply: r.threadTs !== null,
        noThread: noThread.has(r.id),
        draftText: r.draftText,
        confidence: r.confidence,
        status: r.status,
        outgoing: o ? { id: o.id, status: o.status, failure: o.failure } : null,
        approvalId: r.approvalId,
        actions,
        resolveActions: o ? resolveActions(o.status, o.failure) : [],
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      };
    });
  }

  /**
   * Stores the user's edited text as the draft and requests the `slack.send` approval, in one
   * transaction. A discarded or sent follow-up, or one with a live send, throws (409).
   */
  send(
    followupId: string,
    rawText: string,
  ): { followupId: string; approvalId: string; outgoingId: string } {
    const { db, clock, audit, outgoing } = this.deps;
    const text = rawText.trimEnd();
    if (text.length < 1 || text.length > MAX_TEXT) throw new InvalidOutgoingText();
    return db.transaction(
      (tx) => {
        const f = this.load(tx, followupId);
        if (!SENDABLE.includes(f.status)) throw new FollowupNotSendable("follow-up is not a draft");
        const conv = tx
          .select({ externalId: slackConversations.externalId })
          .from(slackConversations)
          .where(
            sql`${slackConversations.id} = ${f.conversationId} or ${slackConversations.externalId} = ${f.conversationId}`,
          )
          .get();
        if (!conv) throw new FollowupNotSendable("conversation is unknown");
        // requestSend rejects a live send with SendAlreadyPending; the rollback keeps the old draft.
        tx.update(followups)
          .set({ draftText: text, updatedAt: isoNow(clock) })
          .where(eq(followups.id, followupId))
          .run();
        const sent = outgoing.requestSend(tx, {
          followupId,
          conversationExternalId: conv.externalId,
          threadTs: f.threadTs,
          text,
          requestedByModule: "commitments",
        });
        audit.record(tx, {
          actor: "user",
          module: "commitments",
          action: "followup.send_requested",
          targetRef: followupId,
          approvalId: sent.approvalId,
          result: "ok",
          details: { followupId, outgoingId: sent.outgoingId, threaded: f.threadTs !== null },
        });
        return { followupId, ...sent };
      },
      { behavior: "immediate" },
    );
  }

  discard(followupId: string): void {
    const { db, clock, events } = this.deps;
    db.transaction(
      (tx) => {
        const f = this.load(tx, followupId);
        const live = tx
          .select({ id: outgoingMessages.id })
          .from(outgoingMessages)
          .where(
            and(
              eq(outgoingMessages.followupId, followupId),
              inArray(outgoingMessages.status, LIVE_OUTGOING),
            ),
          )
          .get();
        if (!SENDABLE.includes(f.status) || live) throw new FollowupNotDiscardable();
        const now = isoNow(clock);
        tx.update(followups)
          .set({ status: "discarded", updatedAt: now })
          .where(eq(followups.id, followupId))
          .run();
        tx.insert(followupHistory)
          .values({ id: newId(), followupId, event: "discarded", detail: "user", createdAt: now })
          .run();
        events.publish(tx, {
          type: "followup.status_changed",
          aggregateType: "followup",
          aggregateId: followupId,
          correlationId: newId(),
          payload: { followupId, status: "discarded" },
        });
      },
      { behavior: "immediate" },
    );
  }

  /**
   * Queues a draft for an accepted, open `theirs` commitment with no live follow-up (409 otherwise).
   * The job skips the stall check; its own live-follow-up check still applies when it runs. Returns
   * `queued: false` when one is already queued.
   */
  requestManualDraft(commitmentId: string): { queued: boolean } {
    const { db, queue } = this.deps;
    return db.transaction(
      (tx) => {
        const c = tx.select().from(commitments).where(eq(commitments.id, commitmentId)).get();
        if (!c) throw new UnknownCommitment();
        const closed = c.closedAt !== null || c.status === "completed" || c.status === "cancelled";
        if (c.reviewStatus !== "accepted" || closed || c.direction !== "theirs") {
          throw new InvalidManualDraft("only an accepted, open commitment owed to you");
        }
        const live = tx
          .select({ id: followups.id })
          .from(followups)
          .where(
            and(eq(followups.commitmentId, commitmentId), inArray(followups.status, LIVE_FOLLOWUP)),
          )
          .limit(1)
          .get();
        if (live) throw new InvalidManualDraft("a follow-up of this commitment is already live");
        const pending = tx
          .select({ id: jobs.id })
          .from(jobs)
          .where(
            and(
              eq(jobs.type, DRAFT_JOB),
              inArray(jobs.status, ["PENDING", "RETRY", "RUNNING"]),
              sql`json_extract(${jobs.input}, '$.commitmentId') = ${commitmentId}`,
            ),
          )
          .limit(1)
          .get();
        if (pending) return { queued: false };
        queue.enqueue(tx, {
          type: DRAFT_JOB,
          idempotencyKey: `commitments.draft.manual:${commitmentId}:${newId()}`,
          input: { commitmentId, manual: true, origin: "manual" },
          concurrencyGroup: COMMITMENTS_CONCURRENCY_GROUP,
          priority: DRAFT_PRIORITY,
        });
        return { queued: true };
      },
      { behavior: "immediate" },
    );
  }

  /**
   * `followup.sent` consumer: a sent follow-up that belongs to a commitment resets its
   * post-follow-up wait. Savepoint, never throws, ids only in logs.
   */
  onFollowupSent(event: { payload: unknown }, tx: Tx): void {
    const followupId = (event.payload as { followupId?: unknown }).followupId;
    if (typeof followupId !== "string") return;
    try {
      tx.transaction((sp) => {
        const f = sp
          .select({ commitmentId: followups.commitmentId })
          .from(followups)
          .where(eq(followups.id, followupId))
          .get();
        if (!f?.commitmentId) return;
        const now = isoNow(this.deps.clock);
        sp.update(commitments)
          .set({ lastFollowupAt: now })
          .where(eq(commitments.id, f.commitmentId))
          .run();
      });
    } catch (e) {
      console.error(
        `commitments followup_sent failed followup=${followupId} error=${e instanceof Error ? e.name : "unknown"}`,
      );
    }
  }

  /**
   * Retention (final review, item 6): clears `draft_text` on `sent`, `discarded` and `failed`
   * follow-ups created more than `olderThanDays` ago. A live follow-up keeps its draft. Returns the
   * number cleared.
   */
  expireDrafts(olderThanDays: number): number {
    const { db, clock } = this.deps;
    const cutoff = new Date(clock.now().getTime() - olderThanDays * 86_400_000).toISOString();
    return db
      .update(followups)
      .set({ draftText: null })
      .where(
        and(
          inArray(followups.status, ["sent", "discarded", "failed"]),
          lt(followups.createdAt, cutoff),
          isNotNull(followups.draftText),
        ),
      )
      .returning({ id: followups.id })
      .all().length;
  }

  /** The Slack user a follow-up is addressed to (null when it has none); for `people.post_send`. */
  recipientOf(tx: DbOrTx, followupId: string): string | null {
    return (
      tx
        .select({ recipient: followups.recipientSlackUserId })
        .from(followups)
        .where(eq(followups.id, followupId))
        .get()?.recipient ?? null
    );
  }

  private load(tx: Tx, id: string): FollowupRow {
    const f = tx.select().from(followups).where(eq(followups.id, id)).get();
    if (!f) throw new FollowupNotFound(id);
    return f;
  }
}
