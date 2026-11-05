import { createApp } from "./app";
import { createContainer } from "./container";
import { loadConfig } from "./core/config/config";
import { REAP_INTERVAL_MS, reapExpiredJobs, recoverOnStartup } from "./core/recovery/recovery";

const config = loadConfig(process.env);
const c = createContainer(config, { testHandlers: process.env.SYNAPSE_TEST_HANDLERS === "1" });
recoverOnStartup({ db: c.db, clock: c.clock, leases: c.leases, audit: c.audit });

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
  reapExpiredJobs({ db: c.db, clock: c.clock, audit: c.audit }),
);

tick();
const intervals = [
  setInterval(tick, 5_000),
  setInterval(dispatch, 1_000),
  setInterval(expire, 60_000),
  setInterval(reap, REAP_INTERVAL_MS),
];
c.worker.start();

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const i of intervals) clearInterval(i);
  try {
    await c.worker.stop(10_000);
    server.stop();
    c.sqlite.close();
  } catch (e) {
    console.error("shutdown failed:", e instanceof Error ? e.message : String(e));
  }
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
