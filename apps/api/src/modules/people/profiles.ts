import {
  type Approval,
  type Confidence,
  type EvidenceView,
  type Observation,
  type ProfileContent,
  type ProfileSection,
  type ProfileUpdateOutput,
  profileContentSchema,
  profileUpdateOutputSchema,
} from "@synapse/contracts";
import { type Db, type DbOrTx, schema } from "@synapse/database";
import { type Clock, isoNow, newId } from "@synapse/shared";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { ApprovalEngine } from "../../core/approvals/approvals";
import { registerIntegrationExecutor } from "../../core/approvals/execution";
import type { AuditLogger } from "../../core/audit/audit";
import type { OutboxDispatcher } from "../../core/events/dispatcher";
import type { EventPublisher } from "../../core/events/publisher";
import { safePermalink } from "../inbox/permalink";

const {
  peopleProfiles,
  peopleProfileVersions,
  peopleProfileRecommendations: recs,
  peopleProfileEvidence: evidenceTable,
  slackMessages,
  approvals: approvalsTable,
} = schema;

const SECTIONS = ["professionalContext", "communication", "responseGuidelines"] as const;
const payloadSchema = z.object({ recommendationId: z.string().min(1) });
const DECISIONS_CONSUMER = "people.decisions";

export interface ProfileServiceDeps {
  db: Db;
  clock: Clock;
  events: EventPublisher;
  audit: AuditLogger;
}

export interface ProfileView {
  version: number;
  content: ProfileContent;
  updatedAt: string;
  evidence: EvidenceView[];
}

export type ApplyResult =
  | { status: "applied"; version: number }
  | {
      status: "skipped";
      reason:
        | "recommendation_not_pending"
        | "approval_mismatch"
        | "stale_base"
        | "profile_exists"
        | "unsupported_kind";
    };

/** Content-free by construction: the engine stores `message` in the approval and audit row. */
export class ProfileApplyError extends Error {
  constructor(
    readonly code: "invalid_payload" | "recommendation_not_found" | "profile_write_failed",
  ) {
    super(code);
    this.name = "ProfileApplyError";
  }
}

const keyOf = (section: ProfileSection, key: string) => `${section}.${key}`;

/** Applies approved profile recommendations as versions, handles rejection, and reads profiles. */
export class ProfileService {
  constructor(private readonly deps: ProfileServiceDeps) {}

  /** Wires the `records.update`/`people` executor and the rejection/expiry consumers. */
  register(engine: ApprovalEngine, dispatcher: Pick<OutboxDispatcher, "subscribe">): void {
    registerIntegrationExecutor(engine, "records.update", "people", {
      execute: async (a) => this.apply(a),
    });
    // R6: a revoked approval can never apply either, so it rejects the recommendation too.
    const decisions = {
      "approval.rejected": { status: "rejected", reason: null },
      "approval.revoked": { status: "rejected", reason: "revoked" },
      "approval.expired": { status: "expired", reason: null },
    } as const;
    for (const [type, decision] of Object.entries(decisions) as [
      keyof typeof decisions,
      (typeof decisions)[keyof typeof decisions],
    ][]) {
      dispatcher.subscribe(type, DECISIONS_CONSUMER, (event, tx) => {
        const approvalId = (event.payload as { approvalId?: unknown }).approvalId;
        if (typeof approvalId !== "string") return;
        try {
          // Savepoint: a failure rolls back this decision only, never half of it.
          tx.transaction((sp) =>
            this.recordDecision(sp, approvalId, decision.status, decision.reason),
          );
        } catch (e) {
          // Ids and the error class only; the recommendation stays pending and can be discarded.
          console.error(
            `people decision failed approval=${approvalId} error=${e instanceof Error ? e.name : "unknown"}`,
          );
        }
      });
    }
  }

  /** Runs in one immediate transaction. Throws only content-free messages (the engine stores them). */
  apply(approval: Approval): ApplyResult {
    const payload = payloadSchema.safeParse(approval.payload);
    if (!payload.success) throw new ProfileApplyError("invalid_payload");
    try {
      return this.deps.db.transaction(
        (tx) => this.applyIn(tx, approval, payload.data.recommendationId),
        {
          behavior: "immediate",
        },
      );
    } catch (e) {
      if (e instanceof ProfileApplyError) throw e;
      throw new ProfileApplyError("profile_write_failed");
    }
  }

