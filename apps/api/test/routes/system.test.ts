import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AIProvider } from "@synapse/contracts";
import { openDatabase, runMigrations } from "@synapse/database";
import { FakeClock } from "@synapse/shared";
import { createApp } from "../../src/app";
import { type Container, createContainer } from "../../src/container";
import { loadConfig } from "../../src/core/config/config";
import { SettingsService } from "../../src/core/config/settings";
import { backupCheck, diskCheck } from "../../src/core/health/checks";

const fakeProvider: AIProvider = {
  execute: async () => {
    throw new Error("fake provider must not execute");
  },
  getHealth: async () => ({ status: "ok", version: "fake" }),
};
let c: Container;
let app: ReturnType<typeof createApp>;
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "syn-"));
  c = createContainer(loadConfig({ SYNAPSE_DB_PATH: ":memory:" }), {
    run: async () => "Linger=yes",
    provider: fakeProvider,
    backupDir: join(root, "backups"),
    diskFree: () => 100 * 2 ** 30,
  });
  app = createApp(c);
});
afterEach(() => {
  c.sqlite.close();
  rmSync(root, { recursive: true, force: true });
});
const call = (method: string) =>
  app.request("http://127.0.0.1:7400/api/system/backups", { method });

test("POST enqueues a manual job; a second POST while pending is 409", async () => {
  const res = await call("POST");
  expect(res.status).toBe(202);
  const { jobId } = (await res.json()) as { jobId: string };
  const job = c.queue.list({ limit: 10 }).find((j) => j.id === jobId);
  expect(job?.type).toBe("ops.backup");
  expect(job?.input).toEqual({ manual: true });
  const again = await call("POST");
  expect(again.status).toBe(409);
  expect(await again.json()).toEqual({ error: "already_running" });
});

function seedJob(status: string, input: unknown) {
  c.sqlite
    .query(
      "insert into jobs (id, type, status, priority, input, max_attempts, idempotency_key, run_after, created_at) values (?, 'ops.backup', ?, 100, ?, 3, ?, ?, ?)",
    )
    .run(
      `j-${status}`,
      status,
      input === null ? null : JSON.stringify(input),
      `k-${status}`,
      "2026-11-07T00:00:00.000Z",
      "2026-11-07T00:00:00.000Z",
    );
}

test("a pending scheduled backup does not block Back up now", async () => {
  seedJob("PENDING", null);
  expect((await call("POST")).status).toBe(202);
});

test("a running scheduled backup blocks Back up now", async () => {
  seedJob("RUNNING", null);
  const res = await call("POST");
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: "already_running" });
});

test("a manual backup in RETRY blocks Back up now", async () => {
  seedJob("RETRY", { manual: true });
  expect((await call("POST")).status).toBe(409);
});

test("GET lists backups", async () => {
  expect(await (await call("GET")).json()).toEqual([]);
  mkdirSync(join(root, "backups"), { recursive: true });
  writeFileSync(join(root, "backups", "synapse-20261107-030000.db"), "abc");
  const list = (await (await call("GET")).json()) as { name: string; bytes: number }[];
  expect(list.map((e) => [e.name, e.bytes])).toEqual([["synapse-20261107-030000.db", 3]]);
});

const H = 3_600_000;
async function checkEnv(over: {
  enabled?: boolean;
  uptimeH: number;
  ageH: number | null;
  ok?: boolean;
}) {
  const o = openDatabase(":memory:");
  runMigrations(o.db);
  const clock = new FakeClock(new Date("2026-11-07T12:00:00.000Z"));
  const settings = new SettingsService(o.db, clock, () => "");
  if (over.enabled === false) settings.set("ops.backup.enabled", false);
  const check = backupCheck({
    settings,
    clock,
    startedAt: new Date(clock.now().getTime() - over.uptimeH * H),
    backup: {
      list: () =>
        over.ageH === null
          ? []
          : [
              {
                name: "synapse-20261107-030000.db",
                bytes: 1,
                createdAt: new Date(clock.now().getTime() - over.ageH * H).toISOString(),
              },
            ],
      lastAttempt: () => (over.ok === false ? { ok: false, at: clock.now().toISOString() } : null),
    },
  });
  const result = await check();
  o.sqlite.close();
  return result;
}

test("backupCheck", async () => {
  expect(await checkEnv({ enabled: false, uptimeH: 100, ageH: null })).toEqual({
    status: "ok",
    detail: "disabled",
  });
  expect(await checkEnv({ uptimeH: 1, ageH: 1, ok: false })).toEqual({
    status: "degraded",
    detail: "last backup failed",
  });
  expect((await checkEnv({ uptimeH: 23, ageH: null })).status).toBe("ok");
  expect(await checkEnv({ uptimeH: 25, ageH: null })).toEqual({
    status: "degraded",
    detail: "no backup in 36 h",
  });
  expect((await checkEnv({ uptimeH: 50, ageH: 35 })).status).toBe("ok");
  expect((await checkEnv({ uptimeH: 50, ageH: 37 })).status).toBe("degraded");
});

test("diskCheck", async () => {
  const o = openDatabase(":memory:");
  runMigrations(o.db);
  const settings = new SettingsService(o.db, new FakeClock(new Date()), () => "");
  const GiB = 2 ** 30;
  const run = (n: number | null) => diskCheck({ settings, diskFree: () => n, dataDir: "/x" })();
  expect((await run(6 * GiB)).status).toBe("ok");
  expect(await run(4 * GiB)).toEqual({ status: "degraded", detail: "4.0 GiB free" });
  expect((await run(0.5 * GiB)).status).toBe("down");
  expect(await run(null)).toEqual({ status: "degraded", detail: "free space unknown" });
  o.sqlite.close();
});
