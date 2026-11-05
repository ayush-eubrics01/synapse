import type { DomainEvent, EventType, ScreeningRecord } from "@synapse/contracts";
import { type Db, type DbOrTx, schema, type Tx } from "@synapse/database";
import type { Clock } from "@synapse/shared";
import { and, eq, or } from "drizzle-orm";
import type { SettingsService } from "../../core/config/settings";
import type { EventPublisher } from "../../core/events/publisher";
import type { JobQueue } from "../../core/jobs/queue";
import { invalidKeywordIds, screenMessage } from "../../intelligence/screening/screen";
import type { PeopleService } from "../people/service";
import type { SecurityFlagsService } from "../security-flags/service";

const { slackMessages, slackConversations, slackUsers } = schema;

export interface ScreeningServiceDeps {
  db: Db;
  clock: Clock;
  events: EventPublisher;
  queue: JobQueue;
  settings: SettingsService;
  people: PeopleService;
  securityFlags: SecurityFlagsService;
}

const EMPTY: Pick<ScreeningRecord, "candidate" | "score" | "ruleLevel" | "matchedRules"> & {
  urgencySignals: string[];
} = { candidate: false, score: 0, ruleLevel: "low", matchedRules: [], urgencySignals: [] };

/**
 * Rule screening of every stored Slack message (no AI). The screening JSON holds rule ids, scores
 * and flags only, never message text. `handle` never throws: the outbox chain and message storage
 * must not depend on screening.
 */
export class ScreeningService {
  constructor(private readonly deps: ScreeningServiceDeps) {}

  /** Ids of user-edited keyword rules that are not valid regexes (skipped while screening). */
  invalidKeywordIds(): string[] {
    return invalidKeywordIds(this.deps.settings.get("urgency.rules.keywords"));
  }

  handle(event: DomainEvent<EventType>, tx: Tx): void {
    const messageId = (event.payload as { messageId?: unknown }).messageId;
    if (typeof messageId !== "string") return;
    try {
      this.screen(messageId, event.correlationId, tx);
    } catch {
      // Message id only: no error text, which could echo content.
      console.error(`screening failed for message ${messageId}`);
      try {
        const existing = this.existing(tx, messageId);
        tx.update(slackMessages)
          .set({
            screening: {
              version: 1,
              ...EMPTY,
              route: "batch",
              ...this.preserved(existing),
              error: true,
            } satisfies ScreeningRecord,
          })
          .where(eq(slackMessages.id, messageId))
          .run();
      } catch {
        // Nothing more can be done; never block the consumer chain.
      }
    }
  }

  private existing(tx: DbOrTx, messageId: string): Partial<ScreeningRecord> | null {
    const row = tx
      .select({ screening: slackMessages.screening })
      .from(slackMessages)
      .where(eq(slackMessages.id, messageId))
      .get();
    const s = row?.screening;
    return s && typeof s === "object" ? (s as Partial<ScreeningRecord>) : null;
  }

  private preserved(existing: Partial<ScreeningRecord> | null) {
    return {
      assessed: existing?.assessed === true,
      ...(existing?.fallback !== undefined ? { fallback: existing.fallback } : {}),
      ...(existing?.notified !== undefined ? { notified: existing.notified } : {}),
    };
  }

