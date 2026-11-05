import { type FlagSeverity, flagSeveritySchema, type SuspectedInjection } from "@synapse/contracts";
import { type Db, type DbOrTx, schema } from "@synapse/database";
import { type Clock, isoNow, newId } from "@synapse/shared";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { AuditLogger } from "../../core/audit/audit";
import type { SettingsService } from "../../core/config/settings";
import type { EventPublisher } from "../../core/events/publisher";
import type { NotificationService } from "../../core/notifications/notifications";
import { safePermalink } from "../inbox/permalink";
import type { PeopleService } from "../people/service";
import { renderExcerpt, scanText } from "./detector";
import { type FlagRule, STARTER_RULES } from "./rules";

export type Flag = typeof schema.securityFlags.$inferSelect;
export type ReviewStatus = "acknowledged" | "contacted" | "dismissed";

export interface SecurityFlagsDeps {
  db: Db;
  clock: Clock;
  events: EventPublisher;
  audit: AuditLogger;
  settings: SettingsService;
  notifications: NotificationService;
  people: PeopleService;
}

export interface GroupedFlags {
  slackUserId: string;
  name: string;
  openCount: number;
  maxSeverity: FlagSeverity;
  latest: {
    id: string;
    excerpt: string;
    detector: string;
    createdAt: string;
    permalink: string | null;
  };
  /** The person's newest still-open flag: what the grouped-row review buttons act on. */
  latestOpenId: string | null;
}

export class UnknownFlagError extends Error {
  constructor() {
    super("unknown flag");
  }
}

const RANK: Record<FlagSeverity, number> = { info: 0, warning: 1, high: 2 };
const SEVERITIES = Object.keys(RANK) as FlagSeverity[];
const atLeast = (min: FlagSeverity) => SEVERITIES.filter((s) => RANK[s] >= RANK[min]);

const rulesSchema = z.array(
  z.object({
    id: z.string().min(1),
    severity: flagSeveritySchema,
    caseSensitive: z.boolean().optional(),
    patterns: z
      .array(
        z.string().refine((p) => {
          try {
            new RegExp(p, "iu");
            return true;
          } catch {
            return false;
          }
        }),
      )
      .min(1),
  }),
);

const { securityFlags, securityFlagRules, slackMessages, slackUsers, slackConversations } = schema;

/** Fallback rules in effect carry version 0: no stored version produced them. */
const STARTER_FALLBACK_VERSION = 0;

/**
 * Prompt-injection red flags (ADR-034). Flags carry the message id always, so the unique index
 * (message, detector, rule) deduplicates. Excerpts live only in `security_flags.excerpt`: events,
 * audit rows, notifications and logs never carry message text.
 */
export class SecurityFlagsService {
  constructor(private readonly deps: SecurityFlagsDeps) {}

  /** Seeds version 1 from the starter rules on an empty table. Called once at startup. */
  init(): void {
    const { db, clock } = this.deps;
    db.insert(securityFlagRules)
      .values({
        id: newId(),
        version: 1,
        rules: STARTER_RULES,
        active: true,
        createdAt: isoNow(clock),
      })
      .onConflictDoNothing({ target: securityFlagRules.version })
      .run();
  }

  /** The rules in effect. Read-only: invalid stored rules fall back, an empty table uses the starter set. */
  activeRules(tx: DbOrTx = this.deps.db): { version: number; rules: FlagRule[] } {
    return this.resolveRules(tx).rules;
  }

  /** True while stored rules are unusable and a fallback is in effect (health check). */
  rulesFallbackActive(): boolean {
    return this.resolveRules(this.deps.db).fallback;
  }

  /** Parsed rules by version, keyed on the stored text so an edited row is re-parsed. */
  private readonly parsed = new Map<number, { raw: string; rules: FlagRule[] | null }>();

  private parseRules(version: number, raw: string): FlagRule[] | null {
    const hit = this.parsed.get(version);
    if (hit && hit.raw === raw) return hit.rules;
    let rules: FlagRule[] | null = null;
    try {
      const r = rulesSchema.safeParse(JSON.parse(raw));
      rules = r.success ? r.data : null;
    } catch {
      rules = null;
    }
    this.parsed.set(version, { raw, rules });
    return rules;
  }

  private resolveRules(tx: DbOrTx): {
    rules: { version: number; rules: FlagRule[] };
    fallback: boolean;
  } {
    // Raw text on purpose: a corrupt JSON column must not throw while reading.
    const rows = tx
      .select({
        version: securityFlagRules.version,
        active: securityFlagRules.active,
        raw: sql<string>`${securityFlagRules.rules}`,
      })
      .from(securityFlagRules)
      .orderBy(desc(securityFlagRules.version))
      .all();
    // Before init() there is nothing stored: the starter set applies, not a degraded state.
    if (rows.length === 0) return { rules: { version: 1, rules: STARTER_RULES }, fallback: false };
    const active = rows.find((r) => r.active);
    if (active) {
      const rules = this.parseRules(active.version, active.raw);
      if (rules) return { rules: { version: active.version, rules }, fallback: false };
    }
    for (const r of rows) {
      if (r === active) continue;
      const rules = this.parseRules(r.version, r.raw);
      if (rules) return { rules: { version: r.version, rules }, fallback: true };
    }
    return { rules: { version: STARTER_FALLBACK_VERSION, rules: STARTER_RULES }, fallback: true };
  }

