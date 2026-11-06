import {
  type Approval,
  AUTO_REPLY_TAG,
  type HoldReason,
  JobError,
  type MessageSink,
  type SendMessageCommand,
  type SendOptions,
  type SendResult,
} from "@synapse/contracts";
import { type Db, type DbOrTx, schema } from "@synapse/database";
import { type Clock, isoNow, newId } from "@synapse/shared";
import { and, eq, inArray, isNotNull, isNull, lt, ne, or } from "drizzle-orm";
import { z } from "zod";
import type { ApprovalEngine } from "../../core/approvals/approvals";
import { APPROVAL_EXECUTE_JOB, registerIntegrationExecutor } from "../../core/approvals/execution";
import type { AuditLogger } from "../../core/audit/audit";
import type { SettingsService } from "../../core/config/settings";
import type { OutboxDispatcher } from "../../core/events/dispatcher";
import type { EventPublisher } from "../../core/events/publisher";
import type { JobQueue } from "../../core/jobs/queue";
import type { NotificationService } from "../../core/notifications/notifications";
import type { SecurityFlagsService } from "../security-flags/service";

const {
  outgoingMessages,
  followups,
  followupHistory,
  approvals: approvalsTable,
  jobs,
  autoReplies,
  awaySessions,
  auditEvents,
} = schema;

export const OUTGOING_VERIFY_JOB = "outgoing.verify";
export const OUTGOING_VERIFY_PRIORITY = 170;
/** A message still `sending` after this long had its executor die or lose its outcome. */
export const SENDING_STALE_MS = 10 * 60_000;
const DECISIONS_CONSUMER = "outgoing.decisions";
const MAX_TEXT = 4000;
const APPROVAL_TTL_MS = 7 * 24 * 3_600_000;
/** Verify searches from this long before the send started (clock skew against Slack's ts). */
const VERIFY_LOOKBACK_MS = 5_000;
const LIVE = ["pending", "sending", "sent_unverified", "needs_attention"] as const;
const TERMINAL_APPROVAL = ["failed", "executed", "revoked", "rejected", "expired"] as const;
/**
 * R20: argument mismatches are detected after the send tool ran, not prevented, so a message with the
 * changed arguments may be in Slack.
 */
const MISMATCH_TITLE = "Send went out with changed arguments — check Slack for a stray message";
const MISMATCH_REASON = "send tool called with changed arguments";

const payloadSchema = z.object({ outgoingId: z.string().min(1) });
const autoPayloadSchema = payloadSchema.extend({ autoReplyId: z.string().min(1) });
const AUTO_SEND_MODULE = "auto-reply";

type Row = typeof schema.outgoingMessages.$inferSelect;
type AutoReplyRow = typeof schema.autoReplies.$inferSelect;
type AuthorisedBy = NonNullable<SendMessageCommand["authorisedBy"]>;
/** A13, the permission gate and M8 staleness: why a policy auto-send may no longer go out. */
type AutoSendBlock = "away_off" | "policy_disabled" | "code_answer_autosend_off" | "stale";

/** The send failure a blocked auto-send ends with. The code-answer switch reuses the policy one. */
const failureOf = (block: AutoSendBlock): SendFailure =>
  block === "code_answer_autosend_off" ? "cancelled_policy_disabled" : `cancelled_${block}`;

/** The hold reason a blocked auto-send leaves on its auto-reply. */
const holdReasonOf = (block: AutoSendBlock): HoldReason =>
  block === "code_answer_autosend_off" ? "code_answer_review" : block;
export type OutgoingStatus = Row["status"];
type FollowupStatus = (typeof schema.followups.$inferSelect)["status"];
export type ResolveDecision = "mark_sent" | "resend" | "discard";

export interface SendRequest {
  followupId: string | null;
  conversationExternalId: string;
  threadTs?: string | null;
  /** The exact text the user approves; only trailing whitespace is trimmed. */
  text: string;
  requestedByModule: string;
}

/** A policy-approved auto-reply (ADR-033). `text` already carries the tag (A10). */
export interface AutoSendRequest {
  autoReplyId: string;
  conversationExternalId: string;
  threadTs: string | null;
  text: string;
  followupId: string | null;
}

export interface SendRequested {
  outgoingId: string;
  approvalId: string;
}

export type SendOutcome =
  | { outgoingId: string; status: "skipped"; reason: string }
  | { outgoingId: string; status: OutgoingStatus };

export interface ResolveResult {
  outgoingId: string;
  status: OutgoingStatus;
  /** Set for `resend`: the new outgoing message and its pending approval. */
  resend?: SendRequested;
}

export class SendAlreadyPending extends Error {
  constructor(readonly followupId: string) {
    super("a send is already pending for this follow-up");
    this.name = "SendAlreadyPending";
  }
}

export class InvalidOutgoingText extends Error {
  constructor() {
    super(`outgoing text must be 1..${MAX_TEXT} characters`);
    this.name = "InvalidOutgoingText";
  }
}

export class MissingAutoReplyTag extends Error {
  constructor() {
    super("auto-reply text must end with the auto-reply tag");
    this.name = "MissingAutoReplyTag";
  }
}

export class AutoReplyNotFound extends Error {
  constructor(readonly autoReplyId: string) {
    super("auto-reply not found");
    this.name = "AutoReplyNotFound";
  }
}

/** I1: a request field differs from its `auto_replies` row. Fixed message; ids only. */
export class AutoSendMismatch extends Error {
  constructor(
    readonly autoReplyId: string,
    readonly field: "conversationExternalId" | "threadTs" | "text" | "followupId",
  ) {
    super("auto-send request does not match its auto-reply");
    this.name = "AutoSendMismatch";
  }
}

/**
 * M2: away is off, or the auto-reply's session is no longer the open one, when the send is
 * requested. Nothing is recorded. (A shut permission gate is `AutoReplyDisabledByPermission`.)
 */
export class AutoSendBlocked extends Error {
  constructor(
    readonly autoReplyId: string,
    readonly reason: "away_off",
  ) {
    super(`auto-send blocked: ${reason}`);
    this.name = "AutoSendBlocked";
  }
}

/** The auto-reply was held, or a send was already requested for it. */
export class AutoReplyNotSendable extends Error {
  constructor(readonly autoReplyId: string) {
    super("auto-reply cannot be sent");
    this.name = "AutoReplyNotSendable";
  }
}

