import { sql } from "drizzle-orm";
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
    decidedBy: text("decided_by", { enum: ["user", "policy"] }),
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
  fiveHourStatus: text("five_hour_status"),
  sevenDayStatus: text("seven_day_status"),
  claudeRunId: text("claude_run_id").references(() => claudeRuns.id),
});

export const authSnapshots = sqliteTable("auth_snapshots", {
  id: id(),
  observedAt: text("observed_at").notNull(),
  accessExpiresAt: text("access_expires_at"),
  refreshExpiresAt: text("refresh_expires_at"),
  claudeRunId: text("claude_run_id").references(() => claudeRuns.id),
});

export const integrations = sqliteTable(
  "integrations",
  {
    id: id(),
    kind: text("kind").notNull(),
    adapter: text("adapter").notNull(),
    config: json("config"),
    enabled: bool("enabled").notNull().default(true),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("integrations_kind_adapter_uq").on(t.kind, t.adapter)],
);

export const integrationCapabilities = sqliteTable(
  "integration_capabilities",
  {
    id: id(),
    integrationId: text("integration_id")
      .notNull()
      .references(() => integrations.id),
    name: text("name").notNull(),
    available: bool("available").notNull(),
  },
  (t) => [
    uniqueIndex("integration_capabilities_integration_id_name_uq").on(t.integrationId, t.name),
  ],
);

export const integrationSyncStates = sqliteTable(
  "integration_sync_states",
  {
    id: id(),
    integrationId: text("integration_id")
      .notNull()
      .references(() => integrations.id),
    stream: text("stream").notNull(),
    checkpoint: text("checkpoint"),
    cursor: text("cursor"),
    status: text("status", { enum: ["idle", "running", "paused", "complete", "error"] })
      .notNull()
      .default("idle"),
    lastSuccessAt: text("last_success_at"),
    lastError: json("last_error"),
    upperBound: text("upper_bound"),
    pagesDone: integer("pages_done").notNull().default(0),
    searchCountDate: text("search_count_date"),
    searchCount: integer("search_count").notNull().default(0),
    nextRunAfter: text("next_run_after"),
    backoffMinutes: integer("backoff_minutes").notNull().default(0),
    stallCount: integer("stall_count").notNull().default(0),
    generation: text("generation"),
  },
  (t) => [
    uniqueIndex("integration_sync_states_integration_id_stream_uq").on(t.integrationId, t.stream),
  ],
);

export const slackConversations = sqliteTable("slack_conversations", {
  id: id(),
  externalId: text("external_id").notNull().unique(),
  type: text("type", { enum: ["im", "mpim", "channel"] }).notNull(),
  name: text("name"),
  accessible: bool("accessible").notNull().default(true),
  lastSeenTs: text("last_seen_ts"),
});

export const slackUsers = sqliteTable("slack_users", {
  id: id(),
  externalId: text("external_id").notNull().unique(),
  name: text("name"),
  email: text("email"),
  isBot: bool("is_bot"),
});

export const slackMessages = sqliteTable(
  "slack_messages",
  {
    id: id(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => slackConversations.id),
    ts: text("ts").notNull(),
    threadTs: text("thread_ts"),
    senderUserId: text("sender_user_id")
      .notNull()
      .references(() => slackUsers.id),
    text: text("text"),
    fullNotes: text("full_notes"),
    permalink: text("permalink"),
    replyCount: integer("reply_count").notNull().default(0),
    sentAt: text("sent_at").notNull(),
    collectedAt: text("collected_at").notNull(),
    contentExpiredAt: text("content_expired_at"),
    screening: json("screening"),
    urgencyLevel: text("urgency_level"),
    urgencyReason: text("urgency_reason"),
    urgencyStatus: text("urgency_status"),
    commitmentsExtractedAt: text("commitments_extracted_at"),
  },
  (t) => [
    uniqueIndex("slack_messages_conversation_id_ts_uq").on(t.conversationId, t.ts),
    index("slack_messages_sent_at_idx").on(t.sentAt),
    index("slack_messages_conversation_id_thread_ts_idx").on(t.conversationId, t.threadTs),
    index("slack_messages_urgency_level_urgency_status_idx").on(t.urgencyLevel, t.urgencyStatus),
  ],
);

