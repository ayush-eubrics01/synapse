import type {
  JiraAttention,
  JiraIssueView,
  JiraIssueViewKind,
  JiraSlackMentions,
  SourceIssue,
} from "@synapse/contracts";
import { type Db, type DbOrTx, schema, type Tx } from "@synapse/database";
import { type Clock, newId } from "@synapse/shared";
import { and, desc, eq, gte, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import type { SettingsService } from "../../core/config/settings";
import type { EventPublisher } from "../../core/events/publisher";
import { safePermalink } from "../inbox/permalink";
import { type AttentionSettings, attentionOf } from "./attention";

const { jiraIssues, slackMessages, slackConversations } = schema;
type Row = typeof jiraIssues.$inferSelect;

export interface MentionConversation {
  id: string;
  externalId: string;
  type: "im" | "mpim" | "channel";
  name: string | null;
}

export interface JiraStoreDeps {
  db: Db;
  clock: Clock;
  events: EventPublisher;
  settings: SettingsService;
  /** IANA zone for "today" in the attention rules; undefined means the process zone. */
  timeZone?: string;
  /** How a Slack mention's conversation is named; the container injects the shared label. */
  conversationLabel?: (tx: DbOrTx, conv: MentionConversation) => string;
}

export interface UpsertResult {
  inserted: number;
  updated: number;
  unchanged: number;
  /** Issues of an excluded project, never stored (spec B7). */
  dropped: number;
  /** Keys stored or refreshed by this page. */
  keys: string[];
  /** The newest `updated` instant on the page (excluded issues ignored). */
  maxUpdated: string | null;
}

const MENTIONS_SHOWN = 20;
const DAY_MS = 86_400_000;
const ATTENTION_RANK: Record<JiraAttention, number> = {
  overdue: 0,
  blocked: 1,
  due_soon: 2,
  stale: 3,
};

const defaultLabel = (_tx: DbOrTx, c: MentionConversation): string =>
  c.type === "channel" ? `#${c.name ?? c.externalId}` : c.type === "im" ? "a DM" : "a group DM";

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The fields a change to which is worth an event (spec B8). */
function notableChange(a: Row, b: SourceIssue, inScope: boolean): boolean {
  return (
    a.statusName !== b.statusName ||
    a.statusCategory !== b.statusCategory ||
    a.priority !== b.priority ||
    a.dueDate !== b.dueDate ||
    a.summary !== b.summary ||
    a.inScope !== inScope
  );
}

function dataChange(a: Row, b: SourceIssue): boolean {
  return (
    a.jiraId !== b.jiraId ||
    a.projectKey !== b.projectKey ||
    a.issueType !== b.issueType ||
    JSON.stringify(a.labels) !== JSON.stringify(b.labels) ||
    a.jiraCreatedAt !== b.createdAt ||
    a.jiraUpdatedAt !== b.updatedAt ||
    a.webUrl !== b.webUrl
  );
}

/**
 * Stored Jira issues (spec B8): upsert by key with change detection, the excluded-project drop
 * (B7), scope marking (B6), attention (B9) and Slack-mention correlation (B10). Issue text is
 * untrusted (ADR-032): it is stored and returned to the UI, never logged or put in events.
 */
export class JiraStore {
  private readonly label: (tx: DbOrTx, conv: MentionConversation) => string;

  constructor(private readonly deps: JiraStoreDeps) {
    this.label = deps.conversationLabel ?? defaultLabel;
  }

  private attentionSettings(): AttentionSettings {
    const s = this.deps.settings;
    return {
      staleDays: s.get("jira.stale.days"),
      dueSoonDays: s.get("jira.dueSoon.days"),
      blockedStatuses: s.get("jira.blockedStatuses"),
      ...(this.deps.timeZone !== undefined ? { timeZone: this.deps.timeZone } : {}),
    };
  }

  private publishUpdated(tx: Tx, key: string): void {
    this.deps.events.publish(tx, {
      type: "jira.issue_updated",
      aggregateType: "jira_issue",
      aggregateId: key,
      correlationId: newId(),
      payload: { key },
    });
  }

  private publishAttention(tx: Tx, key: string, attention: JiraAttention): void {
    this.deps.events.publish(tx, {
      type: "jira.issue_attention",
      aggregateType: "jira_issue",
      aggregateId: key,
      correlationId: newId(),
      payload: { key, attention },
    });
  }

  /**
   * Stores one page in one transaction. `setScope` marks every stored issue in scope (incremental
   * sync: the page matched the scope JQL). Reconcile passes false so an unfinished run changes no
   * existing scope flag; a new issue is inserted in scope either way.
   */
  upsertPage(issues: readonly SourceIssue[], opts: { setScope: boolean }): UpsertResult {
    const { db, clock, settings } = this.deps;
    const excluded = new Set(settings.get("jira.excludedProjects"));
    const att = this.attentionSettings();
    const result: UpsertResult = {
      inserted: 0,
      updated: 0,
      unchanged: 0,
      dropped: 0,
      keys: [],
      maxUpdated: null,
    };
    db.transaction(
      (tx) => {
        const nowDate = clock.now();
        const now = nowDate.toISOString();
        for (const i of issues) {
          if (excluded.has(i.projectKey)) {
            result.dropped++;
            continue;
          }
          result.keys.push(i.key);
          if (result.maxUpdated === null || i.updatedAt > result.maxUpdated) {
            result.maxUpdated = i.updatedAt;
          }
          const existing = tx.select().from(jiraIssues).where(eq(jiraIssues.key, i.key)).get();
          if (!existing) {
            const attention = attentionOf({ ...i, inScope: true }, nowDate, att);
            tx.insert(jiraIssues)
              .values({
                key: i.key,
                jiraId: i.jiraId,
                projectKey: i.projectKey,
                summary: i.summary,
                statusName: i.statusName,
                statusCategory: i.statusCategory,
                priority: i.priority,
                issueType: i.issueType,
                labels: i.labels,
                dueDate: i.dueDate,
                jiraCreatedAt: i.createdAt,
                jiraUpdatedAt: i.updatedAt,
                webUrl: i.webUrl,
                inScope: true,
                firstSeenAt: now,
                lastSeenAt: now,
                attention,
                attentionSince: attention ? now : null,
              })
              .run();
            this.publishUpdated(tx, i.key);
            if (attention) this.publishAttention(tx, i.key, attention);
            result.inserted++;
            continue;
          }
          const inScope = opts.setScope ? true : existing.inScope;
          // Data older than what is stored (an earlier read finishing late) never overwrites it.
          const fresh = i.updatedAt >= existing.jiraUpdatedAt;
          const src: SourceIssue = fresh ? i : rowToSource(existing);
          const notable = notableChange(existing, src, inScope);
          const changed = notable || (fresh && dataChange(existing, src));
          const attention = attentionOf({ ...src, inScope }, nowDate, att);
          const attentionChanged = attention !== existing.attention;
          tx.update(jiraIssues)
            .set({
              lastSeenAt: now,
              ...(changed
                ? {
                    jiraId: src.jiraId,
                    projectKey: src.projectKey,
                    summary: src.summary,
                    statusName: src.statusName,
                    statusCategory: src.statusCategory,
                    priority: src.priority,
                    issueType: src.issueType,
                    labels: src.labels,
                    dueDate: src.dueDate,
                    jiraCreatedAt: src.createdAt,
                    jiraUpdatedAt: src.updatedAt,
                    webUrl: src.webUrl,
                    inScope,
                  }
                : {}),
              ...(attentionChanged ? { attention, attentionSince: attention ? now : null } : {}),
            })
            .where(eq(jiraIssues.key, i.key))
            .run();
          if (notable) this.publishUpdated(tx, i.key);
          if (attentionChanged && attention) this.publishAttention(tx, i.key, attention);
          if (changed) result.updated++;
          else result.unchanged++;
        }
      },
      { behavior: "immediate" },
    );
    return result;
  }

  /**
   * Spec B6, after a complete reconcile: seen keys go in scope; unseen ones go out, unless an
   * incremental sync saw them after the reconcile started (`lastSeenAt >= startedAt`).
   */
  markScope(seenKeys: readonly string[], startedAt: string, tx?: Tx): { in: number; out: number } {
    const seen = new Set(seenKeys);
    return this.inTx(tx, (t) => {
      const counts = { in: 0, out: 0 };
      for (const r of t.select().from(jiraIssues).all()) {
        const target = seen.has(r.key) ? true : r.lastSeenAt >= startedAt ? r.inScope : false;
        if (target === r.inScope) continue;
        this.setScope(t, r, target);
        if (target) counts.in++;
        else counts.out++;
      }
      return counts;
    });
  }

  /** Spec B7: stored issues of a newly excluded project leave scope at once. */
  dropExcluded(tx: Tx, excluded: readonly string[]): number {
    if (excluded.length === 0) return 0;
    const rows = tx
      .select()
      .from(jiraIssues)
      .where(and(inArray(jiraIssues.projectKey, [...excluded]), eq(jiraIssues.inScope, true)))
      .all();
    for (const r of rows) this.setScope(tx, r, false);
    return rows.length;
  }

  private setScope(tx: Tx, r: Row, inScope: boolean): void {
    const now = this.deps.clock.now();
    const attention = attentionOf({ ...rowToSource(r), inScope }, now, this.attentionSettings());
    const attentionChanged = attention !== r.attention;
    tx.update(jiraIssues)
      .set({
        inScope,
        ...(attentionChanged
          ? { attention, attentionSince: attention ? now.toISOString() : null }
          : {}),
      })
      .where(eq(jiraIssues.key, r.key))
      .run();
    this.publishUpdated(tx, r.key);
    if (attentionChanged && attention) this.publishAttention(tx, r.key, attention);
  }

  /** Re-applies the rules to every row whose attention can change with time; returns changes. */
  refreshAttention(tx?: Tx): number {
    const att = this.attentionSettings();
    return this.inTx(tx, (t) => {
      const nowDate = this.deps.clock.now();
      let changed = 0;
      const rows = t
        .select()
        .from(jiraIssues)
        .where(or(eq(jiraIssues.inScope, true), isNotNull(jiraIssues.attention)))
        .all();
      for (const r of rows) {
        const attention = attentionOf({ ...rowToSource(r), inScope: r.inScope }, nowDate, att);
        if (attention === r.attention) continue;
        t.update(jiraIssues)
          .set({ attention, attentionSince: attention ? nowDate.toISOString() : null })
          .where(eq(jiraIssues.key, r.key))
          .run();
        if (attention) this.publishAttention(t, r.key, attention);
        changed++;
      }
      return changed;
    });
  }

  /** Runs `fn` in the caller's transaction, or in a new immediate one. */
  private inTx<T>(tx: Tx | undefined, fn: (t: Tx) => T): T {
    return tx ? fn(tx) : this.deps.db.transaction(fn, { behavior: "immediate" });
  }

  /** In-scope issues only (spec B11). `done` means done and updated within the window. */
  list(view: JiraIssueViewKind): JiraIssueView[] {
    const { db, clock, settings } = this.deps;
    const inScope = eq(jiraIssues.inScope, true);
    const where =
      view === "attention"
        ? and(inScope, isNotNull(jiraIssues.attention))
        : view === "open"
          ? and(inScope, ne(jiraIssues.statusCategory, "done"))
          : view === "done"
            ? and(
                inScope,
                eq(jiraIssues.statusCategory, "done"),
                gte(
                  jiraIssues.jiraUpdatedAt,
                  new Date(
                    clock.now().getTime() - settings.get("jira.windowDays") * DAY_MS,
                  ).toISOString(),
                ),
              )
            : inScope;
    const rows = db
      .select()
      .from(jiraIssues)
      .where(where)
      .orderBy(desc(jiraIssues.jiraUpdatedAt), jiraIssues.key)
      .all();
    if (view === "attention") {
      rows.sort(
        (a, b) =>
          ATTENTION_RANK[a.attention as JiraAttention] -
            ATTENTION_RANK[b.attention as JiraAttention] ||
          (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999"),
      );
    }
    return rows.map((r) => this.view(r));
  }

  get(key: string): JiraIssueView | null {
    const r = this.deps.db.select().from(jiraIssues).where(eq(jiraIssues.key, key)).get();
    return r ? this.view(r) : null;
  }

  inScopeCount(): number {
    const r = this.deps.db
      .select({ n: sql<number>`count(*)` })
      .from(jiraIssues)
      .where(eq(jiraIssues.inScope, true))
      .get();
    return r?.n ?? 0;
  }

  /**
   * Spec B10: stored Slack messages whose text holds the key as a whole, case-sensitive token.
   * LIKE prefilters (it is case-insensitive and substring), the regex decides. Ids, labels, times
   * and safe permalinks only: never the message text.
   */
  slackMentions(key: string): JiraSlackMentions {
    const { db } = this.deps;
    const token = new RegExp(`\\b${escapeRegex(key)}\\b`);
    const rows = db
      .select({
        id: slackMessages.id,
        text: slackMessages.text,
        sentAt: slackMessages.sentAt,
        permalink: slackMessages.permalink,
        convId: slackConversations.id,
        convExternalId: slackConversations.externalId,
        convType: slackConversations.type,
        convName: slackConversations.name,
      })
      .from(slackMessages)
      .innerJoin(slackConversations, eq(slackConversations.id, slackMessages.conversationId))
      .where(sql`${slackMessages.text} LIKE ${`%${escapeLike(key)}%`} ESCAPE '\\'`)
      .orderBy(desc(slackMessages.sentAt), desc(slackMessages.id))
      .all()
      .filter((r) => r.text !== null && token.test(r.text));
    return {
      count: rows.length,
      latest: rows.slice(0, MENTIONS_SHOWN).map((r) => ({
        messageId: r.id,
        conversationLabel: this.label(db, {
          id: r.convId,
          externalId: r.convExternalId,
          type: r.convType,
          name: r.convName,
        }),
        sentAt: r.sentAt,
        permalink: safePermalink(r.permalink),
      })),
    };
  }

  private view(r: Row): JiraIssueView {
    return {
      ...rowToSource(r),
      attention: r.attention,
      inScope: r.inScope,
      slackMentions: this.slackMentions(r.key),
    };
  }
}

function rowToSource(r: Row): SourceIssue {
  return {
    key: r.key,
    jiraId: r.jiraId,
    projectKey: r.projectKey,
    summary: r.summary,
    statusName: r.statusName,
    statusCategory: r.statusCategory,
    priority: r.priority,
    issueType: r.issueType,
    labels: r.labels,
    dueDate: r.dueDate,
    createdAt: r.jiraCreatedAt,
    updatedAt: r.jiraUpdatedAt,
    webUrl: r.webUrl,
  };
}
