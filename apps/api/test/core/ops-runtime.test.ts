import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AIProvider } from "@synapse/contracts";
import { FakeClock } from "@synapse/shared";
import { createApp } from "../../src/app";
import { type Container, createContainer } from "../../src/container";
import { loadConfig } from "../../src/core/config/config";
import { BACKUP_NAME_RE } from "../../src/core/ops/backup";
import { readVersion } from "../../src/core/ops/runtime";

const fakeProvider: AIProvider = {
  execute: async () => {
    throw new Error("fake provider must not execute");
  },
  getHealth: async () => ({ status: "ok", version: "fake" }),
};
const GIB = 2 ** 30;
const KEYS = [
  "backupCount",
  "dataDirFreeBytes",
  "dbBytes",
  "lastBackup",
  "lastBackupAttempt",
  "memoryRssBytes",
  "queue",
  "retention",
  "startedAt",
  "uptimeSeconds",
  "version",
  "walBytes",
];
let root: string;
let clock: FakeClock;
let c: Container;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "syn-"));
  clock = new FakeClock(new Date("2026-11-07T12:00:00.000Z"));
  c = createContainer(loadConfig({ SYNAPSE_DB_PATH: ":memory:" }), {
    clock,
    run: async (cmd) => (cmd[0] === "git" ? "abc1234\n" : "Linger=no"),
    provider: fakeProvider,
    backupDir: join(root, "backups"),
    diskFree: () => 42 * GIB,
  });
  app = createApp(c);
  clock.advance(90_000);
});
afterEach(() => {
  c.sqlite.close();
  rmSync(root, { recursive: true, force: true });
});
const get = async () => {
  const res = await app.request("http://127.0.0.1:7400/api/system/runtime");
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown> & {
    queue: Record<string, unknown>;
    lastBackup: { name: string } | null;
  };
};

test("runtime view has exactly the RuntimeView keys and the measured values", async () => {
  const v = await get();
  expect(Object.keys(v).sort()).toEqual(KEYS);
  expect(v.uptimeSeconds).toBe(90);
  expect(v.version).toBe("0.0.0+abc1234");
  expect(v.walBytes).toBe(0);
  expect(v.dataDirFreeBytes).toBe(42 * GIB);
  expect(v.lastBackup).toBeNull();
  expect(v.backupCount).toBe(0);
  expect(v.lastBackupAttempt).toBeNull();
  expect(v.retention).toBeNull();
  expect(v.dbBytes as number).toBeGreaterThan(0);
  expect(v.memoryRssBytes as number).toBeGreaterThan(0);
  expect(v.queue).toEqual({
    pending: 0,
    running: 0,
    retry: 0,
    needsAttention: 0,
    oldestPendingAgeSeconds: null,
  });
  expect(JSON.stringify(v)).not.toContain(root);
});

test("queue counts and the oldest due pending age", async () => {
  const now = clock.now().getTime();
  const mk = (key: string, status: string, runAfterMs: number) => {
    const { id } = c.queue.enqueue(c.db, {
      type: "test.job",
      idempotencyKey: key,
      runAfter: new Date(now + runAfterMs).toISOString(),
    });
    c.sqlite.run("update jobs set status = ? where id = ?", [status, id]);
  };
  mk("a", "PENDING", -300_000);
  mk("b", "PENDING", -60_000);
  mk("future", "PENDING", 600_000);
  mk("c", "RUNNING", 0);
  mk("d", "RETRY", 0);
  mk("e", "NEEDS_ATTENTION", 0);
  const v = await get();
  expect(v.queue).toEqual({
    pending: 3,
    running: 1,
    retry: 1,
    needsAttention: 1,
    oldestPendingAgeSeconds: 300,
  });
});

test("a backup shows as the last backup and the retention summary is passed through", async () => {
  const r = c.backup.run(7);
  expect(r.ok).toBe(true);
  const summary = {
    at: "2026-11-07T03:00:00.000Z",
    date: "2026-11-07",
    jobs: 1,
    notifications: 2,
    events: 3,
    audit: 4,
    claudeRunsCompacted: 5,
    quickCheck: "ok" as const,
  };
  c.settings.set("ops.retention.lastRun", summary, { emit: false });
  const v = await get();
  expect(v.lastBackup?.name).toMatch(BACKUP_NAME_RE);
  expect(v.backupCount).toBe(1);
  expect(v.lastBackupAttempt).toMatchObject({ ok: true, code: null });
  expect(v.retention).toEqual(summary);
});

test("readVersion appends a valid short sha, ignores anything else, and is null without a package", async () => {
  const repo = join(root, "repo");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(join(repo, "apps/api"), { recursive: true });
  writeFileSync(join(repo, "apps/api/package.json"), JSON.stringify({ version: "0.0.0" }));
  expect(await readVersion(repo, async () => "Linger=no")).toBe("0.0.0");
  expect(await readVersion(repo, async () => "abc1234\n")).toBe("0.0.0+abc1234");
  expect(
    await readVersion(repo, async () => {
      throw new Error("no git");
    }),
  ).toBe("0.0.0");
  expect(await readVersion(join(root, "missing"), async () => "abc1234")).toBeNull();
});

test("a failed backup is the last attempt with its fixed code", async () => {
  c.audit.record(c.db, {
    actor: "system",
    module: "ops",
    action: "ops.backup_failed",
    result: "failed",
    details: { code: "vacuum_failed" },
  });
  const v = await get();
  expect(v.lastBackupAttempt).toMatchObject({ ok: false, code: "vacuum_failed" });
});
