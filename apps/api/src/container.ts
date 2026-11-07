import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, statfsSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type AIProvider,
  type DesktopNotifier,
  type MessageSink,
  type PullRequestProvider,
  SANDBOX_MASKED_ROOTS,
} from "@synapse/contracts";
import { type Db, openDatabase, runMigrations } from "@synapse/database";
import { type Clock, newId, systemClock } from "@synapse/shared";
import { ApprovalEngine } from "./core/approvals/approvals";
import { registerApprovalExecution } from "./core/approvals/execution";
import { AuditLogger } from "./core/audit/audit";
import {
  type AppConfig,
  checkBackupDir,
  defaultRunScratchRoot,
  instanceRunRoot,
  REPO_ROOT,
  resolveHome,
} from "./core/config/config";
import { SettingsService } from "./core/config/settings";
import { OutboxDispatcher } from "./core/events/dispatcher";
import { LiveBus } from "./core/events/live-bus";
import { EventPublisher } from "./core/events/publisher";
import {
  authCheck,
  backupCheck,
  bunVersionCheck,
  claudeActivityCheck,
  claudeCheck,
  claudeSettingsCheck,
  databaseCheck,
  desktopNotifierCheck,
  diskCheck,
  eventsCheck,
  filePermissionsCheck,
  heartbeatCheck,
  jobsCheck,
  lingerCheck,
  sandboxCheck,
  screeningRulesCheck,
  securityRulesCheck,
} from "./core/health/checks";
import { HealthService } from "./core/health/health";
import { JobQueue } from "./core/jobs/queue";
import { type HandlerRegistration, JobWorker } from "./core/jobs/worker";
import { LeaseService } from "./core/leases/leases";
import { ModuleRegistry } from "./core/module-registry/registry";
import { NotificationService } from "./core/notifications/notifications";
import { BackupService } from "./core/ops/backup";
import { DatabaseIntegrity } from "./core/ops/integrity";
import { RetentionService } from "./core/ops/retention";
import { RuntimeService, readVersion } from "./core/ops/runtime";
import { AuthMonitor } from "./core/orchestrator/auth";
import { ClaudeOrchestrator } from "./core/orchestrator/orchestrator";
import { PermissionManager } from "./core/permissions/permissions";
import type { RecoverySweep } from "./core/recovery/recovery";
import { SchedulerService } from "./core/scheduler/scheduler";
import { HEARTBEAT_SCHEDULE, heartbeatHandler } from "./core/system/heartbeat";
import { NoopDesktopNotifier, type NotifierHealth } from "./infrastructure/notifier";
import {
  defaultBackupDir,
  isDedicatedDataDir,
  type PrivateFilesResult,
} from "./infrastructure/private-files";
import { type CommandRunner, runCommand } from "./infrastructure/run-command";
import { ClaudeCliProvider } from "./integrations/claude-code/cli-provider";
import { loadUserSettings } from "./integrations/claude-code/settings-override";
import { GitHubCliProvider } from "./integrations/github/gh-cli";
import { JiraConnectorSource } from "./integrations/jira/connector-source";
import { LocalGitWorkflow } from "./integrations/repository/git-workflow";
import { LocalGitProvider } from "./integrations/repository/local-git";
import { SlackConnectorSource } from "./integrations/slack/connector-source";
import { normaliseSentText, SlackSender } from "./integrations/slack/sender";
import { runRootMasked } from "./intelligence/engineering/develop-prompt";
import { autoSentOutgoingIds } from "./modules/auto-reply/read";
import { AutoReplyService } from "./modules/auto-reply/service";
import { WipReminders } from "./modules/claude-activity/reminders";
import { ClaudeActivityService } from "./modules/claude-activity/service";
import { AwayCodeAnswerTrigger } from "./modules/code-answers/away-trigger";
import { CodeAnswerService } from "./modules/code-answers/service";
import { ExtractionQueue } from "./modules/commitments/extraction-queue";
import { FollowupService } from "./modules/commitments/followups";
import { CommitmentLifecycle } from "./modules/commitments/lifecycle";
import { StallService } from "./modules/commitments/stall";
import { CommitmentStore } from "./modules/commitments/store";
import { DashboardLayoutService } from "./modules/dashboard/layouts";
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
import { registerStepJob, runTmpTooLong } from "./workers/engineering/steps";
import { createRunHelpers } from "./workers/intelligence-shared";
import { registerJiraJobs } from "./workers/jira";
import { registerOpsJobs } from "./workers/ops";
import { registerOutgoingJobs } from "./workers/outgoing";
import { registerPeopleJobs } from "./workers/people";
import { registerSlackJobs } from "./workers/slack";
import { registerUrgencyJobs, responseGuidelinesLookup } from "./workers/urgency";

