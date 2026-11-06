import {
  flagSeveritySchema,
  jiraScopeJqlSchema,
  type NewDomainEvent,
  retentionSummarySchema,
  urgencyLevelSchema,
} from "@synapse/contracts";
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

const jiraProjectKeySchema = z.string().regex(/^[A-Z][A-Z0-9_]+$/);

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
  "autoReply.allowedKinds": z
    .array(z.enum(["code_answer", "stalled_reminder", "followup_question", "acknowledgement"]))
    .default(["code_answer", "stalled_reminder", "followup_question", "acknowledgement"]),
  "autoReply.maxPerPersonPerDay": z.number().int().positive().default(3),
  "autoReply.minMinutesBetweenInThread": z.number().int().nonnegative().default(30),
  "autoReply.minConfidence": z.number().min(0).max(1).default(0.75),
  // M8: an auto-send not started this long after its decision is cancelled as `stale`.
  "autoReply.maxSendDelayMinutes": z.number().int().positive().default(15),
  "jira.enabled": z.boolean().default(false),
  "jira.cloudId": z
    .string()
    .regex(/^[0-9a-fA-F-]{8,64}$/)
    .nullable()
    .default(null),
  // No newline, no ORDER BY, balanced parentheses and quotes (the code wraps it as `(<scope>)`).
  "jira.scope.jql": jiraScopeJqlSchema.default("assignee = currentUser() AND updated >= -60d"),
  "jira.excludedProjects": z.array(jiraProjectKeySchema).default([]),
  "jira.sync.intervalMinutes": z.number().int().positive().default(30),
  "jira.reconcile.hours": z.number().int().positive().default(24),
  "jira.windowDays": z.number().int().positive().default(60),
  "jira.stale.days": z.number().int().positive().default(5),
  "jira.dueSoon.days": z.number().int().nonnegative().default(2),
  "jira.blockedStatuses": z.array(z.string().min(1)).default([]),
  // Claude Code replaces an MCP result over ~25k tokens / ~100 KB with a "saved to file" notice, so
  // a page must stay small: 20 issues with the fixed field list is ~49 KB (measured 2026-11-06).
  "jira.pageSize": z.number().int().min(1).max(30).default(20),
  "jira.maxPagesPerRun": z.number().int().positive().default(6),
  // A page chain (one sync or reconcile across continuations) longer than this fails as
  // parse_failed: a connector that never ends its pages must not run Claude without bound.
  "jira.maxPagesPerChain": z.number().int().min(1).max(500).default(50),
  "brain.inspect.model": z.enum(["haiku", "sonnet", "opus"]).default("sonnet"),
  "brain.inspect.maxTurns": z.number().int().min(1).max(100).default(30),
  "brain.inspect.timeoutMinutes": z.number().int().min(1).max(60).default(10),
  "engineering.model": z.enum(["haiku", "sonnet", "opus"]).default("sonnet"),
  "engineering.investigate.maxTurns": z.number().int().min(1).max(100).default(30),
  "engineering.develop.maxTurns": z.number().int().min(1).max(50).default(50),
  "engineering.develop.timeoutMinutes": z.number().int().min(1).max(120).default(30),
  "engineering.lock.ttlMinutes": z.number().int().min(1).max(120).default(10),
  // ADR-040: develop runs execute the test command in the Claude Code sandbox. Off means no
  // develop runs at all (validator rule M refuses them), never an unsandboxed one.
  "engineering.sandbox.enabled": z.boolean().default(true),
  "claudeActivity.enabled": z.boolean().default(true),
  // null: resolved at startup (~/.claude/projects). Tests point it at a temp dir.
  "claudeActivity.projectsDir": z.string().startsWith("/").nullable().default(null),
  "claudeActivity.scanIntervalSeconds": z.number().int().min(30).max(3600).default(120),
  "claudeActivity.activeWindowMinutes": z.number().int().min(1).max(120).default(10),
  "claudeActivity.yieldWhenActive": z.boolean().default(true),
  "claudeActivity.yieldEngineering": z.boolean().default(false),
  "claudeActivity.staleBranchDays": z.number().int().min(1).max(60).default(3),
  "claudeActivity.openPrReminderDays": z.number().int().min(1).max(60).default(3),
  // Internal state, not user-editable.
  "claudeActivity.lastActiveState": z.boolean().default(false),
  "claudeActivity.reminders.lastRunDate": z.string().nullable().default(null),
  "codeAnswer.model": z.enum(["haiku", "sonnet", "opus"]).default("sonnet"),
  "codeAnswer.maxTurns": z.number().int().min(1).max(30).default(16),
  "codeAnswer.timeoutMinutes": z.number().int().min(1).max(30).default(5),
  "codeAnswer.away.enabled": z.boolean().default(true),
  "codeAnswer.away.autoSend": z.boolean().default(false),
  "codeAnswer.away.maxRunsPerDay": z.number().int().min(0).max(100).default(10),
  "brain.upcoming.days": z.number().int().positive().default(30),
  "system.lastHeartbeatAt": z.string().nullable().default(null),
  "orchestrator.quota.fiveHour.soft": z.number().min(0).max(1).default(0.6),
  "orchestrator.quota.fiveHour.hard": z.number().min(0).max(1).default(0.85),
  "orchestrator.quota.fiveHour.stop": z.number().min(0).max(1).default(0.95),
  "orchestrator.quota.sevenDay.soft": z.number().min(0).max(1).default(0.7),
  "orchestrator.quota.sevenDay.hard": z.number().min(0).max(1).default(0.9),
  "orchestrator.timeouts.collector": z.number().int().positive().default(180),
  "orchestrator.timeouts.intelligence": z.number().int().positive().default(300),
  "orchestrator.timeouts.engineering": z.number().int().positive().default(1800),
  "orchestrator.timeouts.reader": z.number().int().positive().default(300),
  "orchestrator.models.collector": z.string().min(1).default("haiku"),
  "orchestrator.models.intelligence": z.string().min(1).default("haiku"),
  "orchestrator.models.engineering": z.string().min(1).default("sonnet"),
  "orchestrator.models.reader": z.string().min(1).default("sonnet"),
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
  // Phase 11 operations (R7).
  "ops.backup.enabled": z.boolean().default(true),
  "ops.backup.hour": z.number().int().min(0).max(23).default(3),
  "ops.backup.keep": z.number().int().min(1).max(60).default(7),
  "ops.disk.warnFreeGiB": z.number().int().min(1).max(100).default(5),
  "retention.jobsDays": z.number().int().min(7).max(365).default(30),
  "retention.notificationsDays": z.number().int().min(7).max(365).default(30),
  "retention.claudeRunsDays": z.number().int().min(14).max(730).default(90),
  "retention.auditDays": z.number().int().min(90).max(3650).default(365),
  // Internal state, not user-editable. null: resolved at startup (<data dir>/backups).
  "ops.backup.dir": z.string().startsWith("/").nullable().default(null),
  "ops.backup.lastRunDate": z.string().nullable().default(null),
  "ops.retention.lastRun": retentionSummarySchema.nullable().default(null),
  "auth.lastExpiryWarningAt": z.string().nullable().default(null),
  "auth.pausedAt": z.string().nullable().default(null),
  "auth.pausedRefreshExpiresAt": z.string().nullable().default(null),
};

