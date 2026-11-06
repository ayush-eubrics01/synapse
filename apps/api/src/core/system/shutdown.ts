import type { Database } from "bun:sqlite";
import type { JobWorker } from "../jobs/worker";

export const SHUTDOWN_GRACE_MS = 10_000;

export interface ShutdownDeps {
  intervals: ReturnType<typeof setInterval>[];
  worker: Pick<JobWorker, "stop">;
  releaseLeases: () => void;
  server: { stop(): void };
  sqlite: Pick<Database, "run" | "close">;
  exit: (code: number) => void;
  log?: (line: string) => void;
}

/**
 * R6: graceful shutdown. The first call stops the timers, waits for the worker, releases this
 * process's leases, closes the server, checkpoints the WAL and closes the database; a failing
 * step is logged by name and error class only and the sequence continues. A second call while
 * the first runs exits at once.
 */
export function createShutdown(deps: ShutdownDeps): (signal: string) => Promise<void> {
  const log = deps.log ?? ((line: string) => console.error(line));
  let running = false;
  const step = async (name: string, fn: () => unknown): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      log(`shutdown: ${name} failed ${e instanceof Error ? e.name : "NonError"}`);
    }
  };
  return async () => {
    if (running) {
      deps.exit(1);
      return;
    }
    running = true;
    await step("intervals", () => {
      for (const i of deps.intervals) clearInterval(i);
    });
    await step("worker.stop", () => deps.worker.stop(SHUTDOWN_GRACE_MS));
    await step("releaseLeases", () => deps.releaseLeases());
    await step("server.stop", () => deps.server.stop());
    await step("checkpoint", () => deps.sqlite.run("PRAGMA wal_checkpoint(TRUNCATE)"));
    await step("close", () => deps.sqlite.close());
    deps.exit(0);
  };
}
