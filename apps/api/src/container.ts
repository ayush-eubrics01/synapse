import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  AIProvider,
  DesktopNotifier,
  MessageSink,
  PullRequestProvider,
} from "@synapse/contracts";
import { type Db, openDatabase, runMigrations } from "@synapse/database";
import { type Clock, newId, systemClock } from "@synapse/shared";
import { ApprovalEngine } from "./core/approvals/approvals";
import { registerApprovalExecution } from "./core/approvals/execution";
import { AuditLogger } from "./core/audit/audit";
import { type AppConfig, resolveHome } from "./core/config/config";
import { SettingsService } from "./core/config/settings";
import { OutboxDispatcher } from "./core/events/dispatcher";
import { LiveBus } from "./core/events/live-bus";
import { EventPublisher } from "./core/events/publisher";
import {
  authCheck,
  bunVersionCheck,
  claudeActivityCheck,
  claudeCheck,
  databaseCheck,
  desktopNotifierCheck,
  eventsCheck,
  heartbeatCheck,
  jobsCheck,
  lingerCheck,
  screeningRulesCheck,
  securityRulesCheck,
} from "./core/health/checks";
import { HealthService } from "./core/health/health";
import { JobQueue } from "./core/jobs/queue";
import { type HandlerRegistration, JobWorker } from "./core/jobs/worker";
import { LeaseService } from "./core/leases/leases";
import { ModuleRegistry } from "./core/module-registry/registry";
import { NotificationService } from "./core/notifications/notifications";
import { AuthMonitor } from "./core/orchestrator/auth";
import { ClaudeOrchestrator } from "./core/orchestrator/orchestrator";
import { PermissionManager } from "./core/permissions/permissions";
import type { RecoverySweep } from "./core/recovery/recovery";
import { SchedulerService } from "./core/scheduler/scheduler";
import { HEARTBEAT_SCHEDULE, heartbeatHandler } from "./core/system/heartbeat";
import { NoopDesktopNotifier, type NotifierHealth } from "./infrastructure/notifier";
import { ClaudeCliProvider } from "./integrations/claude-code/cli-provider";
import { loadUserSettings } from "./integrations/claude-code/settings-override";
import { GitHubCliProvider } from "./integrations/github/gh-cli";
import { JiraConnectorSource } from "./integrations/jira/connector-source";
import { LocalGitWorkflow } from "./integrations/repository/git-workflow";
import { LocalGitProvider } from "./integrations/repository/local-git";
import { SlackConnectorSource } from "./integrations/slack/connector-source";
import { normaliseSentText, SlackSender } from "./integrations/slack/sender";
import { AutoReplyService } from "./modules/auto-reply/service";
import { WipReminders } from "./modules/claude-activity/reminders";
import { ClaudeActivityService } from "./modules/claude-activity/service";
import { CodeAnswerService } from "./modules/code-answers/service";
import { ExtractionQueue } from "./modules/commitments/extraction-queue";
import { FollowupService } from "./modules/commitments/followups";
import { CommitmentLifecycle } from "./modules/commitments/lifecycle";
import { StallService } from "./modules/commitments/stall";
import { CommitmentStore } from "./modules/commitments/store";
import { DashboardService } from "./modules/dashboard/service";
import type { InspectionService } from "./modules/engineering-brain/inspection";
import { RepositoryRegistry } from "./modules/engineering-brain/registry";
import { BrainService } from "./modules/engineering-brain/service";
import { EngineeringLock } from "./modules/engineering-tasks/lock";
import { EngineeringTaskService } from "./modules/engineering-tasks/service";
import { EngineeringStepService } from "./modules/engineering-tasks/steps";
import { InboxConversations } from "./modules/inbox/conversations";
import { ScreeningService } from "./modules/inbox/screening-service";
import { InboxStore } from "./modules/inbox/store";
import { SyncStateService } from "./modules/inbox/sync-state";
import { UrgentInbox } from "./modules/inbox/urgent";
import { JiraService } from "./modules/jira-tracking/service";
import { JiraStore } from "./modules/jira-tracking/store";
import { participantLabel } from "./modules/outgoing/preview";
import { OutgoingService } from "./modules/outgoing/service";
import { replyStates, UrgentReplies } from "./modules/outgoing/urgent-reply";
import { ContactDiscovery } from "./modules/people/discovery";
import { PostSendSuggestions } from "./modules/people/post-send";
import { ProfileService } from "./modules/people/profiles";
import { ProfileRecommendations } from "./modules/people/recommendations";
import { PeopleService } from "./modules/people/service";
import { TemporaryContacts } from "./modules/people/temporary";
import { PeopleViews } from "./modules/people/views";
import { SecurityFlagsService } from "./modules/security-flags/service";
import { registerAutoReplyJobs } from "./workers/auto-reply/evaluate";
import { registerDriftCheck } from "./workers/brain/drift";
import { registerInspectionJobs } from "./workers/brain/inspect";
import { registerClaudeActivityJobs } from "./workers/claude-activity";
import { registerCodeAnswerJob } from "./workers/code-answer/generate";
import { registerCommitmentJobs } from "./workers/commitments";
import { registerInvestigateJob } from "./workers/engineering/investigate";
import { registerPickupJobs } from "./workers/engineering/pickup";
import { registerStepJob } from "./workers/engineering/steps";
import { createRunHelpers } from "./workers/intelligence-shared";
import { registerJiraJobs } from "./workers/jira";
import { registerOutgoingJobs } from "./workers/outgoing";
import { registerPeopleJobs } from "./workers/people";
import { registerSlackJobs } from "./workers/slack";
import { registerUrgencyJobs, responseGuidelinesLookup } from "./workers/urgency";