export type SettingKey = keyof typeof settingSchemas;
/**
 * Keys the settings API may change: the Phase 10b and Phase 11 keys except the test-only and
 * internal ones, and the ADR-040 sandbox switch.
 */
export const USER_EDITABLE_SETTINGS = [
  "claudeActivity.enabled",
  "claudeActivity.activeWindowMinutes",
  "claudeActivity.yieldWhenActive",
  "claudeActivity.yieldEngineering",
  "claudeActivity.staleBranchDays",
  "claudeActivity.openPrReminderDays",
  "codeAnswer.model",
  "codeAnswer.maxTurns",
  "codeAnswer.timeoutMinutes",
  "codeAnswer.away.enabled",
  "codeAnswer.away.autoSend",
  "codeAnswer.away.maxRunsPerDay",
  "ops.backup.enabled",
  "ops.backup.hour",
  "ops.backup.keep",
  "ops.disk.warnFreeGiB",
  "retention.jobsDays",
  "retention.notificationsDays",
  "retention.claudeRunsDays",
  "retention.auditDays",
  "engineering.sandbox.enabled",
] as const satisfies readonly SettingKey[];
export type UserEditableKey = (typeof USER_EDITABLE_SETTINGS)[number];

/** Validates `value` against the setting's schema; `ok: false` on a bad value (never throws). */
export function checkSettingValue(
  key: SettingKey,
  value: unknown,
): { ok: true; value: unknown } | { ok: false } {
  const r = settingSchemas[key].safeParse(value);
  return r.success ? { ok: true, value: r.data } : { ok: false };
}

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
    this.db.transaction((tx) => this.setIn(tx, key, value, opts), { behavior: "immediate" });
  }

  /** `set` inside the caller's transaction, so the value commits (or rolls back) with it. */
  setIn<K extends SettingKey>(
    tx: DbOrTx,
    key: K,
    value: SettingValue<K>,
    opts: { emit?: boolean } = {},
  ): void {
    const parsed = settingSchemas[key].parse(value);
    const updatedAt = isoNow(this.clock);
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
  }
}
