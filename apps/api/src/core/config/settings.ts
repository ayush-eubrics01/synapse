import { flagSeveritySchema, type NewDomainEvent, urgencyLevelSchema } from "@synapse/contracts";
import { type Db, type DbOrTx, schema } from "@synapse/database";
import { type Clock, isoNow, newId } from "@synapse/shared";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { DEFAULT_KEYWORDS } from "../../intelligence/screening/rules";
import { DEFAULT_KNOWN_SERVERS, SERVER_NAME_RE } from "../orchestrator/tool-catalog";

const keywordRuleSchema = z.object({
  id: z.string().min(1),
  pattern: z.string().min(1),
  weight: z.number(),
  level: urgencyLevelSchema,
  signal: z.boolean(),
});

const settingSchemas = {
  "slack.selfUserId": z
    .string()
    .regex(/^[UW][A-Z0-9]+$/)
    .nullable()
    .default(null),
  "urgency.rules.keywords": z
    .array(keywordRuleSchema)
    .default(() => DEFAULT_KEYWORDS.map((k) => ({ ...k }))),
  "urgency.assess.batchWindowSeconds": z.number().int().positive().default(120),
  "urgency.assess.batchMax": z.number().int().positive().max(10).default(10),
  "urgency.notify.levels": z.array(urgencyLevelSchema).default(["critical", "high"]),
  "urgency.model": z.string().min(1).default("haiku"),
  "urgency.suggest.model": z.string().min(1).default("haiku"),
  "urgency.maxAgeHours": z.number().positive().default(24),
  "urgency.candidateThreshold": z.number().default(2),
  "notifications.desktop.enabled": z.boolean().default(true),
  "notifications.desktop.minSeverity": flagSeveritySchema.default("warning"),
  "security.flags.notifyOnSeverity": flagSeveritySchema.default("high"),
  "security.flags.widgetMinSeverity": flagSeveritySchema.default("warning"),
  "security.flags.excerptMaxChars": z.number().int().positive().default(300),
  "slack.collection.intervalSeconds": z.number().int().positive().default(600),
  "slack.collection.enabled": z.boolean().default(true),
  // R61: the incremental checkpoint is stored at most now - this, so the last N seconds are re-read (index latency).
  "slack.collection.indexLagSeconds": z.number().int().nonnegative().default(300),
  "slack.backfill.minMinutesBetweenRuns": z.number().int().positive().default(3),
  "slack.backfill.maxBackoffMinutes": z.number().int().positive().default(30),
  "slack.backfill.days": z.number().int().positive().default(90),
  "slack.collector.pagesPerRun": z.number().int().positive().default(5),
  "retention.slackContentDays": z.number().int().positive().default(180),
  "jobs.maxAttempts": z.number().int().positive().default(3),
  "orchestrator.maxConcurrent": z.number().int().positive().default(2),
  "health.authExpiryWarningHours": z.number().positive().default(48),
  "autoReply.awayMode": z.boolean().default(false),
  "system.lastHeartbeatAt": z.string().nullable().default(null),
  "orchestrator.quota.fiveHour.soft": z.number().min(0).max(1).default(0.6),
  "orchestrator.quota.fiveHour.hard": z.number().min(0).max(1).default(0.85),
  "orchestrator.quota.fiveHour.stop": z.number().min(0).max(1).default(0.95),
  "orchestrator.quota.sevenDay.soft": z.number().min(0).max(1).default(0.7),
  "orchestrator.quota.sevenDay.hard": z.number().min(0).max(1).default(0.9),
  "orchestrator.timeouts.collector": z.number().int().positive().default(180),
  "orchestrator.timeouts.intelligence": z.number().int().positive().default(300),
  "orchestrator.timeouts.engineering": z.number().int().positive().default(1800),
  "orchestrator.models.collector": z.string().min(1).default("haiku"),
  "orchestrator.models.intelligence": z.string().min(1).default("haiku"),
  "orchestrator.models.engineering": z.string().min(1).default("sonnet"),
  "orchestrator.knownServers": z
    .array(z.string().regex(SERVER_NAME_RE))
    .default(() => [...DEFAULT_KNOWN_SERVERS]),
  "people.update.intervalSeconds": z.number().int().positive().default(86400),
  "people.temporaryContact.ttlDays": z.number().int().positive().default(30),
  "people.recommendation.minConfidence": z.enum(["low", "medium", "high"]).default("medium"),
  "people.models.initial": z.string().min(1).default("sonnet"),
  "people.models.update": z.string().min(1).default("haiku"),
  "people.history.days": z.number().int().positive().default(90),
  "people.history.maxMessages": z.number().int().positive().max(200).default(150),
  "people.unknown.minMessages": z.number().int().positive().default(3),
  "commitments.extract.debounceMinutes": z.number().int().positive().default(30),
  "commitments.extract.batchMax": z.number().int().positive().max(40).default(40),
  "commitments.stall.waitHours": z.number().positive().default(24),
  "commitments.reminder.dueSoonHours": z.number().positive().default(24),
  "commitments.spec.maxAgeHours": z.number().int().min(1).max(168).default(24),
  "commitments.spec.maxPerSenderPerDay": z.number().int().positive().default(5),
  "commitments.spec.maxPerDay": z.number().int().positive().default(30),
  "commitments.requireReviewForDetected": z.boolean().default(true),
  "commitments.models.extract": z.string().min(1).default("haiku"),
  "commitments.models.draft": z.string().min(1).default("haiku"),
  "outgoing.verify.delaySeconds": z.number().int().positive().default(120),
  "outgoing.verify.maxAttempts": z.number().int().positive().default(5),
  "auth.lastExpiryWarningAt": z.string().nullable().default(null),
  "auth.pausedAt": z.string().nullable().default(null),
  "auth.pausedRefreshExpiresAt": z.string().nullable().default(null),
};

export type SettingKey = keyof typeof settingSchemas;
export type SettingValue<K extends SettingKey> = z.output<(typeof settingSchemas)[K]>;

export type PublishSettingsChanged = (tx: DbOrTx, e: NewDomainEvent<"settings.changed">) => string;

export class SettingsService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly publish: PublishSettingsChanged,
  ) {}

  get<K extends SettingKey>(key: K): SettingValue<K> {
    const row = this.db
      .select()
      .from(schema.appSettings)
      .where(eq(schema.appSettings.key, key))
      .get();
    return settingSchemas[key].parse(row?.value) as SettingValue<K>;
  }

  /** Removes a stored value so the key reads as its default (a JSON null cannot be stored). */
  clear(key: SettingKey): void {
    this.db.delete(schema.appSettings).where(eq(schema.appSettings.key, key)).run();
  }

  set<K extends SettingKey>(key: K, value: SettingValue<K>, opts: { emit?: boolean } = {}): void {
    const parsed = settingSchemas[key].parse(value);
    const updatedAt = isoNow(this.clock);
    this.db.transaction(
      (tx) => {
        tx.insert(schema.appSettings)
          .values({ key, value: parsed, updatedAt })
          .onConflictDoUpdate({ target: schema.appSettings.key, set: { value: parsed, updatedAt } })
          .run();
        if (opts.emit ?? true) {
          this.publish(tx, {
            type: "settings.changed",
            aggregateType: "settings",
            aggregateId: key,
            correlationId: newId(),
            payload: { key },
          });
        }
      },
      { behavior: "immediate" },
    );
  }
}