export interface Container {
  config: AppConfig;
  clock: Clock;
  db: Db;
  sqlite: Database;
  audit: AuditLogger;
  events: EventPublisher;
  dispatcher: OutboxDispatcher;
  live: LiveBus;
  queue: JobQueue;
  worker: JobWorker;
  leases: LeaseService;
  scheduler: SchedulerService;
  settings: SettingsService;
  permissions: PermissionManager;
  approvals: ApprovalEngine;
  notifications: NotificationService;
  registry: ModuleRegistry;
  provider: AIProvider;
  auth: AuthMonitor;
  orchestrator: ClaudeOrchestrator;
  health: HealthService;
  /** Claude Code session observation (Phase 10b, ADR-036). */
  claudeActivity: ClaudeActivityService;
  inbox: InboxStore;
  conversations: InboxConversations;
  urgent: UrgentInbox;
  sync: SyncStateService;
  people: PeopleService;
  /** Ranked contact candidates. */
  discovery: ContactDiscovery;
  profiles: ProfileRecommendations;
  profileStore: ProfileService;
  peopleViews: PeopleViews;
  /** Code answers (Phase 10b, C2-C4). */
  codeAnswers: CodeAnswerService;
  securityFlags: SecurityFlagsService;
  /** Approved Slack sends: requests, the `slack.send` executor, verification and resolution. */
  outgoing: OutgoingService;
  /** Commitments and their sources and status proposals (read and review APIs build on it). */
  commitments: CommitmentStore;
  commitmentLifecycle: CommitmentLifecycle;
  followups: FollowupService;
  /** Urgent-reply drafts sent through approval. */
  urgentReplies: UrgentReplies;
  /** Away mode (ADR-033): sessions, triggers, policy-gated auto-replies and the return digest. */
  autoReply: AutoReplyService;
  /** Run by startup recovery and the reaper (main.ts), so core never imports workers. */
  recoverySweeps: RecoverySweep[];
  /** Job handler registry; the urgency smoke script runs one handler directly. */
  handlers: ReadonlyMap<string, HandlerRegistration>;
  dashboard: DashboardService;
  /** Read-only Jira tracking (Phase 8): status, issue views, manual sync and scope settings. */
  jira: JiraService;
  /** Repository registry (Phase 9, ADR-035): propose, register, edit and unregister. */
  repositories: RepositoryRegistry;
  /** Repository inspection (Phase 9, C6): `requestInspection` backs "Inspect now". */
  inspections: InspectionService;
  /** Projects, fact review, milestones and the Jira association (Phase 9, C9 to C12). */
  brain: BrainService;
  /** Engineering tasks (Phase 10, E1–E7): creation, investigation, plan approval, pickup. */
  engineering: EngineeringTaskService;
  /** The global engineering lock (E6, ADR-030); main.ts runs `recover()` once at boot. */
  engineeringLock: EngineeringLock;
  /** The step runner and the four engineering approval executors (E8–E18). */
  engineeringSteps: EngineeringStepService;
  slack: Pick<ReturnType<typeof registerSlackJobs>, "startBackfill" | "backfillResumable">;
}