  private applyIn(tx: DbOrTx, approval: Approval, recommendationId: string): ApplyResult {
    const { clock, events, audit } = this.deps;
    const rec = tx.select().from(recs).where(eq(recs.id, recommendationId)).get();
    if (!rec) throw new ProfileApplyError("recommendation_not_found");
    if (rec.status !== "pending")
      return { status: "skipped", reason: "recommendation_not_pending" };
    // R7 M-4: only the recommendation's current approval may act on it (a stale or stray approval
    // with the same payload changes nothing).
    if (rec.approvalId !== approval.id) return { status: "skipped", reason: "approval_mismatch" };
    const now = isoNow(clock);
    const profile = tx
      .select()
      .from(peopleProfiles)
      .where(eq(peopleProfiles.personId, rec.personId))
      .get();

    const supersede = (
      reason: "stale_base" | "profile_exists" | "unsupported_kind",
    ): ApplyResult => {
      tx.update(recs)
        .set({ status: "superseded", reason, decidedAt: now })
        .where(eq(recs.id, rec.id))
        .run();
      events.publish(tx, {
        type: "person.recommendation_decided",
        aggregateType: "person",
        aggregateId: rec.personId,
        correlationId: newId(),
        payload: { recommendationId: rec.id, status: "superseded" },
      });
      return { status: "skipped", reason };
    };

    if (rec.kind === "suggest_evaluation") return supersede("unsupported_kind");

    let content: ProfileContent;
    let touched: Set<string> | null = null; // update only: keys changed by the diff
    if (rec.kind === "initial") {
      if (profile) return supersede("profile_exists");
      const parsed = profileContentSchema.safeParse(rec.content);
      if (!parsed.success) throw new ProfileApplyError("profile_write_failed");
      content = parsed.data;
    } else {
      if (!profile || rec.baseVersion !== profile.currentVersion) return supersede("stale_base");
      const diff = profileUpdateOutputSchema.safeParse(rec.content);
      const base = profileContentSchema.safeParse(profile.content);
      if (!diff.success || !base.success) throw new ProfileApplyError("profile_write_failed");
      touched = new Set();
      content = applyDiff(base.data, diff.data, touched);
    }

    const version = (profile?.currentVersion ?? 0) + 1;
    const profileId = profile?.id ?? newId();
    if (profile) {
      tx.update(peopleProfiles)
        .set({ currentVersion: version, content, updatedAt: now })
        .where(eq(peopleProfiles.id, profileId))
        .run();
    } else {
      tx.insert(peopleProfiles)
        .values({
          id: profileId,
          personId: rec.personId,
          currentVersion: version,
          content,
          updatedAt: now,
        })
        .run();
    }
    const versionId = newId();
    tx.insert(peopleProfileVersions)
      .values({
        id: versionId,
        profileId,
        version,
        content,
        recommendationId: rec.id,
        approvalId: approval.id,
        createdAt: now,
      })
      .run();

    const present = new Set(SECTIONS.flatMap((s) => content[s].map((o) => keyOf(s, o.key))));
    const copy = (from: typeof evidenceTable.$inferSelect) =>
      tx
        .insert(evidenceTable)
        .values({
          id: newId(),
          versionId,
          observationKey: from.observationKey,
          messageId: from.messageId,
          sourceExternalRef: from.sourceExternalRef,
          confidence: from.confidence,
          observedAt: from.observedAt,
        })
        .run();
    if (touched && profile) {
      const prev = tx
        .select({ id: peopleProfileVersions.id })
        .from(peopleProfileVersions)
        .where(
          and(
            eq(peopleProfileVersions.profileId, profileId),
            eq(peopleProfileVersions.version, version - 1),
          ),
        )
        .get();
      if (prev) {
        for (const e of tx
          .select()
          .from(evidenceTable)
          .where(eq(evidenceTable.versionId, prev.id))
          .all()) {
          if (present.has(e.observationKey) && !touched.has(e.observationKey)) copy(e);
        }
      }
    }
    for (const e of tx
      .select()
      .from(evidenceTable)
      .where(eq(evidenceTable.recommendationId, rec.id))
      .all()) {
      // initial: all rows; update: only changed keys, the rest were carried from the previous version
      if (present.has(e.observationKey) && (!touched || touched.has(e.observationKey))) copy(e);
    }

    tx.update(recs).set({ status: "applied", decidedAt: now }).where(eq(recs.id, rec.id)).run();
    events.publish(tx, {
      type: "person.profile_approved",
      aggregateType: "person",
      aggregateId: rec.personId,
      correlationId: newId(),
      payload: { personId: rec.personId, version },
    });
    audit.record(tx, {
      actor: "system",
      module: "people",
      action: "people.profile_applied",
      targetIntegration: "people",
      targetRef: rec.personId,
      approvalId: approval.id,
      result: "applied",
      details: { recommendationId: rec.id, personId: rec.personId, version },
    });
    return { status: "applied", version };
  }