export const slackAttachments = sqliteTable("slack_attachments", {
  id: id(),
  messageId: text("message_id")
    .notNull()
    .references(() => slackMessages.id),
  externalFileId: text("external_file_id").notNull(),
  name: text("name"),
  localPath: text("local_path"),
});

export const slackMessageReferences = sqliteTable("slack_message_references", {
  id: id(),
  messageId: text("message_id")
    .notNull()
    .references(() => slackMessages.id),
  refType: text("ref_type").notNull(),
  refId: text("ref_id").notNull(),
});

export const people = sqliteTable("people", {
  id: id(),
  slackUserId: text("slack_user_id").notNull().unique(),
  name: text("name"),
  email: text("email"),
  title: text("title"),
  team: text("team"),
  createdAt: text("created_at").notNull(),
});

export const peoplePrioritySettings = sqliteTable("people_priority_settings", {
  id: id(),
  personId: text("person_id")
    .notNull()
    .unique()
    .references(() => people.id),
  priority: text("priority", { enum: ["normal", "high", "critical"] }).notNull(),
  rationale: text("rationale"),
  extraAttention: bool("extra_attention").notNull().default(false),
  updatedAt: text("updated_at").notNull(),
});

export const securityFlags = sqliteTable(
  "security_flags",
  {
    id: id(),
    messageId: text("message_id").references(() => slackMessages.id),
    sourceExternalRef: text("source_external_ref").notNull(),
    slackUserId: text("slack_user_id").notNull(),
    personId: text("person_id").references(() => people.id),
    conversationId: text("conversation_id"),
    detector: text("detector", { enum: ["rules", "ai", "runtime"] }).notNull(),
    ruleId: text("rule_id").notNull(),
    claudeRunId: text("claude_run_id").references(() => claudeRuns.id),
    severity: text("severity", { enum: ["info", "warning", "high"] }).notNull(),
    excerpt: text("excerpt").notNull(),
    reason: text("reason").notNull(),
    status: text("status", { enum: ["open", "acknowledged", "contacted", "dismissed"] })
      .notNull()
      .default("open"),
    rulesVersion: integer("rules_version"),
    createdAt: text("created_at").notNull(),
    reviewedAt: text("reviewed_at"),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("security_flags_message_id_detector_rule_id_uq").on(
      t.messageId,
      t.detector,
      t.ruleId,
    ),
    index("security_flags_status_severity_idx").on(t.status, t.severity),
    index("security_flags_slack_user_id_idx").on(t.slackUserId),
  ],
);

export const securityFlagRules = sqliteTable("security_flag_rules", {
  id: id(),
  version: integer("version").notNull().unique(),
  rules: json("rules").notNull(),
  active: bool("active").notNull(),
  createdAt: text("created_at").notNull(),
});

export const messageDrafts = sqliteTable(
  "message_drafts",
  {
    id: id(),
    messageId: text("message_id")
      .notNull()
      .references(() => slackMessages.id),
    kind: text("kind", { enum: ["suggested_response"] }).notNull(),
    text: text("text"),
    confidence: real("confidence").notNull(),
    status: text("status", { enum: ["proposed", "discarded"] }).notNull(),
    claudeRunId: text("claude_run_id").references(() => claudeRuns.id),
    createdAt: text("created_at").notNull(),
    contentExpiredAt: text("content_expired_at"),
  },
  (t) => [uniqueIndex("message_drafts_message_id_kind_uq").on(t.messageId, t.kind)],
);

