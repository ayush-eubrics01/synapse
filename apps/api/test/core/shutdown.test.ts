import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AIProvider } from "@synapse/contracts";
import { schema } from "@synapse/database";
import { eq } from "drizzle-orm";
import { type Container, createContainer } from "../../src/container";
import { loadConfig } from "../../src/core/config/config";
import { recoverOnStartup } from "../../src/core/recovery/recovery";
import {
  createShutdown,
  SHUTDOWN_GRACE_MS,
  type ShutdownDeps,
} from "../../src/core/system/shutdown";

function fakes(over: Partial<ShutdownDeps> = {}) {
  const calls: string[] = [];
  const deps: ShutdownDeps = {
    intervals: [setInterval(() => {}, 100_000), setInterval(() => {}, 100_000)],
    worker: {
      stop: async (ms: number) => {
        calls.push(`stop(${ms})`);
      },
    },
    releaseLeases: () => calls.push("release"),
    server: {
      stop: (force?: boolean) =>
        void calls.push(force === true ? "server.stop" : "server.stop(soft)"),
    },
    sqlite: {
      run: ((sql: string) => {
        calls.push(sql.includes("wal_checkpoint") ? "checkpoint" : sql);
      }) as never,
      close: () => calls.push("close"),
    },
    exit: (code) => calls.push(`exit(${code})`),
    log: (l) => calls.push(`log:${l}`),
    ...over,
  };
  return { calls, deps };
}

test("runs the steps in order", async () => {
  const { calls, deps } = fakes();
  await createShutdown(deps)("SIGTERM");
  expect(SHUTDOWN_GRACE_MS).toBe(10_000);
  expect(calls).toEqual([
    "stop(10000)",
    "release",
    "server.stop",
    "checkpoint",
    "close",
    "exit(0)",
  ]);
  for (const i of deps.intervals) clearInterval(i);
});

test("a second signal while the first runs exits 1 immediately", async () => {
  let release!: () => void;
  const { calls, deps } = fakes({
    worker: {
      stop: () =>
        new Promise<void>((r) => {
          release = r;
        }),
    },
  });
  const shutdown = createShutdown(deps);
  const first = shutdown("SIGTERM");
  await new Promise((r) => setTimeout(r, 0));
  await shutdown("SIGINT");
  expect(calls).toEqual(["exit(1)"]);
  release();
  await first;
  expect(calls.at(-1)).toBe("exit(0)");
});

test("a failing step is logged and the rest still runs", async () => {
  const { calls, deps } = fakes({
    worker: {
      stop: async () => {
        throw new TypeError("boom SENTINEL");
      },
    },
  });
  await createShutdown(deps)("SIGTERM");
  expect(calls).toContain("log:shutdown: worker.stop failed TypeError");
  expect(calls.join("|")).not.toContain("SENTINEL");
  expect(calls.slice(-5)).toEqual(["release", "server.stop", "checkpoint", "close", "exit(0)"]);
});

const fakeProvider: AIProvider = {
  execute: async () => {
    throw new Error("fake provider must not execute");
  },
  getHealth: async () => ({ status: "ok", version: "fake" }),
};
let root: string;
let c: Container;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "syn-"));
  c = createContainer(loadConfig({ SYNAPSE_DB_PATH: ":memory:" }), {
    provider: fakeProvider,
    run: async () => "Linger=no",
    claudeProjectsDir: join(root, "projects"),
    backupDir: join(root, "backups"),
  } as never);
});
afterEach(() => {
  c.sqlite.close();
  rmSync(root, { recursive: true, force: true });
});

function claimed(key: string, worker: string) {
  c.queue.enqueue(c.db, { type: "t", idempotencyKey: key, concurrencyGroup: key });
  const job = c.queue.claim(worker, 60_000, ["t"]);
  if (!job) throw new Error("no claim");
  return job.id;
}

test("expireLeasesOwnedBy expires only this worker's jobs; recovery requeues them", () => {
  const mine = claimed("a", c.workerId);
  const other = claimed("b", "other-worker");
  expect(c.queue.expireLeasesOwnedBy(c.workerId)).toBe(1);
  const row = (id: string) => c.db.select().from(schema.jobs).where(eq(schema.jobs.id, id)).get();
  expect((row(mine)?.leaseExpiresAt ?? "") <= c.clock.now().toISOString()).toBe(true);
  expect((row(other)?.leaseExpiresAt ?? "") > c.clock.now().toISOString()).toBe(true);
  recoverOnStartup({ db: c.db, clock: c.clock, leases: c.leases, audit: c.audit });
  expect(row(mine)?.status).toBe("RETRY");
  expect(row(other)?.status).toBe("RUNNING");
});

test("releaseHeldBy deletes this worker's leases but never the engineering lease", () => {
  c.leases.acquire("engineering", "task:t1", 60_000);
  c.leases.acquire("x", `${c.workerId}:x`, 60_000);
  c.leases.acquire("y", c.workerId, 60_000);
  c.leases.acquire("z", "other", 60_000);
  c.leases.acquire("engineering2", "task:t2", 60_000);
  expect(c.leases.releaseHeldBy(c.workerId)).toBe(2);
  expect(c.leases.get("engineering")?.holder).toBe("task:t1");
  expect(c.leases.get("x")).toBeNull();
  expect(c.leases.get("y")).toBeNull();
  expect(c.leases.get("z")?.holder).toBe("other");
});

test("releaseHeldBy skips the engineering lease even when this worker holds it", () => {
  c.leases.acquire("engineering", c.workerId, 60_000);
  expect(c.leases.releaseHeldBy(c.workerId)).toBe(0);
  expect(c.leases.get("engineering")?.holder).toBe(c.workerId);
});

test("shutdown completes promptly while a client holds /api/stream open", async () => {
  const { createApp } = await import("../../src/app");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createApp(c).fetch,
    idleTimeout: 0,
  });
  const res = await fetch(`http://127.0.0.1:${server.port}/api/stream`);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  await reader.read(); // ": connected" -- the stream is live and stays open
  const calls: string[] = [];
  const shutdown = createShutdown({
    intervals: [],
    worker: { stop: async () => {} },
    releaseLeases: () => {},
    server,
    sqlite: {
      run: ((sql: string) => void calls.push(sql)) as never,
      close: () => void calls.push("close"),
    },
    exit: (code) => void calls.push(`exit(${code})`),
    log: (l) => void calls.push(`log:${l}`),
  });
  const started = Date.now();
  await shutdown("SIGTERM");
  expect(Date.now() - started).toBeLessThan(3000);
  expect(calls).toEqual(["PRAGMA wal_checkpoint(TRUNCATE)", "close", "exit(0)"]);
  await reader.cancel().catch(() => {});
});
