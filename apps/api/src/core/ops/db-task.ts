export type DbTask =
  | { op: "backup"; dbPath: string; target: string }
  | { op: "quick_check"; dbPath: string };

export type DbTaskResult =
  | { ok: true }
  | {
      ok: false;
      code: "vacuum_failed" | "integrity_failed" | "check_failed" | "timeout" | "worker_failed";
      cause?: string;
    };

export const BACKUP_WORKER_TIMEOUT_MS = 600_000;
export const QUICK_CHECK_WORKER_TIMEOUT_MS = 300_000;

/**
 * Runs one database task in a Bun Worker with its own read-only connection, so the API thread is
 * never blocked. Never rejects: a crash is `worker_failed`, the timer is `timeout`.
 */
export function runDbTask(
  task: DbTask,
  opts: { timeoutMs: number; url?: URL },
): Promise<DbTaskResult> {
  return new Promise<DbTaskResult>((resolve) => {
    let worker: Worker | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const settle = (r: DbTaskResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        worker?.terminate();
      } catch {
        // already gone
      }
      resolve(r);
    };
    try {
      worker = new Worker(opts.url ?? new URL("./db-worker.ts", import.meta.url));
    } catch {
      settle({ ok: false, code: "worker_failed" });
      return;
    }
    worker.onmessage = (e: MessageEvent) => settle(e.data as DbTaskResult);
    worker.onerror = (e: ErrorEvent) => {
      e.preventDefault?.();
      settle({ ok: false, code: "worker_failed" });
    };
    worker.addEventListener("close", () => settle({ ok: false, code: "worker_failed" }));
    timer = setTimeout(() => settle({ ok: false, code: "timeout" }), opts.timeoutMs);
    try {
      worker.postMessage(task);
    } catch {
      settle({ ok: false, code: "worker_failed" });
    }
  });
}
