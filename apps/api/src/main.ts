import { createApp } from "./app";
import { createContainer } from "./container";
import { loadConfig } from "./core/config/config";
import {
  REAP_INTERVAL_MS,
  reapExpiredJobs,
  recoverOnStartup,
  recoverOrphanRuns,
} from "./core/recovery/recovery";
import { createShutdown } from "./core/system/shutdown";
import { NotifySendNotifier } from "./infrastructure/notifier";
import { PRIVATE_FILES_LOG_LINE, securePrivateFiles } from "./infrastructure/private-files";
import { pruneBaseFor, pruneInstanceRoots, sweepRunScratch } from "./workers/engineering/steps";
import { OPS_BACKUP_JOB } from "./workers/ops";

const config = loadConfig(process.env);
// R1: new files are private; existing data files are tightened before anything opens them.
process.umask(0o077);
const filePermissions = securePrivateFiles(config.dbPath);
if (!filePermissions.ok) console.error(PRIVATE_FILES_LOG_LINE);
const c = createContainer(config, {
  filePermissions,
  testHandlers: process.env.SYNAPSE_TEST_HANDLERS === "1",
  notifier: new NotifySendNotifier(),
});
let server: ReturnType<typeof Bun.serve>;
try {
  server = Bun.serve({
    hostname: config.api.host,
    port: config.api.port,
    fetch: createApp(c).fetch,
    // Bun's default 10 s idle timeout would cut SSE streams before the 15 s keep-alive.
    idleTimeout: 0,
  });
} catch (e) {
  if ((e as { code?: string }).code === "EADDRINUSE") {
    process.stderr.write(`port ${config.api.port} already in use\n`);
    c.sqlite.close();
    process.exit(1);
  }
  throw e;
}

// Recovery runs only once this process owns the port: a second process that fails with
// EADDRINUSE above has changed nothing (no job, lease or run of the live process is touched).
recoverOnStartup({
  db: c.db,
  clock: c.clock,
  leases: c.leases,
  audit: c.audit,
  sweeps: c.recoverySweeps,
});
recoverOrphanRuns(c.db, c.clock);
// ADR-040: leftover develop-run dirs of a killed process. Here, never in createContainer, for the
// same reason: it deletes runs a live process on the same data dir may be using.
sweepRunScratch(c.runRoot);
// ADR-040: run roots of other instances (old data dirs, smokes) nothing touched for 7 days.
// Only a real instance base (`<cache>/synapse`); an in-memory container's sibling dir is never one.
const pruneBase = pruneBaseFor(config.dbPath, c.runRoot, process.env);
if (pruneBase !== null) {
  const pruned = pruneInstanceRoots(pruneBase, c.runRoot);
  console.log(`engineering.step: old run roots removed=${pruned.removed} kept=${pruned.kept}`);
}
// R4: the result feeds the `database` health check; a failure is reported there, not fatal here.
void c.integrity.check();
// E6: the engineering lease is never released by core recovery. Settled here, before the worker
// and the scheduler start, so no step or pickup runs against a tree that a crash left half-changed.
try {
  await c.engineeringLock.recover();
} catch (e) {
  console.error("engineering lock recovery failed:", e instanceof Error ? e.name : "non-error");
}
try {
  c.auth.record();
} catch (e) {
  console.error("auth record failed:", e instanceof Error ? e.name : "non-error value thrown");
}

const guarded = (name: string, fn: () => void) => () => {
  try {
    fn();
  } catch (e) {
    console.error(`${name} failed:`, e instanceof Error ? e.message : String(e));
  }
};

const tick = guarded("scheduler", () => c.scheduler.tick());
const dispatch = guarded("dispatcher", () => c.dispatcher.dispatchOnce());
const expire = guarded("approvals.expireDue", () => c.approvals.expireDue());
const reap = guarded("recovery.reap", () =>
  reapExpiredJobs({ db: c.db, clock: c.clock, audit: c.audit, sweeps: c.recoverySweeps }),
);

// H4.2: the daily backup tick is due right after startup (coalesced; `dailyDue` decides).
try {
  c.scheduler.runNow(OPS_BACKUP_JOB);
} catch (e) {
  console.error("backup tick at startup failed:", e instanceof Error ? e.name : "non-error");
}
tick();
const intervals = [
  setInterval(tick, 5_000),
  setInterval(dispatch, 1_000),
  setInterval(expire, 60_000),
  setInterval(reap, REAP_INTERVAL_MS),
];
c.worker.start();

const shutdown = createShutdown({
  intervals,
  worker: c.worker,
  releaseLeases: () => {
    c.queue.expireLeasesOwnedBy(c.workerId);
    c.leases.releaseHeldBy(c.workerId);
  },
  server,
  sqlite: c.sqlite,
  exit: (code) => process.exit(code),
});
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
