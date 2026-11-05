import {
  type Approval,
  JobError,
  type MessageSink,
  type SendMessageCommand,
  type SendResult,
} from "@synapse/contracts";
import { type Db, type DbOrTx, schema } from "@synapse/database";
import { type Clock, isoNow, newId } from "@synapse/shared";
import { and, eq, inArray, isNotNull, lt, or } from "drizzle-orm";
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

const { outgoingMessages, followups, followupHistory, approvals: approvalsTable, jobs } = schema;

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

type Row = typeof schema.outgoingMessages.$inferSelect;
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
  | "not_found";

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
  approvals: Pick<ApprovalEngine, "request">;
  securityFlags: Pick<SecurityFlagsService, "recordRuntimeFlag">;
  sink: MessageSink;
}

const errorName = (e: unknown) => (e instanceof Error ? e.name : "unknown");

/**
 * Approved Slack sends (Phase 6). A message is sent only by the `slack.send` executor for its own
 * approval, at most once: it is marked `sending` before the sink is called, and nothing ever moves
 * it back to `pending`. Uncertain outcomes are verified by searching Slack, never by re-sending; a
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

  /** Wires the `slack.send`/`slack` executor and the revoke/reject/expiry consumers. */
  register(engine: ApprovalEngine, dispatcher: Pick<OutboxDispatcher, "subscribe">): void {
    // R7 (f): bound privately; only the engine (after its own claim) can run a send.
    registerIntegrationExecutor(engine, "slack.send", "slack", {
      execute: async (a, signal) => this.#execute(a, signal),
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
    const approval = approvals.request(tx, {
      action: "slack.send",
      targetIntegration: "slack",
      targetRef: input.conversationExternalId,
      payload: { outgoingId },
      riskLevel: "medium",
      idempotencyKey: `outgoing:${outgoingId}`,
      requestedByModule: input.requestedByModule,
      expiresAt: new Date(clock.now().getTime() + APPROVAL_TTL_MS).toISOString(),
    });
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
      this.followupEvent(tx, followupId, "awaiting_approval", "send_requested", outgoingId);
    }
    return { outgoingId, approvalId: approval.id };
  }

  /**
   * The `slack.send` executor. Throws only `OutgoingSendError` (fixed messages), and only when
   * nothing was sent or the outcome could not be recorded; the engine then fails the approval.
   * `signal` is the `approval.execute` job's: an abort before spawn (still waiting for a Claude
   * slot) makes the sink throw, which is the safe `not_started` outcome.
   */
  async #execute(approval: Approval, signal?: AbortSignal): Promise<SendOutcome> {
    const { db } = this.deps;
    const payload = payloadSchema.safeParse(approval.payload);
    if (!payload.success) throw new OutgoingSendError("invalid_payload");
    const { outgoingId } = payload.data;

    // 1. Claim: pending -> sending, committed before the sink is called.
    const claim = db.transaction((tx) => this.claim(tx, approval.id, outgoingId), {
      behavior: "immediate",
    });
    if ("skip" in claim) return { outgoingId, status: "skipped", reason: claim.skip };
    const { row, jobId } = claim;
    this.#inFlight.add(outgoingId);
    try {
      return await this.#send(row, jobId, signal ?? new AbortController().signal);
    } finally {
      this.#inFlight.delete(outgoingId);
    }
  }

  async #send(row: Row, jobId: string | undefined, signal: AbortSignal): Promise<SendOutcome> {
    const { db, sink } = this.deps;
    const outgoingId = row.id;
    // 2. Send.
    let result: SendResult;
    try {
      result = await sink.send(
        { ...this.command(row), ...(jobId !== undefined ? { jobId } : {}) },
        signal,
      );
    } catch (e) {
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
  ): { skip: string } | { row: Row; jobId: string | undefined } {
    const row = tx.select().from(outgoingMessages).where(eq(outgoingMessages.id, outgoingId)).get();
    if (!row) throw new OutgoingSendError("not_found");
    if (row.approvalId !== approvalId) return { skip: "approval_mismatch" };
    // R7 (f): only an approved approval that the engine has claimed for execution.
    const approval = tx
      .select({ status: approvalsTable.status, startedAt: approvalsTable.executionStartedAt })
      .from(approvalsTable)
      .where(eq(approvalsTable.id, approvalId))
      .get();
    if (approval?.status !== "approved" || approval.startedAt === null) {
      return { skip: "approval_not_claimed" };
    }
    // Defence in depth on top of the engine's claim: only a pending message is ever sent.
    if (row.status !== "pending") return { skip: `status_${row.status}` };
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
    return { row: { ...row, status: "sending", sendingAt: now }, jobId: job?.id };
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

  /** revoke/reject/expiry of a slack.send approval whose message has not started. */
  private cancel(tx: DbOrTx, approvalId: string, reason: "revoked" | "rejected" | "expired"): void {
    const a = tx
      .select({ action: approvalsTable.action, integration: approvalsTable.targetIntegration })
      .from(approvalsTable)
      .where(eq(approvalsTable.id, approvalId))
      .get();
    if (a?.action !== "slack.send" || a.integration !== "slack") return;
    const row = tx
      .select()
      .from(outgoingMessages)
      .where(eq(outgoingMessages.approvalId, approvalId))
      .get();
    if (row?.status !== "pending") return;
    tx.update(outgoingMessages)
      .set({ status: "failed", failure: reason, updatedAt: isoNow(this.deps.clock) })
      .where(eq(outgoingMessages.id, row.id))
      .run();
    this.statusChanged(tx, row.id, "failed");
    this.moveFollowup(tx, row, "draft", `approval_${reason}`);
    this.auditSend(tx, row, "outgoing.cancelled", "failed", { reason });
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

/**
 * A delivered-but-unconfirmed message, or an uncertain one; never a blocked (mismatch) one, and never
 * one whose verification is exhausted (failure `unverified`, either status).
 */
function verifiable(row: Row): boolean {
  if (row.status === "sent_unverified") return row.failure !== "unverified";
  return row.status === "needs_attention" && row.failure === "uncertain_outcome";
}