export const temporaryContacts = sqliteTable("temporary_contacts", {
  id: id(),
  slackUserId: text("slack_user_id").notNull().unique(),
  firstSeenAt: text("first_seen_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
  messageCount: integer("message_count").notNull().default(0),
  expiresAt: text("expires_at").notNull(),
  profileAssessment: json("profile_assessment"),
  assessedAt: text("assessed_at"),
});

export const peopleProfiles = sqliteTable("people_profiles", {
  id: id(),
  personId: text("person_id")
    .notNull()
    .unique()
    .references(() => people.id),
  currentVersion: integer("current_version").notNull(),
  content: json("content").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const peopleProfileRecommendations = sqliteTable(
  "people_profile_recommendations",
  {
    id: id(),
    personId: text("person_id")
      .notNull()
      .references(() => people.id),
    kind: text("kind", { enum: ["initial", "update", "suggest_evaluation"] }).notNull(),
    baseVersion: integer("base_version"),
    content: json("content"),
    observationHash: text("observation_hash"),
    status: text("status", {
      enum: ["pending", "approved", "rejected", "expired", "superseded", "applied"],
    }).notNull(),
    approvalId: text("approval_id").references(() => approvals.id),
    claudeRunId: text("claude_run_id").references(() => claudeRuns.id),
    reason: text("reason"),
    createdAt: text("created_at").notNull(),
    decidedAt: text("decided_at"),
  },
  (t) => [index("people_profile_recommendations_person_id_status_idx").on(t.personId, t.status)],
);

export const peopleProfileVersions = sqliteTable(
  "people_profile_versions",
  {
    id: id(),
    profileId: text("profile_id")
      .notNull()
      .references(() => peopleProfiles.id),
    version: integer("version").notNull(),
    content: json("content").notNull(),
    recommendationId: text("recommendation_id")
      .notNull()
      .references(() => peopleProfileRecommendations.id),
    approvalId: text("approval_id").references(() => approvals.id),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("people_profile_versions_profile_id_version_uq").on(t.profileId, t.version)],
);

export const peopleProfileEvidence = sqliteTable(
  "people_profile_evidence",
  {
    id: id(),
    recommendationId: text("recommendation_id").references(() => peopleProfileRecommendations.id),
    versionId: text("version_id").references(() => peopleProfileVersions.id),
    observationKey: text("observation_key").notNull(),
    messageId: text("message_id").references(() => slackMessages.id, { onDelete: "set null" }),
    sourceExternalRef: text("source_external_ref").notNull(),
    confidence: text("confidence", { enum: ["low", "medium", "high"] }).notNull(),
    observedAt: text("observed_at").notNull(),
  },
  (t) => [
    index("people_profile_evidence_version_id_idx").on(t.versionId),
    index("people_profile_evidence_recommendation_id_idx").on(t.recommendationId),
  ],
);

export const commitments = sqliteTable(
  "commitments",
  {
    id: id(),
    description: text("description").notNull(),
    ownerSlackUserId: text("owner_slack_user_id").notNull(),
    counterpartySlackUserId: text("counterparty_slack_user_id"),
    direction: text("direction", { enum: ["mine", "theirs"] }).notNull(),
    status: text("status", {
      enum: ["open", "in_progress", "blocked", "completed", "cancelled"],
    }).notNull(),
    reviewStatus: text("review_status", {
      enum: ["pending_review", "accepted", "rejected"],
    }).notNull(),
    dueAt: text("due_at"),
    nextAction: text("next_action"),
    completionEvidence: text("completion_evidence"),
    stalledAt: text("stalled_at"),
    lastFollowupAt: text("last_followup_at"),
    closedAt: text("closed_at"),
    dedupKey: text("dedup_key").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("commitments_dedup_key_uq").on(t.dedupKey),
    index("commitments_review_status_status_idx").on(t.reviewStatus, t.status),
  ],
);

export const commitmentSources = sqliteTable(
  "commitment_sources",
  {
    id: id(),
    commitmentId: text("commitment_id")
      .notNull()
      .references(() => commitments.id),
    messageId: text("message_id").references(() => slackMessages.id, { onDelete: "set null" }),
    sourceExternalRef: text("source_external_ref").notNull(),
    conversationId: text("conversation_id").notNull(),
    claudeRunId: text("claude_run_id").references(() => claudeRuns.id),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("commitment_sources_commitment_id_source_external_ref_uq").on(
      t.commitmentId,
      t.sourceExternalRef,
    ),
  ],
);

export const commitmentUpdates = sqliteTable("commitment_updates", {
  id: id(),
  commitmentId: text("commitment_id")
    .notNull()
    .references(() => commitments.id),
  actor: text("actor", { enum: ["user", "system", "ai"] }).notNull(),
  field: text("field").notNull(),
  fromValue: text("from_value"),
  toValue: text("to_value"),
  reason: text("reason"),
  createdAt: text("created_at").notNull(),
});

export const outgoingMessages = sqliteTable(
  "outgoing_messages",
  {
    id: id(),
    approvalId: text("approval_id")
      .notNull()
      .unique()
      .references(() => approvals.id),
    followupId: text("followup_id").references(() => followups.id),
    conversationExternalId: text("conversation_external_id").notNull(),
    threadTs: text("thread_ts"),
    text: text("text").notNull(),
    status: text("status", {
      enum: ["pending", "sending", "sent_unverified", "sent", "failed", "needs_attention"],
    }).notNull(),
    claudeRunId: text("claude_run_id").references(() => claudeRuns.id),
    /** When the executor marked it `sending` (just before the send run): verify searches from here. */
    sendingAt: text("sending_at"),
    sentAt: text("sent_at"),
    verifiedAt: text("verified_at"),
    verifyAttempts: integer("verify_attempts").notNull().default(0),
    failure: text("failure"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("outgoing_messages_status_idx").on(t.status),
    // At most one live send per follow-up (backstop for SendAlreadyPending).
    uniqueIndex("outgoing_messages_followup_live_uq")
      .on(t.followupId)
      .where(sql`${t.status} in ('pending', 'sending', 'sent_unverified', 'needs_attention')`),
  ],
);

export const followups = sqliteTable(
  "followups",
  {
    id: id(),
    commitmentId: text("commitment_id").references(() => commitments.id),
    origin: text("origin", {
      enum: ["stalled", "spec_clarity", "urgent_reply", "manual"],
    }).notNull(),
    originMessageId: text("origin_message_id").references(() => slackMessages.id),
    conversationId: text("conversation_id").notNull(),
    threadTs: text("thread_ts"),
    recipientSlackUserId: text("recipient_slack_user_id"),
    draftText: text("draft_text"),
    confidence: real("confidence"),
    status: text("status", {
      enum: [
        "draft",
        "awaiting_approval",
        "sending",
        "sent",
        "needs_attention",
        "discarded",
        "failed",
      ],
    }).notNull(),
    approvalId: text("approval_id").references(() => approvals.id),
    outgoingId: text("outgoing_id"),
    claudeRunId: text("claude_run_id").references(() => claudeRuns.id),
    /** The drafting run reported `suspectedInjection.detected` (Phase 6b: holds an auto-send). */
    suspectedInjection: bool("suspected_injection").notNull().default(false),
    /** Ids of the messages fed into the drafting prompt; null on rows drafted before 0014. */
    contextMessageIds: json("context_message_ids").$type<string[]>(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("followups_status_idx").on(t.status)],
);

export const followupHistory = sqliteTable("followup_history", {
  id: id(),
  followupId: text("followup_id")
    .notNull()
    .references(() => followups.id),
  event: text("event").notNull(),
  detail: text("detail").notNull(),
  createdAt: text("created_at").notNull(),
});

export const awaySessions = sqliteTable(
  "away_sessions",
  {
    id: id(),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"),
    dismissedAt: text("dismissed_at"),
  },
  (t) => [
    // A2: only one session can be open.
    uniqueIndex("away_sessions_open_uq").on(sql`(1)`).where(sql`${t.endedAt} is null`),
  ],
);

export const autoReplies = sqliteTable(
  "auto_replies",
  {
    id: id(),
    sessionId: text("session_id")
      .notNull()
      .references(() => awaySessions.id),
    kind: text("kind", {
      enum: ["code_answer", "stalled_reminder", "followup_question", "acknowledgement"],
    }).notNull(),
    recipientSlackUserId: text("recipient_slack_user_id").notNull(),
    conversationExternalId: text("conversation_external_id").notNull(),
    threadTs: text("thread_ts"),
    sourceMessageId: text("source_message_id"),
    followupId: text("followup_id"),
    decision: text("decision", { enum: ["sent", "held"] }).notNull(),
    reason: text("reason"),
    text: text("text"),
    outgoingId: text("outgoing_id"),
    approvalId: text("approval_id"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("auto_replies_recipient_created_idx").on(t.recipientSlackUserId, t.createdAt),
    index("auto_replies_thread_created_idx").on(t.conversationExternalId, t.threadTs, t.createdAt),
    index("auto_replies_outgoing_idx").on(t.outgoingId),
  ],
);

export const jiraIssues = sqliteTable(
  "jira_issues",
  {
    key: text("key").primaryKey(),
    jiraId: text("jira_id").notNull(),
    projectKey: text("project_key").notNull(),
    summary: text("summary").notNull(),
    statusName: text("status_name").notNull(),
    statusCategory: text("status_category", { enum: ["new", "indeterminate", "done"] }).notNull(),
    priority: text("priority"),
    issueType: text("issue_type").notNull(),
    labels: json("labels").$type<string[]>().notNull(),
    dueDate: text("due_date"),
    jiraCreatedAt: text("jira_created_at").notNull(),
    jiraUpdatedAt: text("jira_updated_at").notNull(),
    webUrl: text("web_url").notNull(),
    inScope: bool("in_scope").notNull(),
    firstSeenAt: text("first_seen_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    attention: text("attention", { enum: ["overdue", "blocked", "due_soon", "stale"] }),
    attentionSince: text("attention_since"),
  },
  (t) => [
    index("jira_issues_scope_category_idx").on(t.inScope, t.statusCategory),
    index("jira_issues_updated_idx").on(t.jiraUpdatedAt),
  ],
);

export const repositories = sqliteTable("repositories", {
  id: id(),
  name: text("name").notNull().unique(),
  localPath: text("local_path").notNull().unique(),
  originUrl: text("origin_url"),
  upstreamUrl: text("upstream_url"),
  upstreamPushDisabled: bool("upstream_push_disabled").notNull(),
  trackedBranch: text("tracked_branch").notNull(),
  jiraProjectKeys: json("jira_project_keys").$type<string[]>().notNull(),
  notes: text("notes"),
  headSha: text("head_sha"),
  inspectedHeadSha: text("inspected_head_sha"),
  drift: json("drift").$type<{
    offTrackedBranch?: string;
    missingEnvironmentBranches?: string[];
    remotesChanged?: true;
    pathMissing?: true;
    detectedAt: string;
  }>(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const repositoryEnvironments = sqliteTable(
  "repository_environments",
  {
    id: id(),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    branch: text("branch").notNull(),
    protected: bool("protected").notNull(),
    autoDeploysOnMerge: bool("auto_deploys_on_merge").notNull(),
    notes: text("notes"),
  },
  (t) => [uniqueIndex("repository_environments_repo_name_uq").on(t.repositoryId, t.name)],
);

export const projects = sqliteTable("projects", {
  id: id(),
  name: text("name").notNull().unique(),
  summary: text("summary"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const projectRepositories = sqliteTable(
  "project_repositories",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
  },
  (t) => [uniqueIndex("project_repositories_pair_uq").on(t.projectId, t.repositoryId)],
);

export const projectFacts = sqliteTable(
  "project_facts",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind", {
      enum: ["purpose", "stack", "module", "entrypoint", "convention", "risk", "note"],
    }).notNull(),
    content: text("content").notNull(),
    evidence: json("evidence").$type<{ path: string; line?: number }[]>().notNull(),
    status: text("status", {
      enum: ["needs_review", "approved", "rejected", "outdated"],
    }).notNull(),
    source: text("source", { enum: ["inspection", "user"] }).notNull(),
    claudeRunId: text("claude_run_id"),
    supersedesId: text("supersedes_id"),
    headSha: text("head_sha"),
    createdAt: text("created_at").notNull(),
    decidedAt: text("decided_at"),
  },
  (t) => [index("project_facts_project_status_idx").on(t.projectId, t.status)],
);

export const projectMilestones = sqliteTable(
  "project_milestones",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    targetDate: text("target_date").notNull(),
    environmentId: text("environment_id").references(() => repositoryEnvironments.id, {
      onDelete: "set null",
    }),
    status: text("status", { enum: ["planned", "done", "slipped", "cancelled"] }).notNull(),
    notes: text("notes"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("project_milestones_project_date_idx").on(t.projectId, t.targetDate)],
);
