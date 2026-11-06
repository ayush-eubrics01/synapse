import type {
  AutoReplyKind,
  AutoReplyView,
  AwayDigest,
  DomainEvent,
  HoldReason,
} from "@synapse/contracts";
import { type Db, type DbOrTx, schema } from "@synapse/database";
import { type Clock, isoNow, newId } from "@synapse/shared";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { AutoReplyDisabledByPermission } from "../../core/approvals/approvals";
import type { AuditLogger } from "../../core/audit/audit";
import type { SettingsService } from "../../core/config/settings";
import type { EventPublisher } from "../../core/events/publisher";
import type { JobQueue } from "../../core/jobs/queue";
import { AutoSendBlocked, type OutgoingService } from "../outgoing/service";
import type { PeopleService } from "../people/service";
import type { SecurityFlagsService } from "../security-flags/service";
import { ACK_TEXT, decideAutoReply, withAutoReplyTag } from "./policy";

const {
  awaySessions,
  autoReplies,
  followups,
  slackMessages,
  slackUsers,
  slackConversations,
  outgoingMessages,
} = schema;

export const AUTOREPLY_EVALUATE_JOB = "autoreply.evaluate";
/** A5: one evaluation at a time, so the cap count and the insert never race. */
export const AUTOREPLY_CONCURRENCY_GROUP = "autoreply";
/** Above the default (100) so an acknowledgement is not stuck behind batch work. */
export const AUTOREPLY_PRIORITY = 150;
const DAY_MS = 24 * 3_600_000;
const MODULE = "auto-reply";

export type Trigger =
  | { kind: "acknowledgement"; messageId: string }
  | { kind: "stalled_reminder" | "followup_question"; followupId: string };

/** Why nothing was recorded at all (not a policy decision). */
export type SkipReason =
  | "away_off"
  | "not_found"
  | "self"
  | "not_draft"
  | "kind_mismatch"
  | "already_evaluated";

export type AutoReplyOutcome =
  | { status: "sent"; autoReplyId: string; outgoingId: string; approvalId: string }
  | {
      status: "held";
      autoReplyId: string;
      reason: HoldReason;
      /** A6: the acknowledgement evaluated in place of a low-confidence follow-up question. */
      acknowledgement?: AutoReplyOutcome;
    }
  | { status: "skipped"; reason: SkipReason };

export interface AwayStatus {
  on: boolean;
  sessionId: string | null;
  startedAt: string | null;
}

export interface AutoReplyServiceDeps {
  db: Db;
  clock: Clock;
  events: EventPublisher;
  audit: AuditLogger;
  queue: Pick<JobQueue, "enqueue">;
  settings: SettingsService;
  people: Pick<PeopleService, "getPriorityBySlackUser">;
  securityFlags: Pick<SecurityFlagsService, "hasOpenFlag">;
  outgoing: Pick<OutgoingService, "requestAutoSend">;
}

/** Everything one evaluation decided on; the row fields of its `auto_replies` record. */
interface Candidate {
  sessionId: string;
  kind: AutoReplyKind;
  recipient: string;
  conversationExternalId: string;
  threadTs: string | null;
  sourceMessageId: string | null;
  followupId: string | null;
}

type Resolved =
  | { skip: SkipReason }
  | {
      candidate: Candidate;
      /** Set when the reply cannot be built safely (A16 `missing_context`). */
      missing: boolean;
      incomingText: string | null;
      incomingFlagged: boolean;
      text: string;
      confidence: number | null;
      originMessageId: string | null;
    };

/** Rolls the send transaction back so the hold is recorded in a fresh one (controller ruling 1). */
class HoldAfterRollback extends Error {
  constructor(
    readonly candidate: Candidate,
    readonly reason: HoldReason,
  ) {
    super(`auto-send held: ${reason}`);
    this.name = "HoldAfterRollback";
  }
}

/**
 * Away mode (ADR-033, Phase 6b): sessions, the auto-reply triggers and `evaluate`, which runs the
 * deterministic policy and, on send, requests a policy-approved send through `OutgoingService`.
 * Every evaluation records an `auto_replies` row (`sent` or `held`) unless it is skipped outright.
 * Text is stored only in `auto_replies.text` (sent rows) and the outgoing row; audit rows, events,
 * jobs, thrown messages and logs carry ids and fixed reasons only.
 */
export class AutoReplyService {
  constructor(private readonly deps: AutoReplyServiceDeps) {}

