import { realpathSync, statSync } from "node:fs";
import {
  CODE_ANSWER_MAX_CONTEXT_MESSAGES,
  CODE_ANSWER_MAX_FACTS,
  type CodeAnswerEvidence,
  type CodeAnswerOutput,
  type CodeAnswerStatus,
  type CodeAnswerTrigger,
  type CodeAnswerView,
  isSafeAbsolutePath,
} from "@synapse/contracts";
import { type Db, type DbOrTx, schema, type Tx } from "@synapse/database";
import { type Clock, newId } from "@synapse/shared";
import { and, desc, eq, inArray, isNotNull, like, lt, or, sql } from "drizzle-orm";
import type { AuditLogger } from "../../core/audit/audit";
import type { SettingsService } from "../../core/config/settings";
import type { EventPublisher } from "../../core/events/publisher";
import type { JobQueue } from "../../core/jobs/queue";
import { BUILTIN_WRITE, classifyTool, normalizeTool } from "../../core/orchestrator/tool-catalog";
import { InvalidOutgoingText, type OutgoingService, type SendRequested } from "../outgoing/service";
import type { SecurityFlagsService } from "../security-flags/service";

const { codeAnswers, slackMessages, repositories } = schema;
const MODULE = "code-answers";
const DAY_MS = 86_400_000;
/** Same bound as `OutgoingService`: a longer reply is refused up front. */
const MAX_REPLY_TEXT = 4000;
const DISMISSABLE: CodeAnswerStatus[] = ["ready", "held", "not_answerable", "unverified", "failed"];

/** C2: the reader run for one (message, repository, trigger). Input `{codeAnswerId}`. */
export const CODE_ANSWER_JOB = "code_answer.generate";

export type CodeAnswerErrorCode =
  | "not_found"
  | "invalid_repository"
  | "already_running"
  | "already_answered"
  | "invalid_state"
  | "injection_unacknowledged"
  | "invalid_text";

export class CodeAnswerError extends Error {
  constructor(readonly code: CodeAnswerErrorCode) {
    super(code);
    this.name = "CodeAnswerError";
  }
}

export interface CodeAnswerServiceDeps {
  db: Db;
  clock: Clock;
  events: Pick<EventPublisher, "publish">;
  audit: Pick<AuditLogger, "record">;
  queue: Pick<JobQueue, "enqueue">;
  settings: Pick<SettingsService, "get">;
  securityFlags: Pick<SecurityFlagsService, "recordAiFlag" | "recordRuntimeFlag">;
  outgoing: Pick<OutgoingService, "requestSend">;
}

export interface CodeAnswerTarget {
  codeAnswerId: string;
  messageId: string;
  trigger: CodeAnswerTrigger;
  /** `root` is the registered realpath: the only source of the run's working directory. */
  repository: { id: string; name: string; root: string };
  question: string;
  thread: string[];
  facts: string[];
}

export type PrepareCodeAnswerResult =
  | { ok: true; target: CodeAnswerTarget }
  | {
      ok: false;
      reason:
        | "not_found"
        | "not_queued"
        | "repository_unavailable"
        | "path_unavailable"
        | "content_expired";
    };

export interface CodeAnswerRecord {
  output: CodeAnswerOutput;
  kept: { path: string; line?: number }[];
  dropped: number;
  claudeRunId: string | null;
  permissionDenials: string[];
}

/** Called in the transaction that moves a row to its final status of a run. */
export type AfterFinish = (
  tx: Tx,
  row: { id: string; trigger: CodeAnswerTrigger; status: CodeAnswerStatus },
) => void;

type Row = typeof codeAnswers.$inferSelect;

function realpathOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export class CodeAnswerService {
  constructor(private readonly deps: CodeAnswerServiceDeps) {}

  private now(): string {
    return this.deps.clock.now().toISOString();
  }

  private row(tx: DbOrTx, id: string): Row | undefined {
    return tx.select().from(codeAnswers).where(eq(codeAnswers.id, id)).get();
  }

  private publishStatus(
    tx: DbOrTx,
    row: { id: string; messageId: string },
    status: CodeAnswerStatus,
  ) {
    this.deps.events.publish(tx, {
      type: "code_answer.status_changed",
      aggregateType: "code_answer",
      aggregateId: row.id,
      correlationId: newId(),
      payload: { codeAnswerId: row.id, messageId: row.messageId, status },
    });
  }

  /**
   * Inserts a `queued` row and its job. The row id is in the idempotency key because job keys are
   * unique forever, so a retry after `failed` needs a new key.
   */
  create(
    tx: DbOrTx,
    input: { messageId: string; repositoryId: string; trigger: CodeAnswerTrigger },
  ): string {
    const { messageId, repositoryId, trigger } = input;
    if (
      !tx
        .select({ id: slackMessages.id })
        .from(slackMessages)
        .where(eq(slackMessages.id, messageId))
        .get()
    ) {
      throw new CodeAnswerError("not_found");
    }
    if (
      !tx
        .select({ id: repositories.id })
        .from(repositories)
        .where(eq(repositories.id, repositoryId))
        .get()
    ) {
      throw new CodeAnswerError("invalid_repository");
    }
    const live = tx
      .select({ status: codeAnswers.status })
      .from(codeAnswers)
      .where(
        and(
          eq(codeAnswers.messageId, messageId),
          eq(codeAnswers.repositoryId, repositoryId),
          eq(codeAnswers.trigger, trigger),
          inArray(codeAnswers.status, [
            "queued",
            "running",
            "ready",
            "not_answerable",
            "unverified",
            "held",
            "sent",
          ]),
        ),
      )
      .get();
    if (live) {
      throw new CodeAnswerError(
        live.status === "queued" || live.status === "running"
          ? "already_running"
          : "already_answered",
      );
    }
    const id = newId();
    const now = this.now();
    tx.insert(codeAnswers)
      .values({
        id,
        messageId,
        repositoryId,
        trigger,
        status: "queued",
        evidence: [],
        droppedEvidenceCount: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    this.deps.queue.enqueue(tx, {
      type: CODE_ANSWER_JOB,
      input: { codeAnswerId: id },
      idempotencyKey: `code-answer:${messageId}:${repositoryId}:${id}`,
      maxAttempts: 1,
      priority: 150,
    });
    this.publishStatus(tx, { id, messageId }, "queued");
    return id;
  }

  /**
   * Checks the repository and the message, moves the row to `running` and returns what the run
   * needs. The working directory is the registered `local_path`, re-checked as an existing
   * directory that is its own realpath; nothing else ever names it.
   */
  prepare(id: string, after?: AfterFinish): PrepareCodeAnswerResult {
    const { db } = this.deps;
    const row = this.row(db, id);
    if (!row) return { ok: false, reason: "not_found" };
    // `running` is a row whose own job re-entered: the single attempt before it died (restart,
    // reaper), so the row is reclaimed instead of staying orphaned.
    if (row.status !== "queued" && row.status !== "running") {
      return { ok: false, reason: "not_queued" };
    }
    const repo = row.repositoryId
      ? db.select().from(repositories).where(eq(repositories.id, row.repositoryId)).get()
      : undefined;
    if (!repo) {
      this.recordFailure(id, "repository_unavailable", null, after);
      return { ok: false, reason: "repository_unavailable" };
    }
    if (
      !isSafeAbsolutePath(repo.localPath) ||
      realpathOrNull(repo.localPath) !== repo.localPath ||
      !isDirectory(repo.localPath)
    ) {
      this.recordFailure(id, "path_unavailable", null, after);
      return { ok: false, reason: "path_unavailable" };
    }
    const msg = db.select().from(slackMessages).where(eq(slackMessages.id, row.messageId)).get();
    if (!msg || msg.text === null || msg.text === "" || msg.contentExpiredAt !== null) {
      this.recordFailure(id, "content_expired", null, after);
      return { ok: false, reason: "content_expired" };
    }
    const root = msg.threadTs ?? msg.ts;
    const earlier = msg.threadTs
      ? db
          .select({ text: slackMessages.text })
          .from(slackMessages)
          .where(
            and(
              eq(slackMessages.conversationId, msg.conversationId),
              or(eq(slackMessages.threadTs, root), eq(slackMessages.ts, root)),
              lt(slackMessages.sentAt, msg.sentAt),
              isNotNull(slackMessages.text),
            ),
          )
          .orderBy(desc(slackMessages.sentAt))
          .limit(CODE_ANSWER_MAX_CONTEXT_MESSAGES)
          .all()
      : [];
    const thread = earlier
      .map((m) => m.text)
      .filter((t): t is string => t !== null && t !== "")
      .reverse();
    const facts = db
      .select({ content: schema.projectFacts.content })
      .from(schema.projectFacts)
      .innerJoin(
        schema.projectRepositories,
        eq(schema.projectRepositories.projectId, schema.projectFacts.projectId),
      )
      .where(
        and(
          eq(schema.projectRepositories.repositoryId, repo.id),
          eq(schema.projectFacts.status, "approved"),
        ),
      )
      .orderBy(desc(schema.projectFacts.createdAt))
      .limit(CODE_ANSWER_MAX_FACTS)
      .all()
      .map((f) => f.content);
    const running = db.transaction(
      (tx) => {
        const fresh = this.row(tx, id);
        if (fresh?.status !== "queued" && fresh?.status !== "running") return false;
        if (fresh.status === "running") return true;
        tx.update(codeAnswers)
          .set({ status: "running", failure: null, updatedAt: this.now() })
          .where(eq(codeAnswers.id, id))
          .run();
        this.publishStatus(tx, fresh, "running");
        return true;
      },
      { behavior: "immediate" },
    );
    if (!running) return { ok: false, reason: "not_queued" };
    return {
      ok: true,
      target: {
        codeAnswerId: id,
        messageId: row.messageId,
        trigger: row.trigger,
        repository: { id: repo.id, name: repo.name, root: repo.localPath },
        question: msg.text,
        thread,
        facts,
      },
    };
  }

  /** Deferral (quota, auth, user active): the queue runs the job again later. */
  markQueued(id: string): void {
    this.deps.db.transaction(
      (tx) => {
        const row = this.row(tx, id);
        if (row?.status !== "running") return;
        tx.update(codeAnswers)
          .set({ status: "queued", updatedAt: this.now() })
          .where(eq(codeAnswers.id, id))
          .run();
        this.publishStatus(tx, row, "queued");
      },
      { behavior: "immediate" },
    );
  }

  /** A failed run (one attempt). `failure` is a fixed code, never model or message text. */
  recordFailure(
    id: string,
    failure: string,
    claudeRunId: string | null,
    after?: AfterFinish,
  ): void {
    const { db, audit } = this.deps;
    db.transaction(
      (tx) => {
        const row = this.row(tx, id);
        if (!row || (row.status !== "queued" && row.status !== "running")) return;
        tx.update(codeAnswers)
          .set({ status: "failed", failure, claudeRunId, updatedAt: this.now() })
          .where(eq(codeAnswers.id, id))
          .run();
        this.publishStatus(tx, row, "failed");
        audit.record(tx, {
          actor: "system",
          module: MODULE,
          action: "code_answer.failed",
          workerProfile: "reader",
          targetRef: id,
          result: "failed",
          details: { codeAnswerId: id, kind: failure },
        });
        after?.(tx, { id, trigger: row.trigger, status: "failed" });
      },
      { behavior: "immediate" },
    );
  }

  /** Stores the verified result of a run and returns its status. */
  recordResult(id: string, r: CodeAnswerRecord, after?: AfterFinish): CodeAnswerStatus {
    const { db, audit, securityFlags } = this.deps;
    return db.transaction(
      (tx) => {
        const row = this.row(tx, id);
        // Dismissed (or otherwise settled) while the run was going: write nothing.
        if (row?.status !== "running") return row?.status ?? "failed";
        const o = r.output;
        let status: CodeAnswerStatus;
        let failure: string | null = null;
        if (!o.answerable) status = "not_answerable";
        else if (r.kept.length === 0) {
          status = "unverified";
          failure = "evidence_unverified";
        } else status = "ready";
        tx.update(codeAnswers)
          .set({
            status,
            answer: status === "ready" ? o.answer : null,
            confidence: status === "ready" ? o.confidence : null,
            evidence: status === "ready" ? r.kept : [],
            droppedEvidenceCount: r.dropped,
            notAnswerableReason:
              status === "not_answerable" ? (o.notAnswerableReason ?? null) : null,
            suspectedInjection: o.suspectedInjection.detected ? o.suspectedInjection : null,
            claudeRunId: r.claudeRunId,
            failure,
            updatedAt: this.now(),
          })
          .where(eq(codeAnswers.id, id))
          .run();
        if (o.suspectedInjection.detected) {
          if (r.claudeRunId)
            securityFlags.recordAiFlag(tx, row.messageId, r.claudeRunId, o.suspectedInjection);
          else {
            securityFlags.recordRuntimeFlag(
              tx,
              [row.messageId],
              null,
              "suspected injection in a code answer run",
              o.suspectedInjection.severity === "high" ? "high" : "warning",
            );
          }
        }
        const denied = [...new Set(r.permissionDenials.map(normalizeTool))].sort();
        if (denied.length > 0) {
          const write = denied.some(
            (t) => BUILTIN_WRITE.includes(t) || classifyTool(t) === "write",
          );
          securityFlags.recordRuntimeFlag(
            tx,
            [row.messageId],
            r.claudeRunId,
            "code answer run attempted a denied tool",
            write ? "high" : "warning",
          );
        }
        this.publishStatus(tx, row, status);
        audit.record(tx, {
          actor: "system",
          module: MODULE,
          action: "code_answer.generated",
          workerProfile: "reader",
          targetRef: id,
          result: "ok",
          details: { codeAnswerId: id, status, kept: r.kept.length, dropped: r.dropped },
        });
        after?.(tx, { id, trigger: row.trigger, status });
        return status;
      },
      { behavior: "immediate" },
    );
  }

  private toView(
    row: Row,
    repositoryName: string | null,
    outgoingStatus: string | null,
  ): CodeAnswerView {
    return {
      id: row.id,
      messageId: row.messageId,
      repositoryId: row.repositoryId,
      repositoryName,
      trigger: row.trigger,
      status: row.status,
      answer: row.answer,
      confidence: row.confidence,
      evidence: row.evidence as CodeAnswerEvidence[],
      droppedEvidenceCount: row.droppedEvidenceCount,
      notAnswerableReason: row.notAnswerableReason,
      failure: row.failure,
      suspectedInjection: row.suspectedInjection
        ? {
            detected: row.suspectedInjection.detected,
            severity: row.suspectedInjection.severity as "warning" | "high",
            reason: row.suspectedInjection.reason,
          }
        : null,
      outgoingId: row.outgoingId,
      outgoingStatus,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private views(where: ReturnType<typeof eq>): CodeAnswerView[] {
    return this.deps.db
      .select({
        row: codeAnswers,
        repoName: repositories.name,
        outStatus: schema.outgoingMessages.status,
      })
      .from(codeAnswers)
      .leftJoin(repositories, eq(repositories.id, codeAnswers.repositoryId))
      .leftJoin(schema.outgoingMessages, eq(schema.outgoingMessages.id, codeAnswers.outgoingId))
      .where(where)
      .orderBy(desc(codeAnswers.createdAt))
      .all()
      .map((r) => this.toView(r.row, r.repoName, r.outStatus));
  }

  /**
   * C5: the user asks for an answer from one repository. Returns the new queued row's id, and
   * throws `CodeAnswerError` for an unknown message or repository, or a live/settled row.
   */
  requestUser(messageId: string, repositoryId: string): { codeAnswerId: string } {
    const { db, audit } = this.deps;
    return db.transaction(
      (tx) => {
        const codeAnswerId = this.create(tx, { messageId, repositoryId, trigger: "user" });
        audit.record(tx, {
          actor: "user",
          module: MODULE,
          action: "code_answer.requested",
          targetRef: codeAnswerId,
          result: "ok",
          details: { codeAnswerId, messageId, repositoryId },
        });
        return { codeAnswerId };
      },
      { behavior: "immediate" },
    );
  }

  /** The user drops an answer. Only a settled row can be dismissed (not queued, running or sent). */
  dismiss(id: string): void {
    const { db, audit } = this.deps;
    db.transaction(
      (tx) => {
        const row = this.row(tx, id);
        if (!row) throw new CodeAnswerError("not_found");
        if (!DISMISSABLE.includes(row.status)) throw new CodeAnswerError("invalid_state");
        tx.update(codeAnswers)
          .set({ status: "dismissed", updatedAt: this.now() })
          .where(eq(codeAnswers.id, id))
          .run();
        this.publishStatus(tx, row, "dismissed");
        audit.record(tx, {
          actor: "user",
          module: MODULE,
          action: "code_answer.dismissed",
          targetRef: id,
          result: "ok",
          details: { codeAnswerId: id, from: row.status },
        });
      },
      { behavior: "immediate" },
    );
  }

  /**
   * The user's (edited) reply becomes a normal pending `slack.send` approval: exact text and
   * recipient, no auto-reply tag. A suspected injection needs `useAnyway`, enforced here (not
   * only in the UI). Nothing is sent until the user approves.
   */
  requestSend(id: string, rawText: string, useAnyway: boolean): SendRequested {
    const { db, audit, outgoing } = this.deps;
    const text = rawText.trimEnd();
    if (text.length < 1 || text.length > MAX_REPLY_TEXT) throw new CodeAnswerError("invalid_text");
    return db.transaction(
      (tx) => {
        const row = this.row(tx, id);
        if (!row) throw new CodeAnswerError("not_found");
        if ((row.status !== "ready" && row.status !== "held") || row.outgoingId !== null) {
          throw new CodeAnswerError("invalid_state");
        }
        if (row.suspectedInjection?.detected && !useAnyway) {
          throw new CodeAnswerError("injection_unacknowledged");
        }
        const m = tx
          .select({
            ts: slackMessages.ts,
            threadTs: slackMessages.threadTs,
            conversation: schema.slackConversations.externalId,
          })
          .from(slackMessages)
          .innerJoin(
            schema.slackConversations,
            eq(schema.slackConversations.id, slackMessages.conversationId),
          )
          .where(eq(slackMessages.id, row.messageId))
          .get();
        if (!m) throw new CodeAnswerError("not_found");
        let requested: SendRequested;
        try {
          requested = outgoing.requestSend(tx, {
            followupId: null,
            conversationExternalId: m.conversation,
            threadTs: m.threadTs ?? m.ts,
            text,
            requestedByModule: "code-answer",
          });
        } catch (e) {
          if (e instanceof InvalidOutgoingText) throw new CodeAnswerError("invalid_text");
          throw e;
        }
        tx.update(codeAnswers)
          .set({ outgoingId: requested.outgoingId, status: "sent", updatedAt: this.now() })
          .where(eq(codeAnswers.id, id))
          .run();
        this.publishStatus(tx, row, "sent");
        audit.record(tx, {
          actor: "user",
          module: MODULE,
          action: "code_answer.send_requested",
          targetIntegration: "slack",
          targetRef: m.conversation,
          approvalId: requested.approvalId,
          result: "ok",
          details: {
            codeAnswerId: id,
            outgoingId: requested.outgoingId,
            useAnyway: row.suspectedInjection?.detected ? useAnyway : false,
          },
        });
        return requested;
      },
      { behavior: "immediate" },
    );
  }

  get(id: string): CodeAnswerView | null {
    return this.views(eq(codeAnswers.id, id))[0] ?? null;
  }

  listForMessage(messageId: string): CodeAnswerView[] {
    return this.views(eq(codeAnswers.messageId, messageId));
  }

  /** Retention: nulls the answer and the not-answerable reason of rows older than the cutoff. */
  expireAnswers(olderThanDays: number): number {
    const cutoff = new Date(this.deps.clock.now().getTime() - olderThanDays * DAY_MS).toISOString();
    return this.deps.db
      .update(codeAnswers)
      .set({
        answer: null,
        notAnswerableReason: null,
        suspectedInjection: sql`case when ${codeAnswers.suspectedInjection} is null then null else json_set(${codeAnswers.suspectedInjection}, '$.quote', '') end`,
      })
      .where(
        and(
          lt(codeAnswers.createdAt, cutoff),
          or(
            isNotNull(codeAnswers.answer),
            isNotNull(codeAnswers.notAnswerableReason),
            sql`coalesce(json_extract(${codeAnswers.suspectedInjection}, '$.quote'), '') <> ''`,
          ),
        ),
      )
      .returning({ id: codeAnswers.id })
      .all().length;
  }

  /**
   * Recovery sweep (startup and reaper): a `running` row whose job is no longer pending, retrying
   * or running lost its run (restart, crash). It is failed `interrupted` so it can be asked again.
   */
  recoverySweep(tx: Tx): void {
    const running = tx
      .select({ id: codeAnswers.id })
      .from(codeAnswers)
      .where(eq(codeAnswers.status, "running"))
      .all();
    for (const { id } of running) {
      const live = tx
        .select({ id: schema.jobs.id })
        .from(schema.jobs)
        .where(
          and(
            eq(schema.jobs.type, CODE_ANSWER_JOB),
            like(schema.jobs.idempotencyKey, `%:${id}`),
            inArray(schema.jobs.status, ["PENDING", "RETRY", "RUNNING"]),
          ),
        )
        .get();
      if (live) continue;
      const row = this.row(tx, id);
      if (row?.status !== "running") continue;
      tx.update(codeAnswers)
        .set({ status: "failed", failure: "interrupted", updatedAt: this.now() })
        .where(eq(codeAnswers.id, id))
        .run();
      this.publishStatus(tx, row, "failed");
      this.deps.audit.record(tx, {
        actor: "system",
        module: MODULE,
        action: "code_answer.failed",
        workerProfile: "reader",
        targetRef: id,
        result: "failed",
        details: { codeAnswerId: id, kind: "interrupted" },
      });
    }
  }
}
