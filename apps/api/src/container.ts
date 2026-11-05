import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AIProvider } from "@synapse/contracts";
import { type Db, openDatabase, runMigrations } from "@synapse/database";
import { type Clock, newId, systemClock } from "@synapse/shared";
import { ApprovalEngine } from "./core/approvals/approvals";
import { AuditLogger } from "./core/audit/audit";
import { type AppConfig, resolveHome } from "./core/config/config";
import { SettingsService } from "./core/config/settings";
import { OutboxDispatcher } from "./core/events/dispatcher";
import { LiveBus } from "./core/events/live-bus";
import { EventPublisher } from "./core/events/publisher";
import {
  authCheck,
  bunVersionCheck,
  claudeCheck,
  databaseCheck,
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
import { SchedulerService } from "./core/scheduler/scheduler";
import { HEARTBEAT_SCHEDULE, heartbeatHandler } from "./core/system/heartbeat";
import { ClaudeCliProvider } from "./integrations/claude-code/cli-provider";
import { loadSettingsOverride } from "./integrations/claude-code/settings-override";
import { SlackConnectorSource } from "./integrations/slack/connector-source";
import { ScreeningService } from "./modules/inbox/screening-service";
import { InboxStore } from "./modules/inbox/store";
import { SyncStateService } from "./modules/inbox/sync-state";
import { PeopleService } from "./modules/people/service";
import { SecurityFlagsService } from "./modules/security-flags/service";
import { registerSlackJobs } from "./workers/slack";
import { registerUrgencyJobs } from "./workers/urgency";

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
  inbox: InboxStore;
  sync: SyncStateService;
  people: PeopleService;
  securityFlags: SecurityFlagsService;
  slack: Pick<ReturnType<typeof registerSlackJobs>, "startBackfill" | "backfillResumable">;
}

export interface ContainerDeps {
  clock?: Clock;
  /** Replaces the real ClaudeCliProvider (tests inject a fake). */
  provider?: AIProvider;
  run?: (cmd: string[]) => Promise<string>;
  /** Registers the `test.noop` job handler (set from SYNAPSE_TEST_HANDLERS by main.ts). */
  testHandlers?: boolean;
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
  const notifications = new NotificationService(db, clock, live);
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
  const provider =
    deps.provider ??
    new ClaudeCliProvider({
      binary: config.claudeBinary,
      env: { PATH: `${home}/.bun/bin:${home}/.local/bin:/usr/bin:/bin`, HOME: home },
      clock,
      // Plugin names only, read once at startup (R34).
      settingsOverride: loadSettingsOverride(home),
    });
  const auth = new AuthMonitor(db, clock, settings, events, config.credentialsPath);
  const scratchDir =
    config.dbPath === ":memory:"
      ? mkdtempSync(join(tmpdir(), "synapse-scratch-"))
      : join(dirname(config.dbPath), "scratch");
  mkdirSync(scratchDir, { recursive: true });
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
  });

  const sync = new SyncStateService(db, clock);
  const inbox = new InboxStore({ db, clock, events, queue, sync });
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
  for (const type of ["message.received", "message.thread_updated"] as const) {
    dispatcher.subscribe(type, "inbox.screening", (event, tx) => screening.handle(event, tx));
  }
  const slack = registerSlackJobs({
    db,
    clock,
    source: new SlackConnectorSource({ orchestrator, clock }),
    store: inbox,
    sync,
    queue,
    settings,
    events,
    audit,
    scheduler,
    handlers,
  });
  registerUrgencyJobs({
    db,
    clock,
    settings,
    events,
    queue,
    notifications,
    orchestrator,
    securityFlags,
    handlers,
  });

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
    inbox,
    sync,
    people,
    securityFlags,
    slack: { startBackfill: slack.startBackfill, backfillResumable: slack.backfillResumable },
  };
}