  private screen(messageId: string, correlationId: string, tx: Tx): void {
    const { settings, clock } = this.deps;
    const m = tx
      .select({
        id: slackMessages.id,
        conversationId: slackMessages.conversationId,
        ts: slackMessages.ts,
        threadTs: slackMessages.threadTs,
        text: slackMessages.text,
        sentAt: slackMessages.sentAt,
        conversationType: slackConversations.type,
        conversationRef: slackConversations.externalId,
        senderRef: slackUsers.externalId,
      })
      .from(slackMessages)
      .innerJoin(slackConversations, eq(slackConversations.id, slackMessages.conversationId))
      .innerJoin(slackUsers, eq(slackUsers.id, slackMessages.senderUserId))
      .where(eq(slackMessages.id, messageId))
      .get();
    if (!m) return;

    const existing = this.existing(tx, messageId);
    const keep = this.preserved(existing);
    const selfId = settings.get("slack.selfUserId");
    const writeRec = (
      rec: Omit<ScreeningRecord, "version" | "assessed" | "fallback" | "notified">,
      on: DbOrTx = tx,
    ) => {
      const record: ScreeningRecord = { version: 1, ...rec, ...keep };
      on.update(slackMessages)
        .set({ screening: record })
        .where(eq(slackMessages.id, messageId))
        .run();
      return record;
    };

    if (m.text === null) {
      writeRec({ ...EMPTY, route: "skip", skipReason: "expired" });
      return;
    }
    if (selfId !== null && m.senderRef === selfId) {
      writeRec({ ...EMPTY, route: "skip", skipReason: "own" });
      return;
    }

    const mentionsSelf = selfId !== null && mentionsUser(m.text, selfId);
    const inThreadWithSelf = selfId !== null && this.inThreadWithSelf(tx, m, selfId);

    // A detector failure must not stop screening; the savepoint drops its partial writes.
    let securityFlag = false;
    try {
      securityFlag = tx.transaction((t) =>
        this.deps.securityFlags.scanMessage(t, {
          messageId: m.id,
          slackUserId: m.senderRef,
          conversationId: m.conversationId,
          externalRef: `${m.conversationRef}:${m.ts}`,
          text: m.text as string,
        }),
      ).flagged;
    } catch {
      console.error(`security scan failed for message ${messageId}`);
    }

    const prio = this.deps.people.getPriorityBySlackUser(m.senderRef);
    const result = screenMessage(
      {
        text: m.text,
        conversationType: m.conversationType,
        mentionsSelf,
        inThreadWithSelf,
        priority: prio.priority,
        extraAttention: prio.extraAttention,
      },
      {
        keywords: settings.get("urgency.rules.keywords"),
        threshold: settings.get("urgency.candidateThreshold"),
      },
    );

    const cutoff = clock.now().getTime() - settings.get("urgency.maxAgeHours") * 3_600_000;
    let route: ScreeningRecord["route"] = "batch";
    let skipReason: ScreeningRecord["skipReason"];
    if (result.candidate) {
      if (Date.parse(m.sentAt) >= cutoff) route = "assess";
      else {
        route = "skip";
        skipReason = "too_old";
      }
    }
    // One savepoint: a failed publish or enqueue leaves no record, event or job behind.
    tx.transaction((t) => {
      writeRec({ ...result, route, ...(skipReason ? { skipReason } : {}) }, t);

      this.deps.events.publish(t, {
        type: "message.screened",
        aggregateType: "slack_message",
        aggregateId: messageId,
        correlationId,
        payload: {
          messageId,
          candidate: result.candidate,
          score: result.score,
          securityFlag,
        },
      });

      if (route === "assess" && !keep.assessed) {
        const window = settings.get("urgency.assess.batchWindowSeconds");
        const bucket = Math.floor(clock.now().getTime() / 1000 / window) * window;
        this.deps.queue.enqueue(t, {
          type: "urgency.assess",
          idempotencyKey: `urgency.batch:${bucket}`,
          runAfter: new Date((bucket + window) * 1000).toISOString(),
          priority: 200,
        });
      }
    });
  }

  private inThreadWithSelf(
    tx: DbOrTx,
    m: { conversationId: string; threadTs: string | null },
    selfId: string,
  ): boolean {
    if (m.threadTs === null) return false;
    const hit = tx
      .select({ id: slackMessages.id })
      .from(slackMessages)
      .innerJoin(slackUsers, eq(slackUsers.id, slackMessages.senderUserId))
      .where(
        and(
          eq(slackMessages.conversationId, m.conversationId),
          eq(slackUsers.externalId, selfId),
          or(eq(slackMessages.threadTs, m.threadTs), eq(slackMessages.ts, m.threadTs)),
        ),
      )
      .limit(1)
      .get();
    return hit !== undefined;
  }
}

function mentionsUser(text: string, userId: string): boolean {
  // `<@U123>`, `<@U123|name>` and the unescaped `@U123`, but not a longer id with the same prefix.
  const at = `@${userId}`;
  let i = text.indexOf(at);
  while (i !== -1) {
    const next = text[i + at.length];
    if (next === undefined || !/[A-Z0-9]/.test(next)) return true;
    i = text.indexOf(at, i + 1);
  }
  return false;
}
