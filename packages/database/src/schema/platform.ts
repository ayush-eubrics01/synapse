import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const id = () => text("id").primaryKey();
const json = (name: string) => text(name, { mode: "json" });
const bool = (name: string) => integer(name, { mode: "boolean" });

export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: json("value").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const modules = sqliteTable("modules", {
  name: text("name").primaryKey(),
  version: text("version").notNull(),
  enabled: bool("enabled").notNull().default(true),
});

export const moduleDependencies = sqliteTable(
  "module_dependencies",
  {
    id: id(),
    module: text("module")
      .notNull()
      .references(() => modules.name),
    dependsOn: text("depends_on")
      .notNull()
      .references(() => modules.name),
  },
  (t) => [uniqueIndex("module_dependencies_module_depends_on_uq").on(t.module, t.dependsOn)],
);

export const scheduledTasks = sqliteTable("scheduled_tasks", {
  id: id(),
  name: text("name").notNull().unique(),
  jobType: text("job_type").notNull(),
  intervalSeconds: integer("interval_seconds"),
  cron: text("cron"),
  input: json("input"),
  priority: integer("priority").notNull().default(100),
  enabled: bool("enabled").notNull().default(true),
  nextRunAt: text("next_run_at"),
  lastRunAt: text("last_run_at"),
});

export const jobs = sqliteTable(
  "jobs",
  {
    id: id(),
    type: text("type").notNull(),
    priority: integer("priority").notNull().default(100),
    status: text("status", {
      enum: ["PENDING", "RUNNING", "RETRY", "COMPLETED", "FAILED", "NEEDS_ATTENTION", "CANCELLED"],
    })
      .notNull()
      .default("PENDING"),
    input: json("input"),
    output: json("output"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    idempotencyKey: text("idempotency_key").notNull(),
    concurrencyGroup: text("concurrency_group"),
    externalWrite: bool("external_write").notNull().default(false),
    runAfter: text("run_after").notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: text("lease_expires_at"),
    lastError: json("last_error"),
    createdAt: text("created_at").notNull(),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
  },
  (t) => [
    index("jobs_status_priority_run_after_idx").on(t.status, t.priority, t.runAfter),
    uniqueIndex("jobs_idempotency_key_uq").on(t.idempotencyKey),
  ],
);

export const claudeRuns = sqliteTable("claude_runs", {
  id: id(),
  jobId: text("job_id").references(() => jobs.id),
  workerProfile: text("worker_profile").notNull(),
  model: text("model"),
  status: text("status").notNull(),
  numTurns: integer("num_turns"),
  durationMs: integer("duration_ms"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  cacheReadTokens: integer("cache_read_tokens"),
  cacheCreationTokens: integer("cache_creation_tokens"),
  costUsdEquivalent: real("cost_usd_equivalent"),
  permissionDenials: json("permission_denials"),
  error: json("error"),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
});

export const jobAttempts = sqliteTable("job_attempts", {
  id: id(),
  jobId: text("job_id")
    .notNull()
    .references(() => jobs.id),
  attempt: integer("attempt").notNull(),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  status: text("status").notNull(),
  error: json("error"),
  claudeRunId: text("claude_run_id").references(() => claudeRuns.id),
});

export const jobCheckpoints = sqliteTable("job_checkpoints", {
  id: id(),
  jobId: text("job_id")
    .notNull()
    .references(() => jobs.id),
  checkpoint: json("checkpoint").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const leases = sqliteTable("leases", {
  name: text("name").primaryKey(),
  holder: text("holder").notNull(),
  acquiredAt: text("acquired_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  heartbeatAt: text("heartbeat_at").notNull(),
});

export const domainEvents = sqliteTable(
  "domain_events",
  {
    id: id(),
    type: text("type").notNull(),
    version: integer("version").notNull().default(1),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    correlationId: text("correlation_id"),
    causationId: text("causation_id"),
    payload: json("payload").notNull(),
    occurredAt: text("occurred_at").notNull(),
    dispatchedAt: text("dispatched_at"),
    ephemeral: bool("ephemeral").notNull().default(false),
  },
  (t) => [index("domain_events_dispatched_at_occurred_at_idx").on(t.dispatchedAt, t.occurredAt)],
);

export const eventConsumptions = sqliteTable(
  "event_consumptions",
  {
    id: id(),
    consumer: text("consumer").notNull(),
    eventId: text("event_id")
      .notNull()
      .references(() => domainEvents.id),
    status: text("status").notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastError: json("last_error"),
    nextAttemptAt: text("next_attempt_at"),
  },
  (t) => [uniqueIndex("event_consumptions_consumer_event_id_uq").on(t.consumer, t.eventId)],
);

export const approvals = sqliteTable(
  "approvals",
  {
    id: id(),
    action: text("action").notNull(),
    targetIntegration: text("target_integration"),
    targetRef: text("target_ref"),
    payload: json("payload").notNull(),
    riskLevel: text("risk_level").notNull(),
    status: text("status", {
      enum: ["pending", "approved", "rejected", "expired", "executed", "failed", "revoked"],
    })
      .notNull()
      .default("pending"),
    expiresAt: text("expires_at"),
    decidedAt: text("decided_at"),
    executionResult: json("execution_result"),
    executionStartedAt: text("execution_started_at"),
    requestedByModule: text("requested_by_module"),
    requestedByWorker: text("requested_by_worker"),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("approvals_idempotency_key_uq").on(t.idempotencyKey)],
);

export const auditEvents = sqliteTable("audit_events", {
  id: id(),
  actor: text("actor").notNull(),
  module: text("module"),
  workerProfile: text("worker_profile"),
  action: text("action").notNull(),
  targetIntegration: text("target_integration"),
  targetRef: text("target_ref"),
  approvalId: text("approval_id").references(() => approvals.id),
  result: text("result").notNull(),
  details: json("details"),
  occurredAt: text("occurred_at").notNull(),
});

export const notifications = sqliteTable("notifications", {
  id: id(),
  kind: text("kind").notNull(),
  severity: text("severity").notNull(),
  title: text("title").notNull(),
  body: text("body"),
  ref: text("ref"),
  createdAt: text("created_at").notNull(),
  readAt: text("read_at"),
});

export const permissions = sqliteTable("permissions", {
  id: id(),
  operation: text("operation").notNull(),
  policy: text("policy").notNull(),
  scope: json("scope"),
});

export const quotaSnapshots = sqliteTable("quota_snapshots", {
  id: id(),
  observedAt: text("observed_at").notNull(),
  fiveHourUtilization: real("five_hour_utilization"),
  fiveHourResetsAt: text("five_hour_resets_at"),
  sevenDayUtilization: real("seven_day_utilization"),
  sevenDayResetsAt: text("seven_day_resets_at"),
  status: text("status").notNull(),
  claudeRunId: text("claude_run_id").references(() => claudeRuns.id),
});

export const authSnapshots = sqliteTable("auth_snapshots", {
  id: id(),
  observedAt: text("observed_at").notNull(),
  accessExpiresAt: text("access_expires_at"),
  refreshExpiresAt: text("refresh_expires_at"),
  claudeRunId: text("claude_run_id").references(() => claudeRuns.id),
});
