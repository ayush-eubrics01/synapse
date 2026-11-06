import {
  type CandidatesResponse,
  type Confidence,
  type EvidenceView,
  type ObservationView,
  type PeopleAction,
  type PersonDetail,
  type ProfileContent,
  type ProfileSection,
  profileContentSchema,
  profileUpdateOutputSchema,
  type RecommendationStatus,
  type RecommendationView,
  type RemovedObservationView,
} from "@synapse/contracts";
import { type Db, schema } from "@synapse/database";
import type { Clock } from "@synapse/shared";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { SettingsService } from "../../core/config/settings";
import { safePermalink } from "../inbox/permalink";
import type { ContactDiscovery } from "./discovery";
import type { ProfileService } from "./profiles";
import { isDiscardable, removalEvidenceKey } from "./recommendations";
import type { PeopleService } from "./service";

const {
  people,
  peopleProfiles,
  peopleProfileRecommendations: recs,
  peopleProfileEvidence: evidenceTable,
  peoplePrioritySettings,
  slackUsers,
  slackMessages,
  securityFlags,
  temporaryContacts,
  approvals,
} = schema;

export interface PeopleViewsDeps {
  db: Db;
  clock: Clock;
  settings: SettingsService;
  people: PeopleService;
  discovery: ContactDiscovery;
  profileStore: ProfileService;
}

const SECTIONS: ProfileSection[] = ["professionalContext", "communication", "responseGuidelines"];
const MAX_LIST = 100;

/**
 * Read models for the People Memory routes. Profile and message text leave only through these
 * return values (route responses); nothing here logs or emits it. The server decides `actions`.
 */
export class PeopleViews {
  constructor(private readonly deps: PeopleViewsDeps) {}

  slackUserExists(slackUserId: string): boolean {
    return (
      this.deps.db
        .select({ id: slackUsers.id })
        .from(slackUsers)
        .where(eq(slackUsers.externalId, slackUserId))
        .get() !== undefined
    );
  }

  candidates(limit: number): CandidatesResponse {
    const identityRequired = this.deps.settings.get("slack.selfUserId") === null;
    const candidates = this.deps.discovery.listContactCandidates({ limit }).map((c) => ({
      ...c,
      actions: (!c.hasProfile && !c.hasPendingRecommendation ? ["evaluate"] : []) as PeopleAction[],
    }));
    return { identityRequired, candidates };
  }

  /** Null for an unknown Slack user. A known user without a person row is shown as an empty person. */
  personDetail(slackUserId: string): PersonDetail | null {
    const { db, profileStore } = this.deps;
    const user = db
      .select({ name: slackUsers.name, email: slackUsers.email })
      .from(slackUsers)
      .where(eq(slackUsers.externalId, slackUserId))
      .get();
    if (!user) return null;
    const person = db.select().from(people).where(eq(people.slackUserId, slackUserId)).get();
    const prio = this.deps.people.getPriorityBySlackUser(slackUserId);
    const rationale = person
      ? (db
          .select({ r: peoplePrioritySettings.rationale })
          .from(peoplePrioritySettings)
          .where(eq(peoplePrioritySettings.personId, person.id))
          .get()?.r ?? null)
      : null;
    const profile = person ? profileStore.getProfile(person.id) : null;
    const hasPending = person
      ? db
          .select({ id: recs.id })
          .from(recs)
          .where(and(eq(recs.personId, person.id), eq(recs.status, "pending")))
          .limit(1)
          .get() !== undefined
      : false;
    const temp = db
      .select()
      .from(temporaryContacts)
      .where(eq(temporaryContacts.slackUserId, slackUserId))
      .get();
    const flagCount =
      db
        .select({ n: sql<number>`count(*)` })
        .from(securityFlags)
        .where(eq(securityFlags.slackUserId, slackUserId))
        .get()?.n ?? 0;
    return {
      slackUserId,
      name: person?.name ?? user.name,
      title: person?.title ?? null,
      team: person?.team ?? null,
      email: person?.email ?? user.email,
      priority: prio.priority,
      extraAttention: prio.extraAttention,
      rationale,
      hasProfile: profile !== null,
      profileVersion: profile?.version ?? null,
      hasPendingRecommendation: hasPending,
      profile,
      versions: person ? profileStore.listVersions(person.id) : [],
      temporaryContact: temp
        ? {
            firstSeenAt: temp.firstSeenAt,
            lastSeenAt: temp.lastSeenAt,
            messageCount: temp.messageCount,
            expiresAt: temp.expiresAt,
          }
        : null,
      flagCount,
      actions: !profile && !hasPending ? ["evaluate"] : [],
    };
  }

