import { type Db, type DbOrTx, schema } from "@synapse/database";
import { type Clock, isoNow, newId } from "@synapse/shared";
import { countDistinct, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { AuditLogger } from "../../core/audit/audit";
import type { SettingsService } from "../../core/config/settings";
import type { EventPublisher } from "../../core/events/publisher";

export type PersonPriority = "normal" | "high" | "critical";

export interface PriorityInfo {
  priority: PersonPriority;
  extraAttention: boolean;
}

export interface PersonListItem extends PriorityInfo {
  slackUserId: string;
  name: string | null;
}

export interface PeopleServiceDeps {
  db: Db;
  clock: Clock;
  events: EventPublisher;
  audit: AuditLogger;
  settings: SettingsService;
}

const prioritySchema = z.enum(["normal", "high", "critical"]);
const slackUserIdSchema = z.string().regex(/^[UW][A-Z0-9]+$/);
/** The suggestion needs the sender in at least this many distinct DMs. */
const MIN_SELF_DM_CONVERSATIONS = 2;

const { people, peoplePrioritySettings, slackUsers, slackMessages, slackConversations } = schema;

/**
 * People and their priority. Priority is set by the user only: nothing here is
 * reachable from a Claude run, and the model never proposes it.
 */
export class PeopleService {
  constructor(private readonly deps: PeopleServiceDeps) {}

  /** Upserts the person for a Slack user from its `slack_users` row; returns the person id. */
  ensurePerson(tx: DbOrTx, slackUserId: string): string {
    const user = tx
      .select({ name: slackUsers.name, email: slackUsers.email })
      .from(slackUsers)
      .where(eq(slackUsers.externalId, slackUserId))
      .get();
    tx.insert(people)
      .values({
        id: newId(),
        slackUserId,
        name: user?.name ?? null,
        email: user?.email ?? null,
        createdAt: isoNow(this.deps.clock),
      })
      .onConflictDoNothing({ target: people.slackUserId })
      .run();
    const row = tx
      .select({ id: people.id })
      .from(people)
      .where(eq(people.slackUserId, slackUserId))
      .get();
    if (!row) throw new Error("person row vanished");
    return row.id;
  }

  getPriorityBySlackUser(slackUserId: string): PriorityInfo {
    const row = this.deps.db
      .select({
        priority: peoplePrioritySettings.priority,
        extraAttention: peoplePrioritySettings.extraAttention,
      })
      .from(people)
      .innerJoin(peoplePrioritySettings, eq(peoplePrioritySettings.personId, people.id))
      .where(eq(people.slackUserId, slackUserId))
      .get();
    return row ?? { priority: "normal", extraAttention: false };
  }

  setPriority(
    slackUserId: string,
    input: { priority: PersonPriority; rationale?: string; extraAttention?: boolean },
  ): void {
    const priority = prioritySchema.parse(input.priority);
    const { db, clock } = this.deps;
    db.transaction(
      (tx) => {
        const known = tx
          .select({ id: slackUsers.id })
          .from(slackUsers)
          .where(eq(slackUsers.externalId, slackUserId))
          .get();
        if (!known) throw new Error("unknown slack user");
        const personId = this.ensurePerson(tx, slackUserId);
        const extraAttention = input.extraAttention ?? false;
        const rationale = input.rationale ?? null;
        const updatedAt = isoNow(clock);
        tx.insert(peoplePrioritySettings)
          .values({ id: newId(), personId, priority, rationale, extraAttention, updatedAt })
          .onConflictDoUpdate({
            target: peoplePrioritySettings.personId,
            set: { priority, rationale, extraAttention, updatedAt },
          })
          .run();
        this.deps.audit.record(tx, {
          actor: "user",
          module: "people",
          action: "people.priority_set",
          targetRef: personId,
          result: "ok",
          details: { personId, slackUserId, priority, extraAttention },
        });
        const key = `people.priority:${slackUserId}`;
        this.deps.events.publish(tx, {
          type: "settings.changed",
          aggregateType: "settings",
          aggregateId: key,
          correlationId: newId(),
          payload: { key },
        });
      },
      { behavior: "immediate" },
    );
  }

  listPeople(): PersonListItem[] {
    return this.deps.db
      .select({
        slackUserId: slackUsers.externalId,
        name: slackUsers.name,
        priority: peoplePrioritySettings.priority,
        extraAttention: peoplePrioritySettings.extraAttention,
      })
      .from(slackUsers)
      .leftJoin(people, eq(people.slackUserId, slackUsers.externalId))
      .leftJoin(peoplePrioritySettings, eq(peoplePrioritySettings.personId, people.id))
      .orderBy(slackUsers.name, slackUsers.externalId)
      .all()
      .map((r) => ({
        slackUserId: r.slackUserId,
        name: r.name,
        priority: r.priority ?? "normal",
        extraAttention: r.extraAttention ?? false,
      }));
  }

  /** The sender present in the most distinct DMs; null below two such DMs. */
  suggestSelfUserId(): string | null {
    const dmCount = countDistinct(slackMessages.conversationId);
    const rows = this.deps.db
      .select({ slackUserId: slackUsers.externalId, dms: dmCount })
      .from(slackMessages)
      .innerJoin(slackConversations, eq(slackMessages.conversationId, slackConversations.id))
      .innerJoin(slackUsers, eq(slackMessages.senderUserId, slackUsers.id))
      .where(eq(slackConversations.type, "im"))
      .groupBy(slackUsers.externalId)
      .orderBy(desc(dmCount), slackUsers.externalId)
      .limit(2)
      .all();
    const top = rows[0];
    if (!top || top.dms < MIN_SELF_DM_CONVERSATIONS) return null;
    // A tie means no sender stands out as the user.
    if (rows[1] && rows[1].dms === top.dms) return null;
    return top.slackUserId;
  }

  confirmSelfUserId(id: string): void {
    const parsed = slackUserIdSchema.parse(id);
    const known = this.deps.db
      .select({ id: slackUsers.id })
      .from(slackUsers)
      .where(eq(slackUsers.externalId, parsed))
      .get();
    if (!known) throw new Error("unknown slack user");
    this.deps.settings.set("slack.selfUserId", parsed);
  }
}