export class FollowupNotFound extends Error {
  constructor(readonly followupId: string) {
    super("follow-up not found");
    this.name = "FollowupNotFound";
  }
}

export class OutgoingNotFound extends Error {
  constructor(readonly outgoingId: string) {
    super("outgoing message not found");
    this.name = "OutgoingNotFound";
  }
}

export class ResolveNotAllowed extends Error {
  constructor(
    readonly outgoingId: string,
    readonly status: OutgoingStatus,
  ) {
    super(`outgoing message in status ${status} cannot be resolved`);
    this.name = "ResolveNotAllowed";
  }
}

/** Fixed reasons only: the engine stores the message in the approval and its audit row. */
export type SendFailure =
  | "tool_error"
  | "no_send"
  | "not_started"
  | "outcome_unrecorded"
  | "invalid_payload"
  | "not_found"
  | "cancelled_away_off"
  | "cancelled_policy_disabled"
  | "cancelled_stale";

export class OutgoingSendError extends Error {
  constructor(readonly failure: SendFailure) {
    super(`slack send failed: ${failure}`);
    this.name = "OutgoingSendError";
  }
}

export interface OutgoingServiceDeps {
  db: Db;
  clock: Clock;
  events: EventPublisher;
  audit: AuditLogger;
  queue: Pick<JobQueue, "enqueue">;
  settings: SettingsService;
  notifications: Pick<NotificationService, "notify">;
  approvals: Pick<
    ApprovalEngine,
    "request" | "recordPolicyApproval" | "revokeAsSystem" | "policyGateOpen"
  >;
  securityFlags: Pick<SecurityFlagsService, "recordRuntimeFlag">;
  sink: MessageSink;
  /** Returns the code answer behind a cancelled `code_answer` auto-send to `held`. */
  codeAnswerHeld?: (tx: DbOrTx, autoReplyId: string) => void;
}

const errorName = (e: unknown) => (e instanceof Error ? e.name : "unknown");

/**
 * Approved Slack sends (Phase 6). A message is sent only by the `slack.send` executor (user
 * approval) or the `slack.auto_reply` executor (ADR-033 policy approval) for its own approval; both
 * share one claim, send, outcome and verify path. It is sent at most once: it is marked `sending`
 * before the sink is called, and nothing ever moves it back to `pending`. Uncertain outcomes are verified by searching Slack, never by re-sending; a
 * second send only happens when the user picks `resend`, which needs a new approval.
 *
 * Text lives only in `outgoing_messages.text`. Audit rows, events, notifications, follow-up history,
 * thrown messages and logs carry ids and fixed reasons only.
 */
export class OutgoingService {
  /**
   * R7 (a): messages whose executor is running in this process. The sweep never touches them, so a
   * send that outlived its job (timeout) can never be handed to the user for a resend while it may
   * still post. A restart clears it, which is exactly when the executor is gone.
   */
  readonly #inFlight = new Set<string>();

  constructor(private readonly deps: OutgoingServiceDeps) {}

  /**
   * Wires the `slack.send`/`slack` and `slack.auto_reply`/`slack` executors and the
   * revoke/reject/expiry consumers.
   */
  register(engine: ApprovalEngine, dispatcher: Pick<OutboxDispatcher, "subscribe">): void {
    // R7 (f): bound privately; only the engine (after its own claim) can run a send.
    registerIntegrationExecutor(engine, "slack.send", "slack", {
      execute: async (a, signal) => this.#execute(a, signal, "user"),
    });
    registerIntegrationExecutor(engine, "slack.auto_reply", "slack", {
      execute: async (a, signal) => this.#execute(a, signal, "policy"),
      revalidate: async (a) => this.#revalidateAutoSend(a),
    });
    const reasons = {
      "approval.revoked": "revoked",
      "approval.rejected": "rejected",
      "approval.expired": "expired",
    } as const;
    for (const [type, reason] of Object.entries(reasons) as [
      keyof typeof reasons,
      (typeof reasons)[keyof typeof reasons],
    ][]) {
      dispatcher.subscribe(type, DECISIONS_CONSUMER, (event, tx) => {
        const approvalId = (event.payload as { approvalId?: unknown }).approvalId;
        if (typeof approvalId !== "string") return;
        try {
          // Savepoint: a failure rolls back this decision only.
          tx.transaction((sp) => this.cancel(sp, approvalId, reason));
        } catch (e) {
          console.error(`outgoing decision failed approval=${approvalId} error=${errorName(e)}`);
        }
      });
    }
  }