export interface Container {
  config: AppConfig;
  /** This instance's develop-run root (ADR-040): `<cache>/synapse/<hash of data dir>`. */
  runRoot: string;
  clock: Clock;
  db: Db;
  sqlite: Database;
  audit: AuditLogger;
  events: EventPublisher;
  dispatcher: OutboxDispatcher;
  live: LiveBus;
  queue: JobQueue;
  worker: JobWorker;
  workerId: string;
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
  backup: BackupService;
  integrity: DatabaseIntegrity;
  retention: RetentionService;
  runtime: RuntimeService;
  startedAt: Date;
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
  dashboardLayouts: DashboardLayoutService;
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
  run?: CommandRunner;
  /** Resolves a binary on the service PATH (tests inject one; defaults to Bun.which). */
  which?: (bin: string) => string | null;
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
  /** Result of securePrivateFiles from main.ts; defaults to ok. */
  filePermissions?: PrivateFilesResult;
  /** Overrides the backup directory (tests inject a temp dir). */
  backupDir?: string;
  /** Free bytes at a path, or null when unknown. Defaults to statfs. */
  diskFree?: (path: string) => number | null;
  /**
   * Replaces the paths a develop run's repository may not be under (default
   * SANDBOX_MASKED_ROOTS). Tests only: their repositories live under the OS temp dir.
   */
  sandboxMaskedRoots?: readonly string[];
  /**
   * Replaces the develop-run cache base (default `defaultRunScratchRoot(process.env)`, i.e.
   * `~/.cache/synapse`). The instance's run root is `instanceRunRoot(base, dataDir)`, and runs get
   * `<it>/r/<8hex>/t` (ADR-040). Unused for `:memory:`.
   */
  runCacheBase?: string;
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

function defaultDiskFree(p: string): number | null {
  try {
    const s = statfsSync(p);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
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

  const workerId = `${hostname()}-${process.pid}-${newId()}`;
  const worker = new JobWorker(queue, handlers, {
    workerId,
    concurrency: config.workerConcurrency,
    onSettled: (job) => live.publish({ type: "job.updated", data: job }),
  });

  const home = resolveHome(process.env);
  // Plugin names and the user-permission widening flag, read once at startup (R34, Phase 9).
  const userSettings = loadUserSettings(home);
  const servicePath = `${home}/.bun/bin:${home}/.local/bin:/usr/bin:/bin`;
  const which = deps.which ?? ((b: string) => Bun.which(b, { PATH: servicePath }));
  const provider =
    deps.provider ??
    new ClaudeCliProvider({
      binary: config.claudeBinary,
      env: { PATH: servicePath, HOME: home },
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
    autoSent: (ids) => autoSentOutgoingIds(db, ids),
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
    codeAnswerHeld: (tx, id) => codeAnswers.returnToHeld(tx, id),
  });
  outgoing.register(approvals, dispatcher);
  const urgentReplies = new UrgentReplies({ db, clock, audit, outgoing });
  registerOutgoingJobs({ handlers, outgoing });
  const codeAnswers = new CodeAnswerService({
    db,
    clock,
    events,
    audit,
    queue,
    settings,
    securityFlags,
    outgoing,
    approvals,
  });
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
    codeAnswers,
  });
  registerAutoReplyJobs({ handlers, autoReply });
  dispatcher.subscribe("message.urgent_detected", "autoreply.acknowledgement", (event, tx) =>
    autoReply.onUrgentDetected(event, tx),
  );
  dispatcher.subscribe("followup.draft_created", "autoreply.followup", (event, tx) =>
    autoReply.onFollowupDraftCreated(event, tx),
  );
  // C6: while away, a priority person's question naming exactly one repository queues an answer.
  const awayCodeAnswers = new AwayCodeAnswerTrigger({
    clock,
    settings,
    autoReply,
    people,
    codeAnswers,
  });
  dispatcher.subscribe("message.received", "code_answer.away", (event, tx) =>
    awayCodeAnswers.onMessageReceived(event, tx),
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
  const jira = new JiraService({ db, clock, settings, sync, store: jiraStore, queue, audit });
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
  const sandboxHealthCheck = sandboxCheck({
    settings,
    which,
    runRootMasked: () =>
      runRootMasked(
        runRoot,
        home,
        [dataDir, backupDir],
        deps.sandboxMaskedRoots ?? SANDBOX_MASKED_ROOTS,
      ),
  });
  const engineeringSteps = new EngineeringStepService({
    settings,
    sandboxHealth: () => sandboxHealthCheck(),
    sandboxPathTooLong: () => runTmpTooLong(runRoot),
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
  registerCodeAnswerJob({
    db,
    settings,
    orchestrator,
    service: codeAnswers,
    handlers,
    // C7: an away run that ended with something to decide goes to the auto-reply policy, queued in
    // the transaction that settles the row. A failed away run records nothing.
    onFinished: (tx, row) => {
      if (
        row.trigger === "away" &&
        (row.status === "ready" || row.status === "not_answerable" || row.status === "unverified")
      ) {
        autoReply.enqueue(tx, { kind: "code_answer", codeAnswerId: row.id });
      }
    },
  });
  registerPickupJobs({ service: engineering, lock: engineeringLock, scheduler, handlers });

  const dataDir = config.dbPath === ":memory:" ? scratchDir : dirname(config.dbPath);
  const explicitBackupDir = deps.backupDir ?? config.backupDir ?? settings.get("ops.backup.dir");
  const backupDir =
    explicitBackupDir ??
    (config.dbPath === ":memory:"
      ? join(scratchDir, "backups")
      : defaultBackupDir(config.dbPath, { home }));
  if (explicitBackupDir !== null && checkBackupDir(explicitBackupDir) !== "ok") {
    throw new Error("ops.backup.dir must be an absolute path outside the repository");
  }
  // ADR-040: develop runs get a per-run scratch under the run root; the data and backup dirs are
  // masked in the sandbox along with the home credential dirs. Task 4b: the run root is never
  // inside the data dir (a TMPDIR under a mask breaks every Bash call), and it is per instance
  // (`~/.cache/synapse/<hash of data dir>`), so this instance's sweep never touches another's
  // runs. An in-memory container (whose data dir is the temp scratchDir) uses the sibling
  // `<scratchDir>-runs`. Nothing is created here: the step worker creates it (0700) for a run.
  const runRoot =
    config.dbPath === ":memory:"
      ? `${scratchDir}-runs`
      : instanceRunRoot(deps.runCacheBase ?? defaultRunScratchRoot(process.env), dataDir);
  registerStepJob({
    db,
    settings,
    orchestrator,
    steps: engineeringSteps,
    handlers,
    sandbox: {
      runRoot,
      home,
      protectedDirs: [dataDir, backupDir],
      ...(deps.sandboxMaskedRoots ? { maskedRoots: deps.sandboxMaskedRoots } : {}),
    },
  });
  // The leftover-run sweep is not here: main.ts runs it after the port bind (a second process that
  // fails to bind must not delete the live process's runs).
  const diskFree = deps.diskFree ?? defaultDiskFree;
  const startedAt = clock.now();
  const backup = new BackupService({
    db,
    sqlite,
    clock,
    audit,
    dir: backupDir,
    checkDir: explicitBackupDir !== null,
    chmodDir:
      explicitBackupDir === null &&
      (config.dbPath === ":memory:" || isDedicatedDataDir(config.dbPath, { home })),
    dbPath: config.dbPath,
    diskFree,
  });
  const integrity = new DatabaseIntegrity(sqlite, clock, { dbPath: config.dbPath });
  const runtime = new RuntimeService({
    db,
    sqlite,
    clock,
    settings,
    startedAt,
    dbPath: config.dbPath,
    dataDir,
    diskFree,
    backup,
    version: readVersion(REPO_ROOT, run),
    endpoints: { api: config.api, web: config.web },
  });
  const retention = new RetentionService({ db, sqlite, clock, settings, audit, integrity });
  registerOpsJobs({ db, handlers, scheduler, queue, settings, clock, backup, retention });

  const health = new HealthService({
    database: databaseCheck(sqlite, integrity),
    jobs: jobsCheck(db, clock),
    events: eventsCheck(db),
    heartbeat: heartbeatCheck(settings, clock),
    linger: lingerCheck(run),
    bun: bunVersionCheck(),
    auth: authCheck(auth, clock),
    claude: claudeCheck(provider, clock),
    sandbox: sandboxHealthCheck,
    claude_settings: claudeSettingsCheck({
      provider,
      knownServers: () => settings.get("orchestrator.knownServers"),
    }),
    "security-rules": securityRulesCheck(securityFlags),
    "screening-rules": screeningRulesCheck(screening),
    "desktop-notifier": desktopNotifierCheck(notifier),
    claude_activity: claudeActivityCheck(claudeActivity),
    backup: backupCheck({ settings, backup, clock, startedAt }),
    disk: diskCheck({ settings, diskFree, dataDir }),
    file_permissions: filePermissionsCheck(
      deps.filePermissions ?? { ok: true, changed: 0, failed: 0 },
    ),
  });

  const dashboardLayouts = new DashboardLayoutService({ db, clock, audit, events });
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
    runRoot,
    clock,
    db,
    sqlite,
    audit,
    events,
    dispatcher,
    live,
    queue,
    worker,
    workerId,
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
    backup,
    integrity,
    retention,
    runtime,
    startedAt,
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
    dashboardLayouts,
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
      { name: "code_answer.running", run: (tx) => codeAnswers.recoverySweep(tx) },
    ],
    slack: { startBackfill: slack.startBackfill, backfillResumable: slack.backfillResumable },
  };
}