  scanMessage(
    tx: DbOrTx,
    m: {
      messageId: string;
      slackUserId: string;
      conversationId: string;
      externalRef: string;
      text: string;
    },
    /** R15: false for messages older than `urgency.maxAgeHours` (flags and events, no notification). */
    opts: { notify: boolean },
  ): { flagged: boolean; maxSeverity: FlagSeverity | null } {
    const { version, rules } = this.activeRules(tx);
    const hits = scanText(m.text, rules, {
      excerptMaxChars: this.deps.settings.get("security.flags.excerptMaxChars"),
    });
    let maxSeverity: FlagSeverity | null = null;
    for (const h of hits) {
      this.upsert(tx, {
        messageId: m.messageId,
        slackUserId: m.slackUserId,
        conversationId: m.conversationId,
        externalRef: m.externalRef,
        detector: "rules",
        ruleId: h.ruleId,
        severity: h.severity,
        excerpt: h.excerpt,
        reason: `rule ${h.ruleId}`,
        runId: null,
        rulesVersion: version,
        notify: opts.notify,
      });
      if (maxSeverity === null || RANK[h.severity] > RANK[maxSeverity]) maxSeverity = h.severity;
    }
    return { flagged: hits.length > 0, maxSeverity };
  }

  recordAiFlag(tx: DbOrTx, messageId: string, runId: string, s: SuspectedInjection): void {
    if (!s.detected) return;
    const max = this.deps.settings.get("security.flags.excerptMaxChars");
    const ctx = this.messageContext(tx, messageId);
    if (!ctx) return;
    this.upsert(tx, {
      ...ctx,
      messageId,
      detector: "ai",
      ruleId: "ai",
      severity: s.severity,
      excerpt: renderExcerpt(s.quote, max),
      reason: renderExcerpt(s.reason, max),
      runId,
      rulesVersion: null,
      notify: true,
    });
  }

  /** `reason` is system-generated and must not contain message text. */
  recordRuntimeFlag(
    tx: DbOrTx,
    messageIds: string[],
    runId: string,
    reason: string,
    severity: "warning" | "high",
  ): void {
    const max = this.deps.settings.get("security.flags.excerptMaxChars");
    const safe = renderExcerpt(reason, max);
    for (const messageId of messageIds) {
      const ctx = this.messageContext(tx, messageId);
      if (!ctx) continue;
      this.upsert(tx, {
        ...ctx,
        messageId,
        detector: "runtime",
        ruleId: "runtime",
        severity,
        excerpt: safe,
        reason: safe,
        runId,
        rulesVersion: null,
        notify: true,
      });
    }
  }

  review(flagId: string, status: ReviewStatus): void {
    const { db, clock } = this.deps;
    db.transaction(
      (tx) => {
        const now = isoNow(clock);
        const row = tx
          .update(securityFlags)
          .set({ status, reviewedAt: now, updatedAt: now })
          .where(eq(securityFlags.id, flagId))
          .returning({ id: securityFlags.id })
          .get();
        if (!row) throw new UnknownFlagError();
        this.deps.audit.record(tx, {
          actor: "user",
          module: "security-flags",
          action: "security.flag_reviewed",
          targetRef: flagId,
          result: "ok",
          details: { flagId, status },
        });
        this.deps.events.publish(tx, {
          type: "security.flag_reviewed",
          aggregateType: "security_flag",
          aggregateId: flagId,
          correlationId: newId(),
          payload: { flagId, status },
        });
      },
      { behavior: "immediate" },
    );
  }

  listGroupedByPerson(opts: {
    minSeverity: FlagSeverity;
    includeReviewed: boolean;
  }): GroupedFlags[] {
    const conds = [inArray(securityFlags.severity, atLeast(opts.minSeverity))];
    if (!opts.includeReviewed) conds.push(eq(securityFlags.status, "open"));
    const rows = this.deps.db
      .select({
        slackUserId: securityFlags.slackUserId,
        severity: securityFlags.severity,
        status: securityFlags.status,
        excerpt: securityFlags.excerpt,
        detector: securityFlags.detector,
        createdAt: securityFlags.createdAt,
        id: securityFlags.id,
        permalink: slackMessages.permalink,
        name: slackUsers.name,
      })
      .from(securityFlags)
      .leftJoin(slackMessages, eq(slackMessages.id, securityFlags.messageId))
      .leftJoin(slackUsers, eq(slackUsers.externalId, securityFlags.slackUserId))
      .where(and(...conds))
      .orderBy(desc(securityFlags.createdAt), desc(securityFlags.id))
      .all();
    const groups = new Map<string, GroupedFlags>();
    for (const r of rows) {
      let g = groups.get(r.slackUserId);
      if (!g) {
        // Rows are newest first, so the first row of a person is its latest flag.
        g = {
          slackUserId: r.slackUserId,
          name: r.name ?? r.slackUserId,
          openCount: 0,
          maxSeverity: r.severity,
          latestOpenId: null,
          latest: {
            id: r.id,
            excerpt: r.excerpt,
            detector: r.detector,
            createdAt: r.createdAt,
            permalink: safePermalink(r.permalink),
          },
        };
        groups.set(r.slackUserId, g);
      }
      if (r.status === "open") {
        g.openCount += 1;
        g.latestOpenId ??= r.id;
      }
      if (RANK[r.severity] > RANK[g.maxSeverity]) g.maxSeverity = r.severity;
    }
    return [...groups.values()].sort(
      (a, b) =>
        RANK[b.maxSeverity] - RANK[a.maxSeverity] ||
        b.latest.createdAt.localeCompare(a.latest.createdAt),
    );
  }