export interface ContainerDeps {
  clock?: Clock;
  /** Replaces the real ClaudeCliProvider (tests inject a fake). */
  provider?: AIProvider;
  run?: (cmd: string[]) => Promise<string>;
  /** Registers the `test.noop` job handler (set from SYNAPSE_TEST_HANDLERS by main.ts). */
  testHandlers?: boolean;
  /** Replaces the real SlackSender behind `outgoing` (tests and smoke scripts inject a fake). */
  sink?: MessageSink;
  /** Replaces the real GitHubCliProvider (tests inject a fake; nothing may reach real gh). */
  prs?: PullRequestProvider;
  /** Desktop notification adapter. Defaults to a no-op; main.ts injects the real one. */
  notifier?: DesktopNotifier & NotifierHealth;
  /** Replaces the Claude Code projects dir that the activity scanner reads (tests inject a temp dir). */
  claudeProjectsDir?: string;
}

const CORE_MODULES = [
  "config",
  "audit",
  "events",
  "jobs",
  "leases",
  "scheduler",
  "permissions",
  "approvals",
  "notifications",
  "health",
  "system",
];

async function runCommand(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

export function createContainer(config: AppConfig, deps: ContainerDeps = {}): Container {
  const clock = deps.clock ?? systemClock;
  const run = deps.run ?? runCommand;
  const { sqlite, db } = openDatabase(config.dbPath);
  runMigrations(db);

  const audit = new AuditLogger(clock);
  const events = new EventPublisher(clock);
  const live = new LiveBus();
  const dispatcher = new OutboxDispatcher(db, clock, live);
  const queue = new JobQueue(db, clock);
  const leases = new LeaseService(db, clock);
  const scheduler = new SchedulerService(db, clock, queue);
  const settings = new SettingsService(db, clock, events.publish.bind(events));
  const permissions = new PermissionManager(db, audit);
  const approvals = new ApprovalEngine(db, clock, events, audit, permissions);
  const notifier = deps.notifier ?? new NoopDesktopNotifier();
  const notifications = new NotificationService(db, clock, live, { notifier, settings });
  const registry = new ModuleRegistry(db);

  for (const name of CORE_MODULES) registry.register({ name, version: "1.0.0", dependsOn: [] });
  registry.validate();

  const handlers = new Map<string, HandlerRegistration>();
  handlers.set(HEARTBEAT_SCHEDULE.jobType, heartbeatHandler(settings, clock));
  if (deps.testHandlers) {
    handlers.set("test.noop", { handler: async () => null, timeoutMs: 5_000 });
  }
  scheduler.upsert(HEARTBEAT_SCHEDULE);

  const worker = new JobWorker(queue, handlers, {
    workerId: `${hostname()}-${process.pid}-${newId()}`,
    concurrency: config.workerConcurrency,
    onSettled: (job) => live.publish({ type: "job.updated", data: job }),
  });

  const home = resolveHome(process.env);
  // Plugin names and the user-permission widening flag, read once at startup (R34, Phase 9).
  const userSettings = loadUserSettings(home);
  const provider =
    deps.provider ??
    new ClaudeCliProvider({
      binary: config.claudeBinary,
      env: { PATH: `${home}/.bun/bin:${home}/.local/bin:/usr/bin:/bin`, HOME: home },
      clock,
      settingsOverride: userSettings.override,
      userPermissionsWidenScope: userSettings.userPermissionsWidenScope,
      userAllowedConnectorServers: userSettings.userAllowedConnectorServers,
    });
  const auth = new AuthMonitor(db, clock, settings, events, config.credentialsPath);
  const scratchDir =
    config.dbPath === ":memory:"
      ? mkdtempSync(join(tmpdir(), "synapse-scratch-"))
      : join(dirname(config.dbPath), "scratch");
  mkdirSync(scratchDir, { recursive: true });
  const claudeActivity = new ClaudeActivityService({
    db,
    clock,
    settings,
    events,
    audit,
    projectsDir:
      deps.claudeProjectsDir ??
      settings.get("claudeActivity.projectsDir") ??
      (config.dbPath === ":memory:"
        ? join(scratchDir, "no-claude-projects")
        : join(home, ".claude", "projects")),
  });
  const prs: PullRequestProvider = deps.prs ?? new GitHubCliProvider();
  registerClaudeActivityJobs({
    handlers,
    scheduler,
    settings,
    service: claudeActivity,
    reminders: new WipReminders({ db, clock, settings, notifications, prs }),
  });
  const orchestrator = new ClaudeOrchestrator({
    db,
    clock,
    provider,
    settings,
    events,
    audit,
    auth,
    notifications,
    scratchDir,
    userActivity: claudeActivity,
  });

  const sync = new SyncStateService(db, clock);
  const inbox = new InboxStore({ db, clock, events, queue, sync });
  const urgent = new UrgentInbox({
    db,
    clock,
    events,
    audit,
    replyStates: (ids) => replyStates(db, ids),
  });
  const conversations = new InboxConversations({
    db,
    settings,
    urgent,
    normalise: normaliseSentText,
  });
  const people = new PeopleService({ db, clock, events, audit, settings });
  const securityFlags = new SecurityFlagsService({
    db,
    clock,
    events,
    audit,
    settings,
    notifications,
    people,
  });
  securityFlags.init();
  const screening = new ScreeningService({
    db,
    clock,
    events,
    queue,
    settings,
    people,
    securityFlags,
  });
  // Replies already arrive as message.received; message.thread_updated would screen them twice.
  dispatcher.subscribe("message.received", "inbox.screening", (event, tx) =>
    screening.handle(event, tx),
  );
  const discovery = new ContactDiscovery({ db, clock, settings });
  const temporary = new TemporaryContacts({ db, clock, settings, events, queue });
  dispatcher.subscribe("message.received", "people.temporary", (event, tx) =>
    temporary.handle(event, tx),
  );
  const slackSource = new SlackConnectorSource({ orchestrator, clock });
  const messageSink =
    deps.sink ??
    new SlackSender({
      orchestrator,
      searchSource: slackSource,
      selfUserId: () => settings.get("slack.selfUserId"),
      runIdForJob: createRunHelpers(db, securityFlags).runIdBefore,
    });
  registerApprovalExecution({ dispatcher, queue, engine: approvals, handlers, settings });
  const outgoing = new OutgoingService({
    db,
    clock,
    events,
    audit,
    queue,
    settings,
    notifications,
    approvals,
    securityFlags,
    sink: messageSink,
  });
  outgoing.register(approvals, dispatcher);
  const urgentReplies = new UrgentReplies({ db, clock, audit, outgoing });
  registerOutgoingJobs({ handlers, outgoing });
  const autoReply = new AutoReplyService({
    db,
    clock,
    events,
    audit,
    queue,
    settings,
    people,
    securityFlags,
    outgoing,
  });
  registerAutoReplyJobs({ handlers, autoReply });
  dispatcher.subscribe("message.urgent_detected", "autoreply.acknowledgement", (event, tx) =>
    autoReply.onUrgentDetected(event, tx),
  );
  dispatcher.subscribe("followup.draft_created", "autoreply.followup", (event, tx) =>
    autoReply.onFollowupDraftCreated(event, tx),
  );
  const profiles = new ProfileRecommendations({
    db,
    clock,
    settings,
    events,
    queue,
    approvals,
    people,
  });
  const profileStore = new ProfileService({ db, clock, events, audit });
  profileStore.register(approvals, dispatcher);
  const peopleViews = new PeopleViews({ db, clock, settings, people, discovery, profileStore });
  registerPeopleJobs({
    db,
    clock,
    settings,
    scheduler,
    queue,
    temporary,
    recommendations: profiles,
    orchestrator,
    securityFlags,
    handlers,
  });
  const commitments = new CommitmentStore({ db, clock, settings, events });
  const commitmentLifecycle = new CommitmentLifecycle({ db, clock, settings, events });
  const followupService = new FollowupService({
    db,
    clock,
    audit,
    events,
    queue,
    outgoing,
    selfUserId: () => settings.get("slack.selfUserId"),
  });
  dispatcher.subscribe("followup.sent", "commitments.followup_sent", (event, tx) =>
    followupService.onFollowupSent(event, tx),
  );
  const codeAnswers = new CodeAnswerService({
    db,
    clock,
    events,
    audit,
    queue,
    settings,
    securityFlags,
    outgoing,
  });
  const slack = registerSlackJobs({
    db,
    clock,
    source: slackSource,
    store: inbox,
    sync,
    queue,
    settings,
    events,
    audit,
    scheduler,
    handlers,
    textRetention: {
      autoReplyText: (days) => autoReply.expireText(days),
      outgoingText: (days) => outgoing.expireText(days),
      followupDrafts: (days) => followupService.expireDrafts(days),
      codeAnswerText: (days) => codeAnswers.expireAnswers(days),
    },
  });
  const postSend = new PostSendSuggestions({
    settings,
    people,
    recommendations: profiles,
    recipientOf: (tx, followupId) => followupService.recipientOf(tx, followupId),
  });
  dispatcher.subscribe("followup.sent", "people.post_send", (event, tx) =>
    postSend.onFollowupSent(event, tx),
  );
  const extractionQueue = new ExtractionQueue({ db, clock, settings, queue });
  dispatcher.subscribe("message.received", "commitments.queue", (event, tx) =>
    extractionQueue.handle(event, tx),
  );
  registerCommitmentJobs({
    db,
    clock,
    settings,
    scheduler,
    audit,
    queue,
    orchestrator,
    securityFlags,
    store: commitments,
    events,
    stall: new StallService({ db, clock, settings, events, queue, notifications }),
    guidelinesFor: responseGuidelinesLookup(db, (id) => profileStore.getResponseGuidelines(id)),
    handlers,
  });
  const urgency = registerUrgencyJobs({
    db,
    clock,
    settings,
    events,
    queue,
    notifications,
    orchestrator,
    securityFlags,
    handlers,
    guidelinesFor: responseGuidelinesLookup(db, (id) => profileStore.getResponseGuidelines(id)),
  });

  const jiraStore = new JiraStore({
    db,
    clock,
    events,
    settings,
    conversationLabel: (tx, conv) => participantLabel(tx, conv, settings.get("slack.selfUserId")),
  });
  const jira = new JiraService({ db, clock, settings, sync, store: jiraStore, queue });
  registerJiraJobs({
    db,
    clock,
    settings,
    sync,
    store: jiraStore,
    queue,
    events,
    scheduler,
    handlers,
    source: new JiraConnectorSource({ orchestrator, clock }),
  });

  // Phase 9: read-only local git, the registry (DB only, ADR-035) and the daily drift check.
  const repositoryProvider = new LocalGitProvider({ home });
  const repositories = new RepositoryRegistry({
    db,
    clock,
    audit,
    events,
    provider: repositoryProvider,
  });
  registerDriftCheck({
    db,
    clock,
    events,
    notifications,
    provider: repositoryProvider,
    scheduler,
    handlers,
  });
  // C6: read-only, path-scoped inspection on registration, weekly when HEAD moved, or on request.
  const inspections = registerInspectionJobs({
    db,
    clock,
    settings,
    events,
    audit,
    queue,
    provider: repositoryProvider,
    orchestrator,
    scheduler,
    dispatcher,
    handlers,
  });

  const brain = new BrainService({
    db,
    clock,
    settings,
    audit,
    events,
    registry: repositories,
    inspections,
  });

  // Phase 10: engineering tasks, the global lock, the investigation run and the pickup tick.
  const gitWorkflow = new LocalGitWorkflow({ home });
  const engineeringLock = new EngineeringLock({
    db,
    clock,
    leases,
    settings,
    events,
    audit,
    git: gitWorkflow,
    queue,
    approvals,
  });
  const engineering = new EngineeringTaskService({
    db,
    clock,
    events,
    audit,
    queue,
    provider: repositoryProvider,
    registry: repositories,
    lock: engineeringLock,
    git: gitWorkflow,
  });
  const engineeringSteps = new EngineeringStepService({
    db,
    clock,
    events,
    audit,
    queue,
    approvals,
    lock: engineeringLock,
    git: gitWorkflow,
    prs,
  });
  engineeringSteps.register(approvals, dispatcher);
  registerInvestigateJob({ db, settings, orchestrator, service: engineering, handlers });
  registerCodeAnswerJob({ db, settings, orchestrator, service: codeAnswers, handlers });
  registerStepJob({ db, settings, orchestrator, steps: engineeringSteps, handlers });
  registerPickupJobs({ service: engineering, lock: engineeringLock, scheduler, handlers });

  const health = new HealthService({
    database: databaseCheck(sqlite),
    jobs: jobsCheck(db, clock),
    events: eventsCheck(db),
    heartbeat: heartbeatCheck(settings, clock),
    linger: lingerCheck(run),
    bun: bunVersionCheck(),
    auth: authCheck(auth, clock),
    claude: claudeCheck(provider, clock),
    "security-rules": securityRulesCheck(securityFlags),
    "screening-rules": screeningRulesCheck(screening),
    "desktop-notifier": desktopNotifierCheck(notifier),
    claude_activity: claudeActivityCheck(claudeActivity),
  });

  const dashboard = new DashboardService({
    db,
    clock,
    settings,
    urgent,
    approvals,
    securityFlags,
    commitmentLifecycle,
    followups: followupService,
    peopleViews,
    sync,
    health,
    brain,
    engineeringLock,
    claudeActivity,
  });

  return {
    config,
    clock,
    db,
    sqlite,
    audit,
    events,
    dispatcher,
    live,
    queue,
    worker,
    leases,
    scheduler,
    settings,
    permissions,
    approvals,
    notifications,
    registry,
    provider,
    auth,
    orchestrator,
    health,
    claudeActivity,
    inbox,
    conversations,
    urgent,
    sync,
    people,
    discovery,
    profiles,
    profileStore,
    peopleViews,
    securityFlags,
    codeAnswers,
    outgoing,
    urgentReplies,
    autoReply,
    commitments,
    commitmentLifecycle,
    followups: followupService,
    dashboard,
    jira,
    repositories,
    inspections,
    brain,
    engineering,
    engineeringLock,
    engineeringSteps,
    handlers,
    recoverySweeps: [
      { name: "urgency.assess", run: urgency.recoverySweep },
      { name: "outgoing.sending", run: (tx) => outgoing.recoverySweep(tx) },
    ],
    slack: { startBackfill: slack.startBackfill, backfillResumable: slack.backfillResumable },
  };
}