  status(): AwayStatus {
    const open = this.openSession(this.deps.db);
    return {
      on: this.deps.settings.get("autoReply.awayMode"),
      sessionId: open?.id ?? null,
      startedAt: open?.startedAt ?? null,
    };
  }

  /**
   * A2: opens or closes the away session, sets `autoReply.awayMode`, audits as the user and
   * publishes `away.changed`. Idempotent both ways. Closing never cancels a send itself: the
   * executor's revalidate, claim and pre-spawn checks see the closed session and hold anything that
   * has not started, and a `sending` row is left to its outcome.
   */
  setAway(on: boolean): AwayStatus {
    const { db, settings, audit, clock } = this.deps;
    return db.transaction(
      (tx) => {
        const open = this.openSession(tx);
        const now = isoNow(clock);
        if (on) {
          if (open) {
            if (!settings.get("autoReply.awayMode")) settings.setIn(tx, "autoReply.awayMode", true);
            return { on: true, sessionId: open.id, startedAt: open.startedAt };
          }
          const sessionId = newId();
          tx.insert(awaySessions).values({ id: sessionId, startedAt: now }).run();
          settings.setIn(tx, "autoReply.awayMode", true);
          audit.record(tx, {
            actor: "user",
            module: MODULE,
            action: "away.started",
            targetRef: sessionId,
            result: "ok",
            details: { sessionId },
          });
          this.publishAway(tx, sessionId, true);
          return { on: true, sessionId, startedAt: now };
        }
        if (!open) {
          if (settings.get("autoReply.awayMode")) settings.setIn(tx, "autoReply.awayMode", false);
          return { on: false, sessionId: null, startedAt: null };
        }
        tx.update(awaySessions).set({ endedAt: now }).where(eq(awaySessions.id, open.id)).run();
        settings.setIn(tx, "autoReply.awayMode", false);
        audit.record(tx, {
          actor: "user",
          module: MODULE,
          action: "away.ended",
          targetRef: open.id,
          result: "ok",
          details: { sessionId: open.id },
        });
        this.publishAway(tx, open.id, false);
        return { on: false, sessionId: null, startedAt: null };
      },
      { behavior: "immediate" },
    );
  }

  /** `message.urgent_detected` consumer: queues an acknowledgement while away is on. */
  onUrgentDetected(event: DomainEvent, tx: DbOrTx): void {
    const p = event.payload as { messageId?: unknown; level?: unknown };
    if (typeof p.messageId !== "string") return;
    if (p.level !== "critical" && p.level !== "high") return;
    if (!this.deps.settings.get("autoReply.awayMode")) return;
    this.enqueue(tx, { kind: "acknowledgement", messageId: p.messageId });
  }

  /** `followup.draft_created` consumer: queues stalled and spec-clarity drafts while away is on. */
  onFollowupDraftCreated(event: DomainEvent, tx: DbOrTx): void {
    const followupId = (event.payload as { followupId?: unknown }).followupId;
    if (typeof followupId !== "string") return;
    if (!this.deps.settings.get("autoReply.awayMode")) return;
    const f = tx
      .select({ origin: followups.origin })
      .from(followups)
      .where(eq(followups.id, followupId))
      .get();
    if (f?.origin === "stalled") this.enqueue(tx, { kind: "stalled_reminder", followupId });
    else if (f?.origin === "spec_clarity") {
      this.enqueue(tx, { kind: "followup_question", followupId });
    }
  }

  enqueue(tx: DbOrTx, trigger: Trigger): void {
    const id = trigger.kind === "acknowledgement" ? trigger.messageId : trigger.followupId;
    this.deps.queue.enqueue(tx, {
      type: AUTOREPLY_EVALUATE_JOB,
      idempotencyKey: `autoreply:${trigger.kind}:${id}`,
      priority: AUTOREPLY_PRIORITY,
      concurrencyGroup: AUTOREPLY_CONCURRENCY_GROUP,
      input: trigger,
      externalWrite: false,
    });
  }