  /** Records a send and requests its approval, inside the caller's transaction. */
  requestSend(tx: DbOrTx, input: SendRequest): SendRequested {
    const { clock, approvals } = this.deps;
    return this.#record(tx, input, "send_requested", (outgoingId) =>
      approvals.request(tx, {
        action: "slack.send",
        targetIntegration: "slack",
        targetRef: input.conversationExternalId,
        payload: { outgoingId },
        riskLevel: "medium",
        idempotencyKey: `outgoing:${outgoingId}`,
        requestedByModule: input.requestedByModule,
        expiresAt: new Date(clock.now().getTime() + APPROVAL_TTL_MS).toISOString(),
      }),
    );
  }

  /**
   * ADR-033: records a policy-approved auto-reply send, inside the caller's transaction, and links
   * it to its `auto_replies` row. The approval is `approved` at once (`decided_by = 'policy'`), so it
   * never pends for the user. Throws `AutoReplyDisabledByPermission` (from the engine) when the user
   * tightened `slack.auto_reply`; the caller's transaction then records nothing.
   */
  requestAutoSend(tx: DbOrTx, input: AutoSendRequest): SendRequested {
    const { clock, approvals } = this.deps;
    if (!input.text.trimEnd().endsWith(AUTO_REPLY_TAG)) throw new MissingAutoReplyTag();
    const ar = tx.select().from(autoReplies).where(eq(autoReplies.id, input.autoReplyId)).get();
    if (!ar) throw new AutoReplyNotFound(input.autoReplyId);
    if (ar.decision !== "sent" || ar.outgoingId !== null) {
      throw new AutoReplyNotSendable(input.autoReplyId);
    }
    // I1: the auto_replies row is what the policy decided on; the request must be exactly it.
    const mismatch = autoSendMismatch(input, ar);
    if (mismatch !== null) throw new AutoSendMismatch(input.autoReplyId, mismatch);
    // M2: away off / another session blocks up front. A shut permission gate is left to
    // recordPolicyApproval, which throws AutoReplyDisabledByPermission (the controller's ruling).
    if (this.autoSendBlock(tx, ar) === "away_off") {
      throw new AutoSendBlocked(input.autoReplyId, "away_off");
    }
    const requested = this.#record(
      tx,
      { ...input, requestedByModule: AUTO_SEND_MODULE },
      "auto_send_requested",
      (outgoingId) =>
        approvals.recordPolicyApproval(
          tx,
          {
            action: "slack.auto_reply",
            targetIntegration: "slack",
            targetRef: input.conversationExternalId,
            payload: { outgoingId, autoReplyId: input.autoReplyId },
            riskLevel: "medium",
            idempotencyKey: `auto-reply:${input.autoReplyId}`,
            requestedByModule: AUTO_SEND_MODULE,
            expiresAt: new Date(clock.now().getTime() + APPROVAL_TTL_MS).toISOString(),
          },
          "auto_reply_policy",
        ),
    );
    tx.update(autoReplies)
      .set({ outgoingId: requested.outgoingId, approvalId: requested.approvalId })
      .where(eq(autoReplies.id, input.autoReplyId))
      .run();
    return requested;
  }

  /** The outgoing row and follow-up link shared by user and policy sends. */
  #record(
    tx: DbOrTx,
    input: SendRequest,
    historyEvent: "send_requested" | "auto_send_requested",
    approve: (outgoingId: string) => Approval,
  ): SendRequested {
    const { clock } = this.deps;
    const text = input.text.trimEnd();
    if (text.length < 1 || text.length > MAX_TEXT) throw new InvalidOutgoingText();
    const followupId = input.followupId;
    if (followupId !== null) {
      const f = tx
        .select({ id: followups.id })
        .from(followups)
        .where(eq(followups.id, followupId))
        .get();
      if (!f) throw new FollowupNotFound(followupId);
      const live = tx
        .select({ id: outgoingMessages.id })
        .from(outgoingMessages)
        .where(
          and(eq(outgoingMessages.followupId, followupId), inArray(outgoingMessages.status, LIVE)),
        )
        .get();
      if (live) throw new SendAlreadyPending(followupId);
    }
    const outgoingId = newId();
    const now = isoNow(clock);
    const approval = approve(outgoingId);
    tx.insert(outgoingMessages)
      .values({
        id: outgoingId,
        approvalId: approval.id,
        followupId,
        conversationExternalId: input.conversationExternalId,
        threadTs: input.threadTs ?? null,
        text,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    this.statusChanged(tx, outgoingId, "pending");
    if (followupId !== null) {
      tx.update(followups)
        .set({ status: "awaiting_approval", approvalId: approval.id, outgoingId, updatedAt: now })
        .where(eq(followups.id, followupId))
        .run();
      this.followupEvent(tx, followupId, "awaiting_approval", historyEvent, outgoingId);
    }
    return { outgoingId, approvalId: approval.id };
  }

  /**
   * A13: the `slack.auto_reply` revalidation, before the engine's claim. False (and nothing is
   * sent) unless away mode is on, the auto-reply's session is the open one, and the policy gate is
   * open. On false the approval is revoked and the auto-reply held, in one transaction.
   */
  #revalidateAutoSend(a: Approval): boolean {
    const payload = autoPayloadSchema.safeParse(a.payload);
    // Never run an auto-send whose approval does not name its auto-reply.
    if (!payload.success) return false;
    return this.deps.db.transaction(
      (tx) => {
        const row = tx
          .select()
          .from(outgoingMessages)
          .where(eq(outgoingMessages.id, payload.data.outgoingId))
          .get();
        if (!row) return true;
        const ar = this.autoReplyFor(tx, row.id);
        // I1: the approval must name the auto-reply linked to its message.
        if (!ar || ar.id !== payload.data.autoReplyId) return false;
        const block = this.autoSendBlock(tx, ar);
        if (block === null) return true;
        this.deps.approvals.revokeAsSystem(tx, a.id, block);
        this.holdAutoSend(tx, row, ar, block);
        return false;
      },
      { behavior: "immediate" },
    );
  }

  /**
   * The `slack.send` (authorisedBy user) and `slack.auto_reply` (authorisedBy policy) executor.
   * Throws only `OutgoingSendError` (fixed messages), and only when nothing was sent or the outcome
   * could not be recorded; the engine then fails the approval.
   * `signal` is the `approval.execute` job's: an abort before spawn (still waiting for a Claude
   * slot) makes the sink throw, which is the safe `not_started` outcome.
   */
  async #execute(
    approval: Approval,
    signal: AbortSignal | undefined,
    authorisedBy: AuthorisedBy,
  ): Promise<SendOutcome> {
    const { db } = this.deps;
    const payload = payloadSchema.safeParse(approval.payload);
    if (!payload.success) throw new OutgoingSendError("invalid_payload");
    const { outgoingId } = payload.data;

    // 1. Claim: pending -> sending, committed before the sink is called.
    const claim = db.transaction((tx) => this.claim(tx, approval.id, outgoingId, authorisedBy), {
      behavior: "immediate",
    });
    if ("skip" in claim) return { outgoingId, status: "skipped", reason: claim.skip };
    // The auto-send was cancelled (and the auto-reply held) at the claim: nothing was sent.
    if ("cancel" in claim) throw new OutgoingSendError(claim.cancel);
    const { row, jobId, autoReply } = claim;
    this.#inFlight.add(outgoingId);
    try {
      return await this.#send(
        row,
        jobId,
        signal ?? new AbortController().signal,
        authorisedBy,
        autoReply,
      );
    } finally {
      this.#inFlight.delete(outgoingId);
    }
  }

  async #send(
    row: Row,
    jobId: string | undefined,
    signal: AbortSignal,
    authorisedBy: AuthorisedBy,
    autoReply: AutoReplyRow | undefined,
  ): Promise<SendOutcome> {
    const { db, sink } = this.deps;
    const outgoingId = row.id;
    // I2: a policy send re-checks A13 and the gate once it has a Claude slot, just before spawn.
    const gate: { blocked: AutoSendBlock | null } = { blocked: null };
    const opts: SendOptions | undefined = autoReply
      ? {
          beforeSpawn: () => {
            gate.blocked = this.autoSendBlock(db, autoReply);
            return gate.blocked === null;
          },
        }
      : undefined;
    // 2. Send.
    let result: SendResult;
    try {
      result = await sink.send(
        { ...this.command(row), authorisedBy, ...(jobId !== undefined ? { jobId } : {}) },
        signal,
        opts,
      );
    } catch (e) {
      const blocked = gate.blocked;
      if (
        autoReply &&
        blocked !== null &&
        e instanceof JobError &&
        e.classified.kind === "cancelled_before_spawn"
      ) {
        // Not spawned, so certainly not sent: cancelled and held, never uncertain. If even this
        // write fails, the row stays `sending` and the sweep hands it to the user.
        try {
          db.transaction(
            (tx) => this.holdAutoSend(tx, row, autoReply, blocked, { allowSending: true }),
            { behavior: "immediate" },
          );
        } catch (w) {
          console.error(
            `outgoing outcome not recorded outgoing=${outgoingId} error=${errorName(w)}`,
          );
        }
        throw new OutgoingSendError(failureOf(blocked));
      }
      // The sink rethrows only failures before spawn: nothing was sent. The engine fails the
      // approval for any thrown error, so this send can never run under it again: not_started,
      // and the draft goes back for a new request. If even this write fails, the row stays
      // `sending` and the sweep hands it to the user.
      console.error(`outgoing send not started outgoing=${outgoingId} error=${errorName(e)}`);
      try {
        db.transaction((tx) => this.recordNotStarted(tx, row), { behavior: "immediate" });
      } catch (w) {
        console.error(`outgoing outcome not recorded outgoing=${outgoingId} error=${errorName(w)}`);
      }
      throw new OutgoingSendError("not_started");
    }

    // 3. Record the outcome in a new transaction. On failure the row stays `sending`.
    let recorded: { status: OutgoingStatus; fail?: SendFailure };
    try {
      recorded = db.transaction((tx) => this.recordOutcome(tx, row, result), {
        behavior: "immediate",
      });
    } catch (e) {
      console.error(`outgoing outcome not recorded outgoing=${outgoingId} error=${errorName(e)}`);
      throw new OutgoingSendError("outcome_unrecorded");
    }
    if (recorded.fail) throw new OutgoingSendError(recorded.fail);
    return { outgoingId, status: recorded.status };
  }

  /**
   * One `outgoing.verify` attempt: searches Slack for the message and never sends. Not found or
   * not checkable counts an attempt; the next one is queued until `outgoing.verify.maxAttempts`.
   * R18: an auth pause, quota stop or Slack rate limit from the search is rethrown before anything
   * is written, so the queue defers (or, for rate_limited, retries at Slack's time) the job and no
   * verify attempt is spent. rate_limited is a `retry` decision that spends job attempts, so on the
   * job's last attempt (`lastJobAttempt`) it counts as "could not tell" instead: the row then keeps
   * being verified, or is exhausted for the user, and is never stranded by a parked job.
   */
  async verify(outgoingId: string, opts: { lastJobAttempt?: boolean } = {}): Promise<SendOutcome> {
    const { db, sink, settings, clock } = this.deps;
    const row = db.select().from(outgoingMessages).where(eq(outgoingMessages.id, outgoingId)).get();
    if (!row || !verifiable(row))
      return { outgoingId, status: "skipped", reason: "not_verifiable" };
    const startedMs = Date.parse(row.sendingAt ?? row.createdAt);
    const sinceTs = ((startedMs - VERIFY_LOOKBACK_MS) / 1000).toFixed(6);
    let found: boolean | null;
    try {
      found = await sink.findSent(this.command(row), sinceTs);
    } catch (e) {
      const rateLimited = e instanceof JobError && e.classified.kind === "rate_limited";
      if (!(rateLimited && opts.lastJobAttempt)) throw e;
      found = null;
    }

    return db.transaction(
      (tx): SendOutcome => {
        const cur = tx
          .select()
          .from(outgoingMessages)
          .where(eq(outgoingMessages.id, outgoingId))
          .get();
        // The user resolved it, or another attempt ran, while this one searched.
        if (!cur || cur.status !== row.status || cur.verifyAttempts !== row.verifyAttempts) {
          return { outgoingId, status: "skipped", reason: "changed" };
        }
        const now = isoNow(clock);
        if (found === true) {
          tx.update(outgoingMessages)
            .set({ status: "sent", verifiedAt: now, failure: null, updatedAt: now })
            .where(eq(outgoingMessages.id, outgoingId))
            .run();
          this.statusChanged(tx, outgoingId, "sent");
          if (cur.status !== "sent_unverified") this.autoReplyDelivered(tx, outgoingId);
          this.markFollowupSent(tx, cur, "verified");
          this.auditSend(tx, cur, "slack.verified", "sent");
          return { outgoingId, status: "sent" };
        }
        const attempts = cur.verifyAttempts + 1;
        if (attempts < settings.get("outgoing.verify.maxAttempts")) {
          tx.update(outgoingMessages)
            .set({ verifyAttempts: attempts, updatedAt: now })
            .where(eq(outgoingMessages.id, outgoingId))
            .run();
          this.enqueueVerify(tx, outgoingId, attempts + 1);
          return { outgoingId, status: cur.status };
        }
        // Exhausted: failure `unverified` for both statuses, so neither is verified again.
        const unverified = cur.status === "sent_unverified";
        tx.update(outgoingMessages)
          .set({ verifyAttempts: attempts, failure: "unverified", updatedAt: now })
          .where(eq(outgoingMessages.id, outgoingId))
          .run();
        this.deps.notifications.notify(tx, {
          kind: "outgoing.unverified",
          severity: unverified ? "warning" : "high",
          title: unverified
            ? "Slack send not verified — check Slack"
            : "Slack send outcome unknown — check Slack",
          ref: outgoingId,
        });
        this.auditSend(tx, cur, "slack.verify_exhausted", cur.status, { attempts });
        return { outgoingId, status: cur.status };
      },
      { behavior: "immediate" },
    );
  }

  /**
   * The user's decision on a message whose delivery is unknown or was blocked. Allowed from
   * `needs_attention`, or from `sent_unverified` once verification is exhausted (mark_sent or
   * discard only), and never while its executor is still running.
   */
  resolveNeedsAttention(outgoingId: string, decision: ResolveDecision): ResolveResult {
    const { db, clock, audit } = this.deps;
    return db.transaction(
      (tx): ResolveResult => {
        const row = tx
          .select()
          .from(outgoingMessages)
          .where(eq(outgoingMessages.id, outgoingId))
          .get();
        if (!row) throw new OutgoingNotFound(outgoingId);
        const exhaustedSent = row.status === "sent_unverified" && row.failure === "unverified";
        const allowed =
          (row.status === "needs_attention" || exhaustedSent) && !this.#inFlight.has(outgoingId);
        // The send tool reported success for an exhausted sent_unverified: resend is not offered.
        if (!allowed || (exhaustedSent && decision === "resend")) {
          throw new ResolveNotAllowed(outgoingId, row.status);
        }
        const now = isoNow(clock);
        const set = (status: OutgoingStatus, failure: string | null) => {
          tx.update(outgoingMessages)
            .set({ status, failure, updatedAt: now })
            .where(eq(outgoingMessages.id, outgoingId))
            .run();
          this.statusChanged(tx, outgoingId, status);
        };
        let status: OutgoingStatus;
        let resend: SendRequested | undefined;
        if (decision === "mark_sent") {
          status = "sent";
          set(status, null);
          if (row.status !== "sent_unverified") this.autoReplyDelivered(tx, outgoingId);
          this.markFollowupSent(tx, row, "marked_sent");
        } else if (decision === "discard") {
          status = "failed";
          set(status, "discarded");
          this.moveFollowup(tx, row, "discarded", "discarded");
        } else {
          // Superseded first, so the live-send check lets the new request through.
          status = "failed";
          set(status, "superseded");
          const original = tx
            .select({ module: approvalsTable.requestedByModule })
            .from(approvalsTable)
            .where(eq(approvalsTable.id, row.approvalId))
            .get();
          resend = this.requestSend(tx, {
            followupId: row.followupId,
            conversationExternalId: row.conversationExternalId,
            threadTs: row.threadTs,
            text: row.text,
            requestedByModule: original?.module ?? "outgoing",
          });
        }
        audit.record(tx, {
          actor: "user",
          module: "outgoing",
          action: "outgoing.resolved",
          targetIntegration: "slack",
          targetRef: row.conversationExternalId,
          approvalId: row.approvalId,
          result: status,
          details: {
            outgoingId,
            decision,
            ...(resend ? { newOutgoingId: resend.outgoingId } : {}),
          },
        });
        return { outgoingId, status, ...(resend ? { resend } : {}) };
      },
      { behavior: "immediate" },
    );
  }

  /**
   * Retention (final review, item 6): blanks the text of `sent` and `failed` messages created more
   * than `olderThanDays` ago (the column is NOT NULL, so it becomes ''). Other statuses may still
   * be sent, verified or resent, so they are never touched. Returns the number cleared.
   */
  expireText(olderThanDays: number): number {
    const { db, clock } = this.deps;
    const cutoff = new Date(clock.now().getTime() - olderThanDays * 86_400_000).toISOString();
    return db
      .update(outgoingMessages)
      .set({ text: "" })
      .where(
        and(
          inArray(outgoingMessages.status, ["sent", "failed"]),
          lt(outgoingMessages.createdAt, cutoff),
          ne(outgoingMessages.text, ""),
        ),
      )
      .returning({ id: outgoingMessages.id })
      .all().length;
  }

  /**
   * Recovery sweep (startup and reaper): a message left `sending` for over SENDING_STALE_MS lost its
   * executor or its outcome. It may have been sent, so it goes to the user and is verified.
   */
  recoverySweep(tx: DbOrTx): void {
    const { clock } = this.deps;
    const cutoff = new Date(clock.now().getTime() - SENDING_STALE_MS).toISOString();
    const now = isoNow(clock);
    const stuck = tx
      .select()
      .from(outgoingMessages)
      .where(and(eq(outgoingMessages.status, "sending"), lt(outgoingMessages.sendingAt, cutoff)))
      .all()
      .filter((r) => !this.#inFlight.has(r.id));
    for (const row of stuck) {
      tx.update(outgoingMessages)
        .set({ status: "needs_attention", failure: "uncertain_outcome", updatedAt: now })
        .where(and(eq(outgoingMessages.id, row.id), eq(outgoingMessages.status, "sending")))
        .run();
      this.statusChanged(tx, row.id, "needs_attention");
      this.moveFollowup(tx, row, "needs_attention", "send_recovered");
      this.enqueueVerify(tx, row.id, row.verifyAttempts + 1);
      this.auditSend(tx, row, "slack.send_recovered", "needs_attention");
    }

    // R7 (e): a `pending` row never reached the sink (the claim is what leaves `pending`). When its
    // approval can no longer run it (terminal) or was claimed by an executor that is gone, nothing
    // else will move it: return the draft so the user can request again.
    const stranded = tx
      .select({ row: outgoingMessages, approval: approvalsTable })
      .from(outgoingMessages)
      .innerJoin(approvalsTable, eq(approvalsTable.id, outgoingMessages.approvalId))
      .where(
        and(
          eq(outgoingMessages.status, "pending"),
          lt(outgoingMessages.createdAt, cutoff),
          or(
            inArray(approvalsTable.status, TERMINAL_APPROVAL),
            isNotNull(approvalsTable.executionStartedAt),
          ),
        ),
      )
      .all()
      .filter((r) => !this.#inFlight.has(r.row.id));
    for (const { row, approval } of stranded) {
      const decided = ["revoked", "rejected", "expired"].includes(approval.status);
      const failure = decided ? approval.status : "not_started";
      tx.update(outgoingMessages)
        .set({ status: "failed", failure, updatedAt: now })
        .where(and(eq(outgoingMessages.id, row.id), eq(outgoingMessages.status, "pending")))
        .run();
      this.statusChanged(tx, row.id, "failed");
      this.moveFollowup(tx, row, "draft", "send_stranded");
      this.auditSend(tx, row, "slack.send_stranded", "failed", { failure });
    }
  }

  private claim(
    tx: DbOrTx,
    approvalId: string,
    outgoingId: string,
    authorisedBy: AuthorisedBy,
  ):
    | { skip: string }
    | { cancel: SendFailure }
    | { row: Row; jobId: string | undefined; autoReply?: AutoReplyRow } {
    const row = tx.select().from(outgoingMessages).where(eq(outgoingMessages.id, outgoingId)).get();
    if (!row) throw new OutgoingSendError("not_found");
    if (row.approvalId !== approvalId) return { skip: "approval_mismatch" };
    // R7 (f): only an approved approval that the engine has claimed for execution.
    const approval = tx
      .select({
        status: approvalsTable.status,
        startedAt: approvalsTable.executionStartedAt,
        decidedBy: approvalsTable.decidedBy,
      })
      .from(approvalsTable)
      .where(eq(approvalsTable.id, approvalId))
      .get();
    if (approval?.status !== "approved" || approval.startedAt === null) {
      return { skip: "approval_not_claimed" };
    }
    // A policy send needs a policy approval; a user send never runs on one.
    if ((authorisedBy === "policy") !== (approval.decidedBy === "policy")) {
      return { skip: "approval_kind_mismatch" };
    }
    // Defence in depth on top of the engine's claim: only a pending message is ever sent.
    if (row.status !== "pending") return { skip: `status_${row.status}` };
    let autoReply: AutoReplyRow | undefined;
    if (authorisedBy === "policy") {
      // A13 again, serialised with the away toggle: the user's return wins even after revalidate.
      autoReply = this.autoReplyFor(tx, outgoingId);
      if (!autoReply) return { skip: "auto_reply_missing" };
      const block = this.autoSendBlock(tx, autoReply);
      if (block !== null) {
        this.holdAutoSend(tx, row, autoReply, block);
        return { cancel: failureOf(block) };
      }
    }
    const now = isoNow(this.deps.clock);
    tx.update(outgoingMessages)
      .set({ status: "sending", sendingAt: now, updatedAt: now })
      .where(eq(outgoingMessages.id, outgoingId))
      .run();
    this.statusChanged(tx, outgoingId, "sending");
    this.moveFollowup(tx, row, "sending", "send_started");
    const job = tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(eq(jobs.idempotencyKey, `${APPROVAL_EXECUTE_JOB}:${approvalId}`))
      .get();
    return {
      row: { ...row, status: "sending", sendingAt: now },
      jobId: job?.id,
      ...(autoReply ? { autoReply } : {}),
    };
  }

  private recordOutcome(
    tx: DbOrTx,
    row: Row,
    result: SendResult,
  ): { status: OutgoingStatus; fail?: SendFailure } {
    const { clock, notifications, securityFlags } = this.deps;
    const cur = tx.select().from(outgoingMessages).where(eq(outgoingMessages.id, row.id)).get();
    if (!cur) return { status: "failed" };
    const now = isoNow(clock);
    const runId = result.runId ?? null;
    // R7 (d): normally `sending`; a row the sweep already handed over (needs_attention /
    // uncertain_outcome) still takes the real outcome. Anything else was decided by the user.
    const open =
      cur.status === "sending" ||
      (cur.status === "needs_attention" && cur.failure === "uncertain_outcome");
    if (runId !== null && cur.claudeRunId === null) {
      tx.update(outgoingMessages)
        .set({ claudeRunId: runId })
        .where(eq(outgoingMessages.id, row.id))
        .run();
    }
    const set = (status: OutgoingStatus, failure: string | null, extra: Partial<Row> = {}) => {
      tx.update(outgoingMessages)
        .set({ status, failure, updatedAt: now, ...extra })
        .where(eq(outgoingMessages.id, row.id))
        .run();
      this.statusChanged(tx, row.id, status);
    };

    // R5: changed arguments are never reported as sent and never returned for re-send. The flag
    // and notification are raised whatever state the row reached meanwhile.
    if (result.mismatch === true || result.failure === "argument_mismatch") {
      if (open) {
        set("needs_attention", "argument_mismatch");
        this.moveFollowup(tx, cur, "needs_attention", "send_blocked");
      }
      // The flag is raised even when the follow-up has moved on to another message.
      const origin =
        cur.followupId === null
          ? undefined
          : tx
              .select({ originMessageId: followups.originMessageId })
              .from(followups)
              .where(eq(followups.id, cur.followupId))
              .get();
      if (origin?.originMessageId) {
        securityFlags.recordRuntimeFlag(
          tx,
          [origin.originMessageId],
          runId,
          MISMATCH_REASON,
          "high",
        );
      }
      notifications.notify(tx, {
        kind: "outgoing.blocked",
        severity: "high",
        title: MISMATCH_TITLE,
        ref: row.id,
      });
      this.auditSend(tx, cur, "slack.send_blocked", "needs_attention", { runId });
      return { status: open ? "needs_attention" : cur.status };
    }
    if (!open) return { status: cur.status };
    if (result.status === "sent_unverified") {
      set("sent_unverified", null, { sentAt: now });
      // `open` is sending/needs_attention: never delivered before, so this is the first time.
      this.autoReplyDelivered(tx, row.id);
      // Idempotent key: a verify the sweep already queued for this attempt is reused.
      this.enqueueVerify(tx, row.id, cur.verifyAttempts + 1);
      this.markFollowupSent(tx, cur, "sent");
      this.auditSend(tx, cur, "slack.sent", "sent_unverified", { runId });
      return { status: "sent_unverified" };
    }
    // R7 (g): only an explicit definitive failure returns the draft; anything else may have posted.
    if (
      result.status === "failed" &&
      (result.failure === "tool_error" || result.failure === "no_send")
    ) {
      const failure: SendFailure = result.failure;
      set("failed", failure);
      this.moveFollowup(tx, cur, "draft", "send_failed");
      this.auditSend(tx, cur, "slack.send_failed", "failed", { runId, failure });
      return { status: "failed", fail: failure };
    }
    if (cur.status === "sending") {
      set("needs_attention", "uncertain_outcome");
      this.enqueueVerify(tx, row.id, cur.verifyAttempts + 1);
      this.moveFollowup(tx, cur, "needs_attention", "send_uncertain");
    }
    this.auditSend(tx, cur, "slack.send_uncertain", "needs_attention", { runId });
    return { status: "needs_attention" };
  }

  private recordNotStarted(tx: DbOrTx, row: Row): void {
    const now = isoNow(this.deps.clock);
    const updated = tx
      .update(outgoingMessages)
      .set({ status: "failed", failure: "not_started", updatedAt: now })
      .where(and(eq(outgoingMessages.id, row.id), eq(outgoingMessages.status, "sending")))
      .returning({ id: outgoingMessages.id })
      .all();
    if (updated.length === 0) return;
    this.statusChanged(tx, row.id, "failed");
    this.moveFollowup(tx, row, "draft", "send_not_started");
    this.auditSend(tx, row, "slack.send_failed", "failed", { failure: "not_started" });
  }

  /**
   * revoke/reject/expiry of a slack.send or slack.auto_reply approval whose message has not
   * started. An auto-send whose gate is shut (away off, new session, permission tightened) is held
   * with that reason; otherwise (user revoke, expiry) the message just fails with the decision.
   */
  private cancel(tx: DbOrTx, approvalId: string, reason: "revoked" | "rejected" | "expired"): void {
    const a = tx
      .select({ action: approvalsTable.action, integration: approvalsTable.targetIntegration })
      .from(approvalsTable)
      .where(eq(approvalsTable.id, approvalId))
      .get();
    if (a?.integration !== "slack") return;
    if (a.action !== "slack.send" && a.action !== "slack.auto_reply") return;
    const row = tx
      .select()
      .from(outgoingMessages)
      .where(eq(outgoingMessages.approvalId, approvalId))
      .get();
    if (row?.status !== "pending") return;
    if (a.action === "slack.auto_reply") {
      const ar = this.autoReplyFor(tx, row.id);
      // M4: the engine revoked it because the gate shut; that stays the reason even if the gate
      // reopened before this consumer ran.
      const block =
        ar === undefined
          ? null
          : this.revokeReason(tx, approvalId) === "policy_disabled"
            ? "policy_disabled"
            : this.autoSendBlock(tx, ar);
      if (ar && block !== null) {
        this.holdAutoSend(tx, row, ar, block);
        return;
      }
      // Gates still open and within the staleness window (a prompt user revoke): the message fails
      // below and the auto-reply keeps `decision='sent'` (decision is the policy's verdict, delivery
      // is the outgoing status). Past the window `autoSendBlock` returned `stale` above, so an
      // expiry or late revoke is held and stops counting towards caps.
    }
    tx.update(outgoingMessages)
      .set({ status: "failed", failure: reason, updatedAt: isoNow(this.deps.clock) })
      .where(eq(outgoingMessages.id, row.id))
      .run();
    this.statusChanged(tx, row.id, "failed");
    this.moveFollowup(tx, row, "draft", `approval_${reason}`);
    this.auditSend(tx, row, "outgoing.cancelled", "failed", { reason });
  }

  /** The reason recorded on this approval's revoke, if any (the engine audits it). */
  private revokeReason(tx: DbOrTx, approvalId: string): string | undefined {
    const row = tx
      .select({ details: auditEvents.details })
      .from(auditEvents)
      .where(
        and(eq(auditEvents.approvalId, approvalId), eq(auditEvents.action, "approval.revoked")),
      )
      .get();
    const reason = (row?.details as { reason?: unknown } | null | undefined)?.reason;
    return typeof reason === "string" ? reason : undefined;
  }

  private autoReplyFor(tx: DbOrTx, outgoingId: string): AutoReplyRow | undefined {
    return tx.select().from(autoReplies).where(eq(autoReplies.outgoingId, outgoingId)).get();
  }

  /**
   * A13 plus the permission gate, plus M8: more than `autoReply.maxSendDelayMinutes` since the
   * decision (an unparseable time counts as stale). Null while the auto-send may still go out.
   */
  private autoSendBlock(tx: DbOrTx, ar: AutoReplyRow): AutoSendBlock | null {
    const { settings, approvals, clock } = this.deps;
    if (!settings.get("autoReply.awayMode")) return "away_off";
    const open = tx
      .select({ id: awaySessions.id })
      .from(awaySessions)
      .where(isNull(awaySessions.endedAt))
      .get();
    if (open?.id !== ar.sessionId) return "away_off";
    if (!approvals.policyGateOpen("slack.auto_reply")) return "policy_disabled";
    if (ar.kind === "code_answer" && !settings.get("codeAnswer.away.autoSend")) {
      return "code_answer_autosend_off";
    }
    const waited = clock.now().getTime() - Date.parse(ar.createdAt);
    const max = settings.get("autoReply.maxSendDelayMinutes") * 60_000;
    if (!(waited <= max)) return "stale";
    return null;
  }

  /**
   * Cancels a pending auto-send (failure `cancelled_<block>`, follow-up back to draft) and holds its
   * auto-reply (A16: a held row keeps no text). `autoreply.held` is published once, on the
   * transition from `sent` to `held`.
   *
   * A `sending` row is cancelled only with `allowSending`, which only the pre-spawn path (I2)
   * passes: there the process was certainly not spawned. Anywhere else a `sending` row's process
   * may be running, so it is left alone and its auto-reply is not held (the outcome decides).
   */
  private holdAutoSend(
    tx: DbOrTx,
    row: Row,
    ar: AutoReplyRow,
    block: AutoSendBlock,
    opts: { allowSending: boolean } = { allowSending: false },
  ): void {
    const now = isoNow(this.deps.clock);
    const failure = failureOf(block);
    const cancellable: OutgoingStatus[] = opts.allowSending ? ["pending", "sending"] : ["pending"];
    const cancelled = tx
      .update(outgoingMessages)
      .set({ status: "failed", failure, updatedAt: now })
      .where(and(eq(outgoingMessages.id, row.id), inArray(outgoingMessages.status, cancellable)))
      .returning({ id: outgoingMessages.id })
      .all();
    if (cancelled.length === 0) {
      const cur = tx
        .select({ status: outgoingMessages.status })
        .from(outgoingMessages)
        .where(eq(outgoingMessages.id, row.id))
        .get();
      // Claimed or past it: the message may be (or is) in Slack, so the auto-reply stays `sent`.
      if (cur && cur.status !== "pending" && cur.status !== "failed") return;
    }
    if (cancelled.length > 0) {
      this.statusChanged(tx, row.id, "failed");
      this.moveFollowup(tx, row, "draft", "auto_send_cancelled");
      this.auditSend(tx, row, "outgoing.cancelled", "failed", {
        reason: failure,
        autoReplyId: ar.id,
      });
    }
    const held = tx
      .update(autoReplies)
      .set({ decision: "held", reason: holdReasonOf(block), text: null })
      .where(and(eq(autoReplies.id, ar.id), eq(autoReplies.decision, "sent")))
      .returning({ id: autoReplies.id })
      .all();
    if (held.length === 0) return;
    if (block === "code_answer_autosend_off") this.deps.codeAnswerHeld?.(tx, ar.id);
    this.deps.events.publish(tx, {
      type: "autoreply.held",
      aggregateType: "auto_reply",
      aggregateId: ar.id,
      correlationId: newId(),
      payload: { autoReplyId: ar.id, reason: holdReasonOf(block) },
    });
  }

  /**
   * `autoreply.sent` for the auto-reply linked to this message. Callers invoke it only on the
   * message's first transition into `sent_unverified` or `sent`, so it is emitted exactly once.
   */
  private autoReplyDelivered(tx: DbOrTx, outgoingId: string): void {
    const ar = this.autoReplyFor(tx, outgoingId);
    // A held `code_answer_review` row links the user-approved send it became (Phase 10b C7): that
    // delivery is the user's send, not an auto-reply.
    if (ar?.decision !== "sent") return;
    this.deps.events.publish(tx, {
      type: "autoreply.sent",
      aggregateType: "auto_reply",
      aggregateId: ar.id,
      correlationId: newId(),
      payload: { autoReplyId: ar.id },
    });
  }

  private command(row: Row): SendMessageCommand {
    return {
      outgoingId: row.id,
      approvalId: row.approvalId,
      conversationExternalId: row.conversationExternalId,
      ...(row.threadTs !== null ? { threadTs: row.threadTs } : {}),
      text: row.text,
    };
  }

  private enqueueVerify(tx: DbOrTx, outgoingId: string, attempt: number): void {
    const delayMs = this.deps.settings.get("outgoing.verify.delaySeconds") * 1000;
    this.deps.queue.enqueue(tx, {
      type: OUTGOING_VERIFY_JOB,
      idempotencyKey: `${OUTGOING_VERIFY_JOB}:${outgoingId}:${attempt}`,
      priority: OUTGOING_VERIFY_PRIORITY,
      input: { outgoingId },
      runAfter: new Date(this.deps.clock.now().getTime() + delayMs).toISOString(),
      externalWrite: false,
    });
  }

  /**
   * Moves the message's follow-up, if it still points at this message (a superseded message never
   * changes its follow-up). Returns null when no follow-up is linked to this message.
   */
  private moveFollowup(
    tx: DbOrTx,
    row: Row,
    to: FollowupStatus,
    event: string,
  ): { changed: boolean } | null {
    if (row.followupId === null) return null;
    const f = tx
      .select({ status: followups.status, outgoingId: followups.outgoingId })
      .from(followups)
      .where(eq(followups.id, row.followupId))
      .get();
    if (!f || f.outgoingId !== row.id) return null;
    if (f.status === to) return { changed: false };
    tx.update(followups)
      .set({ status: to, updatedAt: isoNow(this.deps.clock) })
      .where(eq(followups.id, row.followupId))
      .run();
    this.followupEvent(tx, row.followupId, to, event, row.id);
    return { changed: true };
  }

  /** followup.sent exactly once: only the transition into `sent` emits it. */
  private markFollowupSent(tx: DbOrTx, row: Row, event: string): void {
    const moved = this.moveFollowup(tx, row, "sent", event);
    if (!moved?.changed || row.followupId === null) return;
    this.deps.events.publish(tx, {
      type: "followup.sent",
      aggregateType: "followup",
      aggregateId: row.followupId,
      correlationId: newId(),
      payload: { followupId: row.followupId, outgoingId: row.id },
    });
  }

  private followupEvent(
    tx: DbOrTx,
    followupId: string,
    status: FollowupStatus,
    event: string,
    outgoingId: string,
  ): void {
    this.deps.events.publish(tx, {
      type: "followup.status_changed",
      aggregateType: "followup",
      aggregateId: followupId,
      correlationId: newId(),
      payload: { followupId, status },
    });
    tx.insert(followupHistory)
      .values({
        id: newId(),
        followupId,
        event,
        detail: `outgoing ${outgoingId}`,
        createdAt: isoNow(this.deps.clock),
      })
      .run();
  }

  private statusChanged(tx: DbOrTx, outgoingId: string, status: OutgoingStatus): void {
    this.deps.events.publish(tx, {
      type: "outgoing.status_changed",
      aggregateType: "outgoing",
      aggregateId: outgoingId,
      correlationId: newId(),
      payload: { outgoingId, status },
    });
  }

  private auditSend(
    tx: DbOrTx,
    row: Row,
    action: string,
    result: string,
    details: Record<string, unknown> = {},
  ): void {
    this.deps.audit.record(tx, {
      actor: "system",
      module: "outgoing",
      action,
      targetIntegration: "slack",
      targetRef: row.conversationExternalId,
      approvalId: row.approvalId,
      result,
      details: { outgoingId: row.id, followupId: row.followupId, ...details },
    });
  }
}

/** I1: the first request field that differs from the auto_replies row, or null. */
function autoSendMismatch(
  input: AutoSendRequest,
  ar: AutoReplyRow,
): AutoSendMismatch["field"] | null {
  if (input.conversationExternalId !== ar.conversationExternalId) return "conversationExternalId";
  if ((input.threadTs ?? null) !== ar.threadTs) return "threadTs";
  if (ar.text === null || input.text.trimEnd() !== ar.text.trimEnd()) return "text";
  if (input.followupId !== ar.followupId) return "followupId";
  return null;
}

/**
 * A delivered-but-unconfirmed message, or an uncertain one; never a blocked (mismatch) one, and never
 * one whose verification is exhausted (failure `unverified`, either status).
 */
function verifiable(row: Row): boolean {
  if (row.status === "sent_unverified") return row.failure !== "unverified";
  return row.status === "needs_attention" && row.failure === "uncertain_outcome";
}
