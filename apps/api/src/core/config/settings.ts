import type { NewDomainEvent } from "@synapse/contracts";
import { type Db, type DbOrTx, schema } from "@synapse/database";
import { type Clock, isoNow, newId } from "@synapse/shared";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { DEFAULT_KNOWN_SERVERS, SERVER_NAME_RE } from "../orchestrator/tool-catalog";

const settingSchemas = {
  "slack.collection.intervalSeconds": z.number().int().positive().default(600),
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