  /**
   * Runs the policy for one trigger: the resolve, the A5 cap counts, the decision and the record
   * (plus, on send, the policy-approved send request) are one immediate transaction. A shut
   * permission gate or a closed session at request time rolls that back and records a hold in a new
   * transaction; any other error propagates (the job retries).
   */
  evaluate(trigger: Trigger): AutoReplyOutcome {
    const { db } = this.deps;
    let outcome: AutoReplyOutcome;
    let originMessageId: string | null = null;
    try {
      const r = db.transaction(
        (tx) => {
          const resolved = this.resolve(tx, trigger);
          if ("skip" in resolved) return { outcome: { status: "skipped", reason: resolved.skip } };
          return {
            outcome: this.decideAndRecord(tx, resolved),
            originMessageId: resolved.originMessageId,
          };
        },
        { behavior: "immediate" },
      ) as { outcome: AutoReplyOutcome; originMessageId?: string | null };
      outcome = r.outcome;
      originMessageId = r.originMessageId ?? null;
    } catch (e) {
      if (!(e instanceof HoldAfterRollback)) throw e;
      outcome = db.transaction((tx) => this.recordHold(tx, e.candidate, e.reason), {
        behavior: "immediate",
      });
    }
    // A6: a low-confidence follow-up question is answered by an acknowledgement of its origin
    // message instead (a stalled reminder has no incoming message to acknowledge).
    if (
      trigger.kind === "followup_question" &&
      outcome.status === "held" &&
      outcome.reason === "low_confidence" &&
      originMessageId !== null
    ) {
      outcome.acknowledgement = this.evaluate({
        kind: "acknowledgement",
        messageId: originMessageId,
      });
    }
    return outcome;
  }