  /** All flags for one person, every severity and status, newest first. */
  listByPerson(slackUserId: string): Flag[] {
    return this.deps.db
      .select()
      .from(securityFlags)
      .where(eq(securityFlags.slackUserId, slackUserId))
      .orderBy(desc(securityFlags.createdAt), desc(securityFlags.id))
      .all();
  }

  hasOpenFlag(messageId: string, minSeverity: "warning"): boolean {
    const row = this.deps.db
      .select({ id: securityFlags.id })
      .from(securityFlags)
      .where(
        and(
          eq(securityFlags.messageId, messageId),
          eq(securityFlags.status, "open"),
          inArray(securityFlags.severity, atLeast(minSeverity)),
        ),
      )
      .limit(1)
      .get();
    return row !== undefined;
  }

  private messageContext(tx: DbOrTx, messageId: string) {
    const r = tx
      .select({
        slackUserId: slackUsers.externalId,
        conversationId: slackMessages.conversationId,
        conversationRef: slackConversations.externalId,
        ts: slackMessages.ts,
      })
      .from(slackMessages)
      .innerJoin(slackUsers, eq(slackUsers.id, slackMessages.senderUserId))
      .innerJoin(slackConversations, eq(slackConversations.id, slackMessages.conversationId))
      .where(eq(slackMessages.id, messageId))
      .get();
    if (!r) return null;
    return {
      slackUserId: r.slackUserId,
      conversationId: r.conversationId,
      externalRef: `${r.conversationRef}:${r.ts}`,
    };
  }

  /**
   * One row per (message, detector, rule). Re-detection keeps `status` and only raises severity.
   * Emits the event (and, from the notify level up, the notification) only when the flag is new
   * or its severity rises, so replays and retries stay silent. `notify: false` (old messages, R15)
   * keeps the row and the event but never notifies.
   */
  private upsert(
    tx: DbOrTx,
    f: {
      messageId: string;
      slackUserId: string;
      conversationId: string;
      externalRef: string;
      detector: "rules" | "ai" | "runtime";
      ruleId: string;
      severity: FlagSeverity;
      excerpt: string;
      reason: string;
      runId: string | null;
      rulesVersion: number | null;
      notify: boolean;
    },
  ): void {
    const now = isoNow(this.deps.clock);
    const existing = tx
      .select({ id: securityFlags.id, severity: securityFlags.severity })
      .from(securityFlags)
      .where(
        and(
          eq(securityFlags.messageId, f.messageId),
          eq(securityFlags.detector, f.detector),
          eq(securityFlags.ruleId, f.ruleId),
        ),
      )
      .get();
    let flagId: string;
    if (existing) {
      flagId = existing.id;
      if (RANK[f.severity] <= RANK[existing.severity]) return;
      tx.update(securityFlags)
        .set({
          severity: f.severity,
          excerpt: f.excerpt,
          reason: f.reason,
          rulesVersion: f.rulesVersion,
          updatedAt: now,
        })
        .where(eq(securityFlags.id, flagId))
        .run();
    } else {
      flagId = newId();
      const personId = this.deps.people.ensurePerson(tx, f.slackUserId);
      tx.insert(securityFlags)
        .values({
          id: flagId,
          messageId: f.messageId,
          sourceExternalRef: f.externalRef,
          slackUserId: f.slackUserId,
          personId,
          conversationId: f.conversationId,
          detector: f.detector,
          ruleId: f.ruleId,
          claudeRunId: f.runId,
          severity: f.severity,
          excerpt: f.excerpt,
          reason: f.reason,
          rulesVersion: f.rulesVersion,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }
    // Created or raised: always an event; a notification only from the configured level up.
    this.deps.events.publish(tx, {
      type: "security.injection_suspected",
      aggregateType: "security_flag",
      aggregateId: flagId,
      correlationId: newId(),
      payload: { flagId, messageId: f.messageId, severity: f.severity },
    });
    if (
      f.notify &&
      RANK[f.severity] >= RANK[this.deps.settings.get("security.flags.notifyOnSeverity")]
    ) {
      const user = tx
        .select({ name: slackUsers.name })
        .from(slackUsers)
        .where(eq(slackUsers.externalId, f.slackUserId))
        .get();
      this.deps.notifications.notify(tx, {
        kind: "security.flag",
        severity: f.severity,
        title: user?.name ?? f.slackUserId,
        ref: flagId,
      });
    }
  }
}