  /** Runs in a savepoint inside the dispatcher's delivery of approval.rejected/revoked/expired. */
  private recordDecision(
    tx: DbOrTx,
    approvalId: string,
    status: "rejected" | "expired",
    reason: "revoked" | null,
  ): void {
    const approval = tx
      .select({ target: approvalsTable.targetIntegration })
      .from(approvalsTable)
      .where(eq(approvalsTable.id, approvalId))
      .get();
    if (approval?.target !== "people") return;
    const rec = tx
      .select({ id: recs.id, personId: recs.personId })
      .from(recs)
      .where(and(eq(recs.approvalId, approvalId), eq(recs.status, "pending")))
      .get();
    if (!rec) return;
    tx.update(recs)
      .set({ status, decidedAt: isoNow(this.deps.clock), ...(reason ? { reason } : {}) })
      .where(eq(recs.id, rec.id))
      .run();
    this.deps.events.publish(tx, {
      type: "person.recommendation_decided",
      aggregateType: "person",
      aggregateId: rec.personId,
      correlationId: newId(),
      payload: { recommendationId: rec.id, status },
    });
  }

  getProfile(personId: string): ProfileView | null {
    const { db } = this.deps;
    const profile = db
      .select()
      .from(peopleProfiles)
      .where(eq(peopleProfiles.personId, personId))
      .get();
    if (!profile) return null;
    const content = profileContentSchema.parse(profile.content);
    const version = db
      .select({ id: peopleProfileVersions.id })
      .from(peopleProfileVersions)
      .where(
        and(
          eq(peopleProfileVersions.profileId, profile.id),
          eq(peopleProfileVersions.version, profile.currentVersion),
        ),
      )
      .get();
    const rows = version
      ? db
          .select({
            observationKey: evidenceTable.observationKey,
            sourceExternalRef: evidenceTable.sourceExternalRef,
            confidence: evidenceTable.confidence,
            messageId: slackMessages.id,
            text: slackMessages.text,
            permalink: slackMessages.permalink,
          })
          .from(evidenceTable)
          .leftJoin(slackMessages, eq(slackMessages.id, evidenceTable.messageId))
          .where(eq(evidenceTable.versionId, version.id))
          .orderBy(asc(evidenceTable.observedAt), asc(evidenceTable.id))
          .all()
      : [];
    const evidence: EvidenceView[] = rows.map((r) => {
      const messageAvailable = r.messageId !== null && r.text !== null;
      return {
        observationKey: r.observationKey,
        sourceExternalRef: r.sourceExternalRef,
        messageAvailable,
        confidence: r.confidence as Confidence,
        permalink: messageAvailable ? safePermalink(r.permalink) : null,
      };
    });
    return { version: profile.currentVersion, content, updatedAt: profile.updatedAt, evidence };
  }

  listVersions(
    personId: string,
  ): { version: number; createdAt: string; approvalId: string | null }[] {
    return this.deps.db
      .select({
        version: peopleProfileVersions.version,
        createdAt: peopleProfileVersions.createdAt,
        approvalId: peopleProfileVersions.approvalId,
      })
      .from(peopleProfileVersions)
      .innerJoin(peopleProfiles, eq(peopleProfiles.id, peopleProfileVersions.profileId))
      .where(eq(peopleProfiles.personId, personId))
      .orderBy(asc(peopleProfileVersions.version))
      .all();
  }

  /** Current response guidelines (text and key, as stored), or [] without a profile. */
  getResponseGuidelines(personId: string): Observation[] {
    const row = this.deps.db
      .select({ content: peopleProfiles.content })
      .from(peopleProfiles)
      .where(eq(peopleProfiles.personId, personId))
      .get();
    if (!row) return [];
    const parsed = profileContentSchema.safeParse(row.content);
    return parsed.success ? parsed.data.responseGuidelines : [];
  }
}

export function applyDiff(
  base: ProfileContent,
  diff: ProfileUpdateOutput,
  touched: Set<string>,
): ProfileContent {
  const out: ProfileContent = {
    professionalContext: [...base.professionalContext],
    communication: [...base.communication],
    responseGuidelines: [...base.responseGuidelines],
  };
  for (const r of diff.remove) {
    out[r.section] = out[r.section].filter((o) => o.key !== r.key);
    touched.add(keyOf(r.section, r.key));
  }
  for (const { section, ...o } of diff.add) {
    out[section] = [...out[section].filter((x) => x.key !== o.key), o];
    touched.add(keyOf(section, o.key));
  }
  return out;
}