  listRecommendations(status: RecommendationStatus): RecommendationView[] {
    const { db } = this.deps;
    const rows = db
      .select({
        rec: recs,
        slackUserId: people.slackUserId,
        name: sql<string | null>`coalesce(${people.name}, ${slackUsers.name})`,
        approvalStatus: approvals.status,
        approvalDecidedAt: approvals.decidedAt,
      })
      .from(recs)
      .innerJoin(people, eq(people.id, recs.personId))
      .leftJoin(slackUsers, eq(slackUsers.externalId, people.slackUserId))
      .leftJoin(approvals, eq(approvals.id, recs.approvalId))
      .where(eq(recs.status, status))
      .orderBy(desc(recs.createdAt), asc(recs.id))
      .limit(MAX_LIST)
      .all();
    return rows.map((r) => {
      const evidence = this.evidenceFor(r.rec.id);
      const view: RecommendationView = {
        id: r.rec.id,
        kind: r.rec.kind,
        status: r.rec.status,
        person: { slackUserId: r.slackUserId, name: r.name },
        baseVersion: r.rec.baseVersion,
        proposed: null,
        diff: null,
        approvalId: r.rec.approvalId,
        approvalStatus: r.approvalStatus ?? null,
        actions: [],
        reason: r.rec.reason,
        createdAt: r.rec.createdAt,
      };
      let readable = true;
      if (r.rec.kind === "initial") {
        const parsed = profileContentSchema.safeParse(r.rec.content);
        if (parsed.success) view.proposed = observations(parsed.data, evidence);
        readable = parsed.success;
      } else if (r.rec.kind === "update") {
        const parsed = profileUpdateOutputSchema.safeParse(r.rec.content);
        if (parsed.success) view.diff = this.diffView(r.rec.personId, parsed.data, evidence);
        readable = parsed.success;
      }
      const approval = r.approvalStatus
        ? { status: r.approvalStatus, decidedAt: r.approvalDecidedAt ?? null }
        : null;
      view.actions = actionsFor(r.rec, approval, readable, this.deps.clock.now());
      return view;
    });
  }

  private diffView(
    personId: string,
    diff: ReturnType<typeof profileUpdateOutputSchema.parse>,
    evidence: Map<string, EvidenceView[]>,
  ): { added: ObservationView[]; removed: RemovedObservationView[] } {
    const row = this.deps.db
      .select({ content: peopleProfiles.content })
      .from(peopleProfiles)
      .where(eq(peopleProfiles.personId, personId))
      .get();
    const current = profileContentSchema.safeParse(row?.content);
    return {
      added: diff.add.map((o) => ({
        section: o.section,
        key: o.key,
        text: o.text,
        confidence: o.confidence,
        evidence: evidence.get(`${o.section}.${o.key}`) ?? [],
      })),
      removed: diff.remove.map((o) => ({
        section: o.section,
        key: o.key,
        text: current.success
          ? (current.data[o.section].find((x) => x.key === o.key)?.text ?? null)
          : null,
        // R7 M-3: the removal's own citations, never the evidence of an add with the same key.
        evidence: evidence.get(removalEvidenceKey(o.section, o.key)) ?? [],
      })),
    };
  }

  /** Evidence of one recommendation grouped by `<section>.<key>`. */
  private evidenceFor(recommendationId: string): Map<string, EvidenceView[]> {
    const rows = this.deps.db
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
      .where(eq(evidenceTable.recommendationId, recommendationId))
      .orderBy(asc(evidenceTable.observedAt), asc(evidenceTable.id))
      .all();
    const out = new Map<string, EvidenceView[]>();
    for (const r of rows) {
      const messageAvailable = r.messageId !== null && r.text !== null;
      const list = out.get(r.observationKey) ?? [];
      list.push({
        observationKey: r.observationKey,
        sourceExternalRef: r.sourceExternalRef,
        messageAvailable,
        confidence: r.confidence as Confidence,
        permalink: messageAvailable ? safePermalink(r.permalink) : null,
      });
      out.set(r.observationKey, list);
    }
    return out;
  }
}

function observations(
  content: ProfileContent,
  evidence: Map<string, EvidenceView[]>,
): ObservationView[] {
  return SECTIONS.flatMap((section) =>
    content[section].map((o) => ({
      section,
      key: o.key,
      text: o.text,
      confidence: o.confidence,
      evidence: evidence.get(`${section}.${o.key}`) ?? [],
    })),
  );
}

function actionsFor(
  rec: { kind: string; status: string },
  approval: { status: string; decidedAt: string | null } | null,
  readable: boolean,
  now: Date,
): PeopleAction[] {
  if (rec.status !== "pending") return [];
  if (rec.kind === "suggest_evaluation") return ["evaluate", "dismiss"];
  // Unparsable content is never shown, so it must not be approvable; rejecting stays possible.
  if (approval?.status === "pending") return readable ? ["approve", "reject"] : ["reject"];
  const actions: PeopleAction[] = approval?.status === "failed" ? ["retry"] : [];
  // R6: a stuck recommendation (its approval can no longer apply it) can be discarded.
  if (isDiscardable(rec, approval, now)) actions.push("discard");
  return actions;
}
