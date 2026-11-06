import type {
  AutoReplyKind,
  AutoReplyView,
  AwayDigest,
  DomainEvent,
  HoldReason,
} from "@synapse/contracts";
import { type Db, type DbOrTx, schema } from "@synapse/database";
import { type Clock, isoNow, newId } from "@synapse/shared";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { AutoReplyDisabledByPermission } from "../../core/approvals/approvals";
import type { AuditLogger } from "../../core/audit/audit";
import type { SettingsService } from "../../core/config/settings";
import type { EventPublisher } from "../../core/events/publisher";
import type { JobQueue } from "../../core/jobs/queue";
import { codeBlockCheck } from "../../intelligence/auto-reply/content-checks";
import { mentionedIds } from "../../intelligence/commitments/validate";
import type { CodeAnswerService } from "../code-answers/service";
import { AutoSendBlocked, type OutgoingService } from "../outgoing/service";
import type { PeopleService } from "../people/service";
import type { SecurityFlagsService } from "../security-flags/service";
import { ACK_TEXT, decideAutoReply, withAutoReplyTag } from "./policy";

const {
  awaySessions,
  autoReplies,
  commitmentSources,
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
  | { kind: "stalled_reminder" | "followup_question"; followupId: string }
  | { kind: "code_answer"; codeAnswerId: string };

/** Why nothing was recorded at all (not a policy decision). */
export type SkipReason =
  | "away_off"
  | "not_found"
  | "self"
  | "not_draft"
  | "kind_mismatch"
  | "not_ready"
  | "already_evaluated";

export type AutoReplyOutcome =
  | { status: "sent"; autoReplyId: string; outgoingId: string; approvalId: string }
  | { status: "held"; autoReplyId: string; reason: HoldReason }
  | { status: "skipped"; reason: SkipReason };

/** C6 pre-check for the away code-answer trigger; `sender` and `text` only when it passes. */
export type CodeAnswerPreCheck =
  | { ok: true; sender: string; text: string }
  | {
      ok: false;
      reason:
        | "away_off"
        | "not_found"
        | "self"
        | "no_text"
        | "not_addressed"
        | "before_session"
        | "already_answered";
    };

/** Code-answer rows the away decision runs on (C7). */
const DECIDABLE_CODE_ANSWER = ["ready", "not_answerable", "unverified"] as const;

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
  securityFlags: Pick<SecurityFlagsService, "hasOpenFlag" | "hasOpenRunFlag">;
  /** `requestSend` turns a `code_answer_review` hold into a normal user approval (C7). */
  outgoing: Pick<OutgoingService, "requestAutoSend" | "requestSend">;
  codeAnswers: Pick<CodeAnswerService, "get" | "markDecided">;
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
  /** Kind `code_answer`: the row decided on; `ready` rows become `held` or `sent`. */
  codeAnswer: { id: string; ready: boolean } | null;
}

type Resolved =
  | { skip: SkipReason }
  | {
      candidate: Candidate;
      /** Set when the reply cannot be built safely (A16 `missing_context`). */
      missing: boolean;
      /** A DM reply whose recipient is not the DM partner. */
      recipientMismatch: boolean;
      /** Pre-checks (Phase 6b final review), recorded in this order after the two above. */
      notAddressed: boolean;
      beforeSession: boolean;
      alreadyAnswered: boolean;
      /** C7: a `not_answerable` or `unverified` code answer holds with its status. */
      codeAnswerHold: "not_answerable" | "unverified" | null;
      injectionSuspected: boolean;
      conversationType: "im" | "mpim" | "channel" | null;
      incomingText: string | null;
      incomingFlagged: boolean;
      text: string;
      confidence: number | null;
      originMessageId: string | null;
      /** The candidate's session is the open one (always, except for a code answer). */
      sessionOpen: boolean;
    };