  /** A17: the most recently ended, undismissed session with its sent and held auto-replies. */
  digest(): AwayDigest | null {
    const { db } = this.deps;
    const s = db
      .select()
      .from(awaySessions)
      .where(and(isNotNull(awaySessions.endedAt), isNull(awaySessions.dismissedAt)))
      .orderBy(desc(awaySessions.endedAt), desc(awaySessions.startedAt))
      .limit(1)
      .get();
    if (!s?.endedAt) return null;
    const rows = db
      .select()
      .from(autoReplies)
      .where(eq(autoReplies.sessionId, s.id))
      .orderBy(asc(autoReplies.createdAt), sql`${autoReplies}.rowid`)
      .all();
    const ids = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x))];
    const names = new Map(
      db
        .select({ externalId: slackUsers.externalId, name: slackUsers.name })
        .from(slackUsers)
        .where(inArray(slackUsers.externalId, ids(rows.map((r) => r.recipientSlackUserId))))
        .all()
        .map((u) => [u.externalId, u.name]),
    );
    const convs = new Map(
      db
        .select()
        .from(slackConversations)
        .where(
          inArray(slackConversations.externalId, ids(rows.map((r) => r.conversationExternalId))),
        )
        .all()
        .map((c) => [c.externalId, c]),
    );
    const statuses = new Map(
      db
        .select({ id: outgoingMessages.id, status: outgoingMessages.status })
        .from(outgoingMessages)
        .where(inArray(outgoingMessages.id, ids(rows.map((r) => r.outgoingId))))
        .all()
        .map((o) => [o.id, o.status]),
    );
    const view = (r: (typeof rows)[number]): AutoReplyView => {
      const name = names.get(r.recipientSlackUserId) ?? null;
      const conv = convs.get(r.conversationExternalId);
      const conversationLabel =
        conv?.type === "channel"
          ? conv.name
            ? `#${conv.name}`
            : null
          : conv?.type === "im"
            ? name
            : null;
      return {
        id: r.id,
        kind: r.kind,
        decision: r.decision,
        reason: (r.reason as HoldReason | null) ?? null,
        recipient: { slackUserId: r.recipientSlackUserId, name },
        conversationLabel,
        threadTs: r.threadTs,
        createdAt: r.createdAt,
        // Delivery is the outgoing status; `decision` stays the policy's verdict.
        outgoingStatus: r.outgoingId === null ? null : (statuses.get(r.outgoingId) ?? null),
      };
    };
    return {
      session: { id: s.id, startedAt: s.startedAt, endedAt: s.endedAt },
      sent: rows.filter((r) => r.decision === "sent").map(view),
      held: rows.filter((r) => r.decision === "held").map(view),
    };
  }

  /** Hides an ended session's digest. False when the session is unknown or still open. */
  dismissDigest(sessionId: string): boolean {
    const { db, clock } = this.deps;
    const updated = db
      .update(awaySessions)
      .set({ dismissedAt: isoNow(clock) })
      .where(
        and(
          eq(awaySessions.id, sessionId),
          isNotNull(awaySessions.endedAt),
          isNull(awaySessions.dismissedAt),
        ),
      )
      .returning({ id: awaySessions.id })
      .all();
    if (updated.length > 0) return true;
    // Already dismissed still counts as found.
    const s = db
      .select({ endedAt: awaySessions.endedAt })
      .from(awaySessions)
      .where(eq(awaySessions.id, sessionId))
      .get();
    return s?.endedAt != null;
  }

  private resolve(tx: DbOrTx, trigger: Trigger): Resolved {
    const session = this.openSession(tx);
    if (!session) return { skip: "away_off" };
    if (trigger.kind === "acknowledgement") {
      const m = this.message(tx, trigger.messageId);
      if (!m) return { skip: "not_found" };
      if (m.sender === this.deps.settings.get("slack.selfUserId")) return { skip: "self" };
      const done = tx
        .select({ id: autoReplies.id })
        .from(autoReplies)
        .where(
          and(
            eq(autoReplies.kind, "acknowledgement"),
            eq(autoReplies.sourceMessageId, trigger.messageId),
          ),
        )
        .get();
      if (done) return { skip: "already_evaluated" };
      return {
        candidate: {
          sessionId: session.id,
          kind: "acknowledgement",
          recipient: m.sender,
          conversationExternalId: m.conversationExternalId,
          threadTs: m.threadTs ?? m.ts,
          sourceMessageId: m.id,
          followupId: null,
        },
        missing: m.text === null,
        incomingText: m.text,
        incomingFlagged: this.deps.securityFlags.hasOpenFlag(m.id, "warning"),
        text: ACK_TEXT,
        confidence: null,
        originMessageId: null,
      };
    }
    const f = tx.select().from(followups).where(eq(followups.id, trigger.followupId)).get();
    if (!f) return { skip: "not_found" };
    const origin = trigger.kind === "stalled_reminder" ? "stalled" : "spec_clarity";
    if (f.origin !== origin) return { skip: "kind_mismatch" };
    if (f.status !== "draft") return { skip: "not_draft" };
    const done = tx
      .select({ id: autoReplies.id })
      .from(autoReplies)
      .where(eq(autoReplies.followupId, f.id))
      .get();
    if (done) return { skip: "already_evaluated" };
    // R15: the follow-up stores the internal conversation id (older rows: the external one).
    const conv = tx
      .select({ externalId: slackConversations.externalId })
      .from(slackConversations)
      .where(
        or(
          eq(slackConversations.id, f.conversationId),
          eq(slackConversations.externalId, f.conversationId),
        ),
      )
      .get();
    const incoming = f.originMessageId === null ? null : this.message(tx, f.originMessageId);
    const missing =
      f.recipientSlackUserId === null ||
      conv === undefined ||
      f.draftText === null ||
      (f.originMessageId !== null && (incoming === null || incoming.text === null));
    return {
      candidate: {
        sessionId: session.id,
        kind: trigger.kind,
        // NOT NULL columns: a missing recipient or conversation is recorded as held (missing_context).
        recipient: f.recipientSlackUserId ?? "",
        conversationExternalId: conv?.externalId ?? f.conversationId,
        threadTs: f.threadTs,
        sourceMessageId: f.originMessageId,
        followupId: f.id,
      },
      missing,
      incomingText: incoming?.text ?? null,
      incomingFlagged:
        f.originMessageId === null
          ? false
          : this.deps.securityFlags.hasOpenFlag(f.originMessageId, "warning"),
      text: f.draftText ?? "",
      confidence: f.confidence,
      originMessageId: incoming ? incoming.id : null,
    };
  }

  private decideAndRecord(
    tx: DbOrTx,
    r: Exclude<Resolved, { skip: SkipReason }>,
  ): AutoReplyOutcome {
    const { settings, clock, people } = this.deps;
    const c = r.candidate;
    if (r.missing) return this.recordHold(tx, c, "missing_context");
    const now = isoNow(clock);
    const since = new Date(clock.now().getTime() - DAY_MS).toISOString();
    // A5: rolling 24 h per recipient, and the latest send in this conversation and thread.
    const [{ n }] = tx
      .select({ n: sql<number>`count(*)` })
      .from(autoReplies)
      .where(
        and(
          eq(autoReplies.recipientSlackUserId, c.recipient),
          eq(autoReplies.decision, "sent"),
          gt(autoReplies.createdAt, since),
        ),
      )
      .all() as [{ n: number }];
    const last = tx
      .select({ createdAt: autoReplies.createdAt })
      .from(autoReplies)
      .where(
        and(
          eq(autoReplies.conversationExternalId, c.conversationExternalId),
          c.threadTs === null ? isNull(autoReplies.threadTs) : eq(autoReplies.threadTs, c.threadTs),
          eq(autoReplies.decision, "sent"),
        ),
      )
      .orderBy(desc(autoReplies.createdAt))
      .limit(1)
      .get();
    const decision = decideAutoReply({
      awayOn: settings.get("autoReply.awayMode"),
      kind: c.kind,
      allowedKinds: settings.get("autoReply.allowedKinds"),
      recipientPriority: people.getPriorityBySlackUser(c.recipient).priority,
      incomingText: r.incomingText,
      incomingFlagged: r.incomingFlagged,
      sentToRecipientLast24h: n,
      lastSentInThreadAt: last?.createdAt ?? null,
      now,
      confidence: r.confidence,
      candidateText: r.text,
      maxPerDay: settings.get("autoReply.maxPerPersonPerDay"),
      minGapMinutes: settings.get("autoReply.minMinutesBetweenInThread"),
      minConfidence: settings.get("autoReply.minConfidence"),
    });
    if (!decision.send) return this.recordHold(tx, c, decision.reason);

    // A10: the tag is added in code just before the send is requested.
    const tagged = withAutoReplyTag(r.text);
    const autoReplyId = newId();
    tx.insert(autoReplies)
      .values({
        id: autoReplyId,
        ...this.columns(c),
        decision: "sent",
        text: tagged,
        createdAt: now,
      })
      .run();
    try {
      // Also moves a linked follow-up out of `draft` (awaiting_approval, linked ids).
      const sent = this.deps.outgoing.requestAutoSend(tx, {
        autoReplyId,
        conversationExternalId: c.conversationExternalId,
        threadTs: c.threadTs,
        text: tagged,
        followupId: c.followupId,
      });
      return { status: "sent", autoReplyId, ...sent };
    } catch (e) {
      if (e instanceof AutoReplyDisabledByPermission) {
        throw new HoldAfterRollback(c, "policy_disabled");
      }
      if (e instanceof AutoSendBlocked) throw new HoldAfterRollback(c, "away_off");
      throw e;
    }
  }

  /** A16: a held row keeps no text (a follow-up draft stays in its follow-up for the user). */
  private recordHold(tx: DbOrTx, c: Candidate, reason: HoldReason): AutoReplyOutcome {
    const autoReplyId = newId();
    tx.insert(autoReplies)
      .values({
        id: autoReplyId,
        ...this.columns(c),
        decision: "held",
        reason,
        text: null,
        createdAt: isoNow(this.deps.clock),
      })
      .run();
    this.deps.events.publish(tx, {
      type: "autoreply.held",
      aggregateType: "auto_reply",
      aggregateId: autoReplyId,
      correlationId: newId(),
      payload: { autoReplyId, reason },
    });
    return { status: "held", autoReplyId, reason };
  }

  private columns(c: Candidate) {
    return {
      sessionId: c.sessionId,
      kind: c.kind,
      recipientSlackUserId: c.recipient,
      conversationExternalId: c.conversationExternalId,
      threadTs: c.threadTs,
      sourceMessageId: c.sourceMessageId,
      followupId: c.followupId,
    };
  }

  private message(tx: DbOrTx, messageId: string) {
    return (
      tx
        .select({
          id: slackMessages.id,
          ts: slackMessages.ts,
          threadTs: slackMessages.threadTs,
          text: slackMessages.text,
          sender: slackUsers.externalId,
          conversationExternalId: slackConversations.externalId,
        })
        .from(slackMessages)
        .innerJoin(slackUsers, eq(slackUsers.id, slackMessages.senderUserId))
        .innerJoin(slackConversations, eq(slackConversations.id, slackMessages.conversationId))
        .where(eq(slackMessages.id, messageId))
        .get() ?? null
    );
  }

  private openSession(tx: DbOrTx) {
    return tx.select().from(awaySessions).where(isNull(awaySessions.endedAt)).get();
  }

  private publishAway(tx: DbOrTx, sessionId: string, on: boolean): void {
    this.deps.events.publish(tx, {
      type: "away.changed",
      aggregateType: "away_session",
      aggregateId: sessionId,
      correlationId: newId(),
      payload: { on },
    });
  }
}
