import type { ProfileContent } from "@synapse/contracts";
import { type Db, type DbOrTx, schema } from "@synapse/database";
import { type Clock, isoNow, newId } from "@synapse/shared";
import { and, eq } from "drizzle-orm";
import type { ApprovalEngine } from "../../core/approvals/approvals";
import type { SettingsService } from "../../core/config/settings";
import type { EventPublisher } from "../../core/events/publisher";
import type { JobQueue } from "../../core/jobs/queue";
import { observationHash } from "../../intelligence/people/evidence";
import type { PeopleService } from "./service";

const { peopleProfileRecommendations, peopleProfileEvidence, people } = schema;

export interface ProfileRecommendationsDeps {
  db: Db;
  clock: Clock;
  settings: SettingsService;
  events: EventPublisher;
  queue: JobQueue;
  approvals: ApprovalEngine;
  people: PeopleService;
}

export interface InitialProfileRequestResult {
  queued: boolean;
  reason?: "pending_recommendation" | "identity_required";
}

export interface EvidenceRow {
  observationKey: string;
  messageId: string;
  sourceExternalRef: string;
  confidence: "low" | "medium" | "high";
  observedAt: string;
}

export const INITIAL_PROFILE_JOB = "people.generate_initial_profile";
export const PEOPLE_CONCURRENCY_GROUP = "people.intelligence";
export const INITIAL_PROFILE_PRIORITY = 120;

/** Pending recommendations: storage and the request trigger for the initial profile. */
export class ProfileRecommendations {
  constructor(private readonly deps: ProfileRecommendationsDeps) {}

  hasPending(tx: DbOrTx, personId: string): boolean {
    return (
      tx
        .select({ id: peopleProfileRecommendations.id })
        .from(peopleProfileRecommendations)
        .where(
          and(
            eq(peopleProfileRecommendations.personId, personId),
            eq(peopleProfileRecommendations.status, "pending"),
          ),
        )
        .limit(1)
        .get() !== undefined
    );
  }

  /**
   * Queues the initial-profile job for a person the user chose. Needs the confirmed Slack identity
   * (the history is "you and them") and no pending recommendation. One job per person and day.
   */
  requestInitialProfile(slackUserId: string): InitialProfileRequestResult {
    const { db, settings, clock, queue, people: peopleService } = this.deps;
    if (settings.get("slack.selfUserId") === null) {
      return { queued: false, reason: "identity_required" };
    }
    return db.transaction(
      (tx) => {
        const personId = peopleService.ensurePerson(tx, slackUserId);
        if (this.hasPending(tx, personId)) {
          return { queued: false, reason: "pending_recommendation" as const };
        }
        queue.enqueue(tx, {
          type: INITIAL_PROFILE_JOB,
          idempotencyKey: `people.initial:${personId}:${isoNow(clock).slice(0, 10)}`,
          input: { personId },
          concurrencyGroup: PEOPLE_CONCURRENCY_GROUP,
          priority: INITIAL_PROFILE_PRIORITY,
        });
        return { queued: true };
      },
      { behavior: "immediate" },
    );
  }

  /**
   * Stores a pending initial recommendation with its evidence rows and approval request. Call inside
   * the caller's immediate transaction; returns null when one is already pending (a race).
   * Nothing here logs or emits profile text.
   */
  storeInitial(
    tx: DbOrTx,
    input: { personId: string; runId: string; content: ProfileContent; evidence: EvidenceRow[] },
  ): { recommendationId: string; approvalId: string } | null {
    const { clock, events, approvals } = this.deps;
    if (this.hasPending(tx, input.personId)) return null;
    const recommendationId = newId();
    tx.insert(peopleProfileRecommendations)
      .values({
        id: recommendationId,
        personId: input.personId,
        kind: "initial",
        content: input.content,
        observationHash: observationHash(input.content),
        status: "pending",
        claudeRunId: input.runId,
        createdAt: isoNow(clock),
      })
      .run();
    for (const e of input.evidence) {
      tx.insert(peopleProfileEvidence)
        .values({ id: newId(), recommendationId, ...e })
        .run();
    }
    const approval = approvals.request(tx, {
      action: "records.update",
      targetIntegration: "people",
      targetRef: input.personId,
      payload: { recommendationId },
      riskLevel: "low",
      idempotencyKey: `people.rec:${recommendationId}`,
      requestedByModule: "people",
    });
    tx.update(peopleProfileRecommendations)
      .set({ approvalId: approval.id })
      .where(eq(peopleProfileRecommendations.id, recommendationId))
      .run();
    events.publish(tx, {
      type: "person.profile_recommendation_created",
      aggregateType: "person",
      aggregateId: input.personId,
      correlationId: newId(),
      payload: { recommendationId, personId: input.personId, kind: "initial" },
    });
    return { recommendationId, approvalId: approval.id };
  }

  personExists(tx: DbOrTx, personId: string): boolean {
    return (
      tx.select({ id: people.id }).from(people).where(eq(people.id, personId)).get() !== undefined
    );
  }
}