interface SourceMessage {
  id: string;
  ts: string;
  threadTs: string | null;
  text: string | null;
  sentAt: string;
  sender: string;
  conversationId: string;
  conversationType: "im" | "mpim" | "channel";
  conversationExternalId: string;
}

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
    const id =
      trigger.kind === "acknowledgement"
        ? trigger.messageId
        : trigger.kind === "code_answer"
          ? trigger.codeAnswerId
          : trigger.followupId;
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
   * C6: the away code-answer trigger's pre-check on an incoming message, with the same rules as the
   * acknowledgement pre-checks, in the order `not_addressed` > `before_session` >
   * `already_answered`. Reads only; the decision (C7) runs them again.
   */
  codeAnswerPreCheck(tx: DbOrTx, messageId: string): CodeAnswerPreCheck {
    if (!this.deps.settings.get("autoReply.awayMode")) return { ok: false, reason: "away_off" };
    const session = this.openSession(tx);
    if (!session) return { ok: false, reason: "away_off" };
    const m = this.message(tx, messageId);
    if (!m) return { ok: false, reason: "not_found" };
    if (m.sender === this.deps.settings.get("slack.selfUserId")) {
      return { ok: false, reason: "self" };
    }
    if (m.text === null || m.text === "") return { ok: false, reason: "no_text" };
    if (!this.addressedToSelf(tx, m)) return { ok: false, reason: "not_addressed" };
    if (m.sentAt < session.startedAt) return { ok: false, reason: "before_session" };
    if (this.answeredBySelf(tx, m)) return { ok: false, reason: "already_answered" };
    return { ok: true, sender: m.sender, text: m.text };
  }

  /**
   * Runs the policy for one trigger: the resolve, the A5 cap counts, the decision and the record
   * (plus, on send, the policy-approved send request) are one immediate transaction. A shut
   * permission gate or a closed session at request time rolls that back and records a hold in a new
   * transaction; any other error propagates (the job retries).
   */
  evaluate(trigger: Trigger): AutoReplyOutcome {
    const { db } = this.deps;
    try {
      return db.transaction(
        (tx): AutoReplyOutcome => {
          const resolved = this.resolve(tx, trigger);
          if ("skip" in resolved) return { status: "skipped", reason: resolved.skip };
          return this.decideAndRecord(tx, resolved);
        },
        { behavior: "immediate" },
      );
    } catch (e) {
      if (!(e instanceof HoldAfterRollback)) throw e;
      return db.transaction((tx) => this.recordHold(tx, e.candidate, e.reason), {
        behavior: "immediate",
      });
    }
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
            : conv?.type === "mpim"
              ? "Group DM"
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

  /**
   * Retention (final review, item 6): clears `auto_replies.text` on rows created more than
   * `olderThanDays` ago. Run by the Slack content-retention job. Returns the number cleared.
   */
  expireText(olderThanDays: number): number {
    const { db, clock } = this.deps;
    const cutoff = new Date(clock.now().getTime() - olderThanDays * DAY_MS).toISOString();
    return db
      .update(autoReplies)
      .set({ text: null })
      .where(and(lt(autoReplies.createdAt, cutoff), isNotNull(autoReplies.text)))
      .returning({ id: autoReplies.id })
      .all().length;
  }

  private resolve(tx: DbOrTx, trigger: Trigger): Resolved {
    if (trigger.kind === "code_answer") return this.resolveCodeAnswer(tx, trigger.codeAnswerId);
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
        recipientMismatch: this.notDmPartner(tx, m.conversationType, m.conversationId, m.sender),
        notAddressed: !this.addressedToSelf(tx, m),
        beforeSession: m.sentAt < session.startedAt,
        alreadyAnswered: this.answeredBySelf(tx, m),
        codeAnswerHold: null,
        injectionSuspected: false,
        conversationType: m.conversationType,
        candidate: {
          sessionId: session.id,
          kind: "acknowledgement",
          recipient: m.sender,
          conversationExternalId: m.conversationExternalId,
          threadTs: m.threadTs ?? m.ts,
          sourceMessageId: m.id,
          followupId: null,
          codeAnswer: null,
        },
        missing: m.text === null,
        incomingText: m.text,
        incomingFlagged: this.deps.securityFlags.hasOpenFlag(m.id, "warning"),
        text: ACK_TEXT,
        confidence: null,
        originMessageId: null,
        sessionOpen: true,
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
      .select({
        id: slackConversations.id,
        externalId: slackConversations.externalId,
        type: slackConversations.type,
      })
      .from(slackConversations)
      .where(
        or(
          eq(slackConversations.id, f.conversationId),
          eq(slackConversations.externalId, f.conversationId),
        ),
      )
      .get();
    const incoming = f.originMessageId === null ? null : this.message(tx, f.originMessageId);
    // A follow-up question answers its origin message; without one, the before-session and
    // already-answered checks cannot run, so it holds as missing_context.
    const missing =
      f.recipientSlackUserId === null ||
      conv === undefined ||
      f.draftText === null ||
      (trigger.kind === "followup_question" && f.originMessageId === null) ||
      (f.originMessageId !== null && (incoming === null || incoming.text === null));
    // Final review: a stalled reminder has no source message to have arrived early or been answered.
    const question = trigger.kind === "followup_question" && incoming !== null;
    // A3 extension (Phase 6b review): a model-drafted follow-up is held as `flagged` when any open
    // warning-or-higher flag touches what the draft was built from: the drafting run, the origin
    // message, or (stalled) any source message of its commitment.
    // Final review: also any message fed into the drafting prompt (`context_message_ids`). Rows
    // drafted before migration 0014 have none recorded, so only the other checks apply to them.
    const flagged =
      (f.claudeRunId !== null &&
        this.deps.securityFlags.hasOpenRunFlag(f.claudeRunId, "warning")) ||
      (f.originMessageId !== null &&
        this.deps.securityFlags.hasOpenFlag(f.originMessageId, "warning")) ||
      (trigger.kind === "stalled_reminder" &&
        f.commitmentId !== null &&
        this.sourceMessageIds(tx, f.commitmentId).some((id) =>
          this.deps.securityFlags.hasOpenFlag(id, "warning"),
        )) ||
      (f.contextMessageIds ?? []).some((id) => this.deps.securityFlags.hasOpenFlag(id, "warning"));
    return {
      recipientMismatch:
        conv !== undefined &&
        f.recipientSlackUserId !== null &&
        this.notDmPartner(tx, conv.type, conv.id, f.recipientSlackUserId),
      notAddressed: false,
      beforeSession: question && incoming.sentAt < session.startedAt,
      alreadyAnswered: question && this.answeredBySelf(tx, incoming),
      codeAnswerHold: null,
      injectionSuspected: f.suspectedInjection,
      conversationType: conv?.type ?? null,
      candidate: {
        sessionId: session.id,
        kind: trigger.kind,
        // NOT NULL columns: a missing recipient or conversation is recorded as held (missing_context).
        recipient: f.recipientSlackUserId ?? "",
        conversationExternalId: conv?.externalId ?? f.conversationId,
        threadTs: f.threadTs,
        sourceMessageId: f.originMessageId,
        followupId: f.id,
        codeAnswer: null,
      },
      missing,
      incomingText: incoming?.text ?? null,
      incomingFlagged: flagged,
      text: f.draftText ?? "",
      confidence: f.confidence,
      originMessageId: incoming ? incoming.id : null,
      sessionOpen: true,
    };
  }

  /**
   * C7: an away code answer is decided in the away session it was created in. If the user came back
   * meanwhile, that session is closed: the decision still records a row there (held, `away_off`
   * unless an earlier check holds), so it shows in the return digest, and nothing is sent.
   */
  private resolveCodeAnswer(tx: DbOrTx, codeAnswerId: string): Resolved {
    const a = this.deps.codeAnswers.get(codeAnswerId, tx);
    if (!a) return { skip: "not_found" };
    if (a.trigger !== "away") return { skip: "kind_mismatch" };
    if (a.autoReplyId !== null) return { skip: "already_evaluated" };
    const status = a.status;
    if (!DECIDABLE_CODE_ANSWER.some((s) => s === status)) return { skip: "not_ready" };
    const session = tx
      .select()
      .from(awaySessions)
      .where(lte(awaySessions.startedAt, a.createdAt))
      .orderBy(desc(awaySessions.startedAt))
      .limit(1)
      .get();
    if (!session) return { skip: "away_off" };
    const m = this.message(tx, a.messageId);
    if (!m) return { skip: "not_found" };
    if (m.sender === this.deps.settings.get("slack.selfUserId")) return { skip: "self" };
    const ready = status === "ready";
    return {
      recipientMismatch: this.notDmPartner(tx, m.conversationType, m.conversationId, m.sender),
      notAddressed: !this.addressedToSelf(tx, m),
      beforeSession: m.sentAt < session.startedAt,
      alreadyAnswered: this.answeredBySelf(tx, m),
      codeAnswerHold: status === "not_answerable" || status === "unverified" ? status : null,
      injectionSuspected: a.suspectedInjection?.detected === true,
      conversationType: m.conversationType,
      candidate: {
        sessionId: session.id,
        kind: "code_answer",
        recipient: m.sender,
        conversationExternalId: m.conversationExternalId,
        threadTs: m.threadTs ?? m.ts,
        sourceMessageId: m.id,
        followupId: null,
        codeAnswer: { id: a.id, ready },
      },
      missing: m.text === null || (ready && (a.answer === null || a.answer.trim() === "")),
      incomingText: m.text,
      incomingFlagged: this.deps.securityFlags.hasOpenFlag(m.id, "warning"),
      text: a.answer ?? "",
      confidence: a.confidence,
      originMessageId: null,
      sessionOpen: session.endedAt === null,
    };
  }

  /**
   * Final review, item 1: an acknowledgement goes only to a message addressed to the user: a DM or
   * group DM, a message that mentions the user (`<@SELF>`, `<@SELF|name>` or escaped), or a reply in
   * a thread where the user posted before it. Unknown self id: not addressed (holds).
   */
  private addressedToSelf(tx: DbOrTx, m: SourceMessage): boolean {
    if (m.conversationType === "im" || m.conversationType === "mpim") return true;
    const self = this.deps.settings.get("slack.selfUserId");
    if (!self) return false;
    if (m.text !== null && mentionedIds(m.text).includes(self)) return true;
    const thread = m.threadTs ?? m.ts;
    return (
      this.selfMessage(
        tx,
        self,
        and(
          eq(slackMessages.conversationId, m.conversationId),
          or(eq(slackMessages.threadTs, thread), eq(slackMessages.ts, thread)),
          lt(slackMessages.sentAt, m.sentAt),
        ),
      ) !== undefined
    );
  }

  /**
   * Final review, item 2: the user posted after the source message (at the same instant counts:
   * holds more) in its thread, or anywhere in a DM or group DM. Unknown self id: answered (holds).
   */
  private answeredBySelf(tx: DbOrTx, m: SourceMessage): boolean {
    const self = this.deps.settings.get("slack.selfUserId");
    if (!self) return true;
    const thread = m.threadTs ?? m.ts;
    return (
      this.selfMessage(
        tx,
        self,
        and(
          eq(slackMessages.conversationId, m.conversationId),
          ne(slackMessages.id, m.id),
          gte(slackMessages.sentAt, m.sentAt),
          m.conversationType === "channel"
            ? or(eq(slackMessages.threadTs, thread), eq(slackMessages.ts, thread))
            : undefined,
        ),
      ) !== undefined
    );
  }

  private selfMessage(tx: DbOrTx, self: string, where: ReturnType<typeof and>) {
    return tx
      .select({ id: slackMessages.id })
      .from(slackMessages)
      .innerJoin(slackUsers, eq(slackUsers.id, slackMessages.senderUserId))
      .where(and(eq(slackUsers.externalId, self), where))
      .limit(1)
      .get();
  }

  private sourceMessageIds(tx: DbOrTx, commitmentId: string): string[] {
    return tx
      .select({ messageId: commitmentSources.messageId })
      .from(commitmentSources)
      .where(
        and(
          eq(commitmentSources.commitmentId, commitmentId),
          isNotNull(commitmentSources.messageId),
        ),
      )
      .all()
      .map((r) => r.messageId as string);
  }

  /**
   * Defensive DM membership: in an `im` the recipient must be the DM partner, by the inbox rule
   * (the first non-self sender). A DM without a known partner, or without a known self id, cannot
   * be verified, so it counts as a mismatch (a false hold costs little).
   */
  private notDmPartner(
    tx: DbOrTx,
    type: "im" | "mpim" | "channel",
    conversationId: string,
    recipient: string,
  ): boolean {
    if (type !== "im") return false;
    const self = this.deps.settings.get("slack.selfUserId");
    if (!self) return true;
    const partner = tx
      .select({ id: slackUsers.externalId })
      .from(slackMessages)
      .innerJoin(slackUsers, eq(slackUsers.id, slackMessages.senderUserId))
      .where(and(eq(slackMessages.conversationId, conversationId), ne(slackUsers.externalId, self)))
      .orderBy(asc(slackMessages.sentAt), sql`${slackMessages}.rowid ASC`)
      .limit(1)
      .get();
    return partner?.id !== recipient;
  }

  private decideAndRecord(
    tx: DbOrTx,
    r: Exclude<Resolved, { skip: SkipReason }>,
  ): AutoReplyOutcome {
    const { settings, clock, people } = this.deps;
    const c = r.candidate;
    if (r.missing) return this.recordHold(tx, c, "missing_context");
    if (r.recipientMismatch) return this.recordHold(tx, c, "recipient_mismatch");
    if (r.notAddressed) return this.recordHold(tx, c, "not_addressed");
    if (r.beforeSession) return this.recordHold(tx, c, "before_session");
    if (r.alreadyAnswered) return this.recordHold(tx, c, "already_answered");
    if (r.codeAnswerHold) return this.recordHold(tx, c, r.codeAnswerHold);
    if (r.injectionSuspected) return this.recordHold(tx, c, "injection_suspected");
    if (c.kind === "code_answer") {
      // C7: before the normal policy order (which repeats the confidence check harmlessly).
      if (r.confidence === null || r.confidence < settings.get("autoReply.minConfidence")) {
        return this.recordHold(tx, c, "low_confidence");
      }
      const block = codeBlockCheck(r.text);
      if (block) return this.recordHold(tx, c, block);
    }
    // Controller ruling (Task 10 fix 1): the A5 caps bound unapproved sends. A code answer that
    // will become a user approval anyway (autoSend off) is not stopped by them.
    const reviewOnly = c.kind === "code_answer" && !settings.get("codeAnswer.away.autoSend");
    const now = isoNow(clock);
    const since = new Date(clock.now().getTime() - DAY_MS).toISOString();
    // A5: rolling 24 h per recipient, and the latest send in this conversation and thread. In a DM
    // the gap is per conversation (Phase 6b review): a thread there reaches the same person.
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
          r.conversationType === "im"
            ? undefined
            : c.threadTs === null
              ? isNull(autoReplies.threadTs)
              : eq(autoReplies.threadTs, c.threadTs),
          eq(autoReplies.decision, "sent"),
        ),
      )
      .orderBy(desc(autoReplies.createdAt))
      .limit(1)
      .get();
    const decision = decideAutoReply({
      awayOn: settings.get("autoReply.awayMode") && r.sessionOpen,
      kind: c.kind,
      allowedKinds: settings.get("autoReply.allowedKinds"),
      recipientPriority: people.getPriorityBySlackUser(c.recipient).priority,
      incomingText: r.incomingText,
      incomingFlagged: r.incomingFlagged,
      sentToRecipientLast24h: reviewOnly ? 0 : n,
      lastSentInThreadAt: reviewOnly ? null : (last?.createdAt ?? null),
      now,
      confidence: r.confidence,
      candidateText: r.text,
      maxPerDay: settings.get("autoReply.maxPerPersonPerDay"),
      minGapMinutes: settings.get("autoReply.minMinutesBetweenInThread"),
      minConfidence: settings.get("autoReply.minConfidence"),
    });
    if (!decision.send) {
      const held = this.recordHold(tx, c, decision.reason);
      // A6: a low-confidence follow-up question is answered by an acknowledgement of its origin
      // message instead, queued in this transaction as its own retried, deduplicated job (the key
      // matches the urgent trigger's). A stalled reminder has no incoming message to acknowledge.
      if (
        c.kind === "followup_question" &&
        decision.reason === "low_confidence" &&
        r.originMessageId !== null
      ) {
        this.enqueue(tx, { kind: "acknowledgement", messageId: r.originMessageId });
      }
      return held;
    }
    // C7/C8: a code answer is auto-sent only when the user turned `codeAnswer.away.autoSend` on.
    // Otherwise it becomes a normal send approval for the user: exact text, no tag.
    if (reviewOnly) return this.recordReviewHold(tx, c, r.text);

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
      if (c.codeAnswer) {
        this.deps.codeAnswers.markDecided(tx, c.codeAnswer.id, {
          autoReplyId,
          status: "sent",
          outgoingId: sent.outgoingId,
        });
      }
      return { status: "sent", autoReplyId, ...sent };
    } catch (e) {
      if (e instanceof AutoReplyDisabledByPermission) {
        throw new HoldAfterRollback(c, "policy_disabled");
      }
      if (e instanceof AutoSendBlocked) throw new HoldAfterRollback(c, "away_off");
      throw e;
    }
  }

  /**
   * A16: a held row keeps no text (a follow-up draft stays in its follow-up for the user; a code
   * answer stays in its row, which becomes `held` when it was `ready`).
   */
  private recordHold(tx: DbOrTx, c: Candidate, reason: HoldReason): AutoReplyOutcome {
    const autoReplyId = this.insertHold(tx, c, reason);
    if (c.codeAnswer) {
      this.deps.codeAnswers.markDecided(
        tx,
        c.codeAnswer.id,
        c.codeAnswer.ready ? { autoReplyId, status: "held" } : { autoReplyId },
      );
    }
    return { status: "held", autoReplyId, reason };
  }

  /**
   * C7 `code_answer_review`: the held row, plus a normal pending `slack.send` approval for the user
   * with the exact answer, to the asker's conversation and thread (no tag: the user sends it). The
   * outgoing and approval ids are linked on the held row so the digest shows its delivery.
   */
  private recordReviewHold(tx: DbOrTx, c: Candidate, text: string): AutoReplyOutcome {
    const reason: HoldReason = "code_answer_review";
    const autoReplyId = this.insertHold(tx, c, reason);
    const requested = this.deps.outgoing.requestSend(tx, {
      followupId: null,
      conversationExternalId: c.conversationExternalId,
      threadTs: c.threadTs,
      text,
      requestedByModule: "code-answer",
    });
    tx.update(autoReplies)
      .set({ outgoingId: requested.outgoingId, approvalId: requested.approvalId })
      .where(eq(autoReplies.id, autoReplyId))
      .run();
    if (c.codeAnswer) {
      this.deps.codeAnswers.markDecided(tx, c.codeAnswer.id, {
        autoReplyId,
        status: "held",
        outgoingId: requested.outgoingId,
      });
    }
    return { status: "held", autoReplyId, reason };
  }

  private insertHold(tx: DbOrTx, c: Candidate, reason: HoldReason): string {
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
    return autoReplyId;
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

  private message(tx: DbOrTx, messageId: string): SourceMessage | null {
    return (
      tx
        .select({
          id: slackMessages.id,
          ts: slackMessages.ts,
          threadTs: slackMessages.threadTs,
          text: slackMessages.text,
          sentAt: slackMessages.sentAt,
          sender: slackUsers.externalId,
          conversationId: slackConversations.id,
          conversationType: slackConversations.type,
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
