import { type Db, schema, type Tx } from "@synapse/database";
import { type Clock, newId } from "@synapse/shared";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { SettingsService } from "../../core/config/settings";
import type { EventPublisher } from "../../core/events/publisher";
import { dedupKey, type ValidCandidate } from "../../intelligence/commitments/validate";

const { commitments, commitmentSources, commitmentUpdates } = schema;

export const COMMITMENTS_CONCURRENCY_GROUP = "commitments.intelligence";
/** Prefix of a status proposal's `reason`; Task 6 confirms or dismisses the proposal. */
export const PROPOSED_REASON_PREFIX = "proposed:";

export interface CandidateSource {
  messageId: string;
  sourceRef: string;
  conversationId: string;
}

export interface RecordInput {
  candidate: ValidCandidate;
  /** One entry per cited message, in citation order. */
  sources: CandidateSource[];
  selfUserId: string;
  runId: string;
  correlationId: string;
}

export type RecordOutcome = "created" | "source_added" | "unchanged" | "proposed" | "no_match";

export interface CommitmentStoreDeps {
  db: Db;
  clock: Clock;
  settings: SettingsService;
  events: EventPublisher;
}

/** Owns the commitment tables. Writers take the caller's transaction. */
export class CommitmentStore {
  constructor(private readonly deps: CommitmentStoreDeps) {}

  get(id: string) {
    return this.deps.db.select().from(commitments).where(eq(commitments.id, id)).get();
  }

  /**
   * A promise or accepted request becomes a commitment (deduplicated); a completion only ever
   * becomes a pending status proposal on a matching open commitment. Never changes a status.
   */
  record(tx: Tx, input: RecordInput): RecordOutcome {
    return input.candidate.kind === "completion"
      ? this.proposeCompletion(tx, input)
      : this.upsertCommitment(tx, input);
  }

  private upsertCommitment(tx: Tx, input: RecordInput): RecordOutcome {
    const { clock, settings, events } = this.deps;
    const { candidate: c, sources, runId } = input;
    const now = clock.now().toISOString();
    const key = dedupKey(c.owner, c.counterparty, c.description);
    const existing = tx
      .select({ id: commitments.id })
      .from(commitments)
      .where(eq(commitments.dedupKey, key))
      .get();
    let id: string;
    let created = false;
    if (existing) {
      id = existing.id;
    } else {
      id = newId();
      created = true;
      tx.insert(commitments)
        .values({
          id,
          description: c.description,
          ownerSlackUserId: c.owner,
          counterpartySlackUserId: c.counterparty,
          direction: c.owner === input.selfUserId ? "mine" : "theirs",
          status: "open",
          reviewStatus: settings.get("commitments.requireReviewForDetected")
            ? "pending_review"
            : "accepted",
          dueAt: c.dueAt,
          dedupKey: key,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }
    let added = 0;
    for (const s of sources) {
      added += tx
        .insert(commitmentSources)
        .values({
          id: newId(),
          commitmentId: id,
          messageId: s.messageId,
          sourceExternalRef: s.sourceRef,
          conversationId: s.conversationId,
          claudeRunId: runId,
          createdAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: commitmentSources.id })
        .all().length;
    }
    if (created) {
      this.publishDetected(tx, id, input.correlationId);
      return "created";
    }
    return added > 0 ? "source_added" : "unchanged";
  }

  private proposeCompletion(tx: Tx, input: RecordInput): RecordOutcome {
    const { clock } = this.deps;
    const first = input.sources[0];
    if (!first) return "no_match";
    const match = tx
      .select({ id: commitments.id, status: commitments.status })
      .from(commitments)
      .innerJoin(commitmentSources, eq(commitmentSources.commitmentId, commitments.id))
      .where(
        and(
          eq(commitments.ownerSlackUserId, input.candidate.owner),
          eq(commitments.reviewStatus, "accepted"),
          inArray(commitments.status, ["open", "in_progress", "blocked"]),
          eq(commitmentSources.conversationId, first.conversationId),
        ),
      )
      .orderBy(desc(commitments.createdAt))
      .limit(1)
      .get();
    if (!match) return "no_match";
    const reason = `${PROPOSED_REASON_PREFIX}${first.sourceRef}`;
    const dup = tx
      .select({ id: commitmentUpdates.id })
      .from(commitmentUpdates)
      .where(
        and(
          eq(commitmentUpdates.commitmentId, match.id),
          eq(commitmentUpdates.field, "status"),
          eq(commitmentUpdates.toValue, "completed"),
          eq(commitmentUpdates.reason, reason),
        ),
      )
      .get();
    if (dup) return "unchanged";
    tx.insert(commitmentUpdates)
      .values({
        id: newId(),
        commitmentId: match.id,
        actor: "ai",
        field: "status",
        fromValue: match.status,
        toValue: "completed",
        reason,
        createdAt: clock.now().toISOString(),
      })
      .run();
    return "proposed";
  }

  private publishDetected(tx: Tx, commitmentId: string, correlationId: string) {
    this.deps.events.publish(tx, {
      type: "commitment.detected",
      aggregateType: "commitment",
      aggregateId: commitmentId,
      correlationId,
      payload: { commitmentId },
    });
  }
}
