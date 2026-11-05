import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DbOrTx } from "@synapse/database";
import { openDatabase, runMigrations } from "@synapse/database";
import { FakeClock } from "@synapse/shared";
import { SettingsService } from "../../src/core/config/settings";
import {
  bunVersionCheck,
  databaseCheck,
  heartbeatCheck,
  jobsCheck,
  lingerCheck,
} from "../../src/core/health/checks";
import { HealthService } from "../../src/core/health/health";
import { JobQueue } from "../../src/core/jobs/queue";
import { HEARTBEAT_SCHEDULE, heartbeatHandler } from "../../src/core/system/heartbeat";

let db: ReturnType<typeof openDatabase>["db"];
let clock: FakeClock;
let events: number;
let settings: SettingsService;
const ok = async () => ({ status: "ok" as const });

beforeEach(() => {
  db = openDatabase(":memory:").db;
  runMigrations(db);
  clock = new FakeClock("2026-11-05T12:00:00.000Z");
  events = 0;
  settings = new SettingsService(db, clock, (_tx: DbOrTx) => {
    events++;
    return "e";
  });
});

test("overall is worst check; throwing check is down", async () => {
  expect((await new HealthService({ a: ok }).report()).status).toBe("ok");
  const degraded = await new HealthService({
    a: ok,
    b: async () => ({ status: "degraded", detail: "x" }),
  }).report();
  expect(degraded.status).toBe("degraded");
  const down = await new HealthService({
    b: async () => ({ status: "degraded" }),
    c: async () => {
      throw new Error("boom");
    },
  }).report();
  expect(down.status).toBe("down");
  expect(down.checks.c).toEqual({ status: "down", detail: "boom" });
});

test("linger check", async () => {
  expect(await lingerCheck(async () => "Linger=yes\n", "bob")()).toEqual({ status: "ok" });
  expect(await lingerCheck(async () => "Linger=no\n", "bob")()).toEqual({
    status: "degraded",
    detail: "run: loginctl enable-linger bob",
  });
  expect((await lingerCheck(async () => "garbage", "bob")()).status).toBe("degraded");
  expect(
    (
      await lingerCheck(async () => {
        throw new Error("nope");
      }, "bob")()
    ).status,
  ).toBe("down");
});

test("bun version compares numerically", async () => {
  expect((await bunVersionCheck("1.4.2")()).status).toBe("down");
  expect((await bunVersionCheck("1.4.4")()).status).toBe("ok");
  expect((await bunVersionCheck("1.4.10")()).status).toBe("ok");
  expect((await bunVersionCheck("1.10.0")()).status).toBe("ok");
});

test("database check requires wal", async () => {
  expect((await databaseCheck(openDatabase(":memory:").sqlite)()).status).toBe("degraded");
  const dir = mkdtempSync(join(tmpdir(), "synapse-health-"));
  try {
    const { sqlite } = openDatabase(join(dir, "t.db"));
    expect(await databaseCheck(sqlite)()).toEqual({ status: "ok" });
    sqlite.close();
    expect((await databaseCheck(sqlite)()).status).toBe("down");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("heartbeat handler writes without emitting; heartbeat check goes stale", async () => {
  const check = heartbeatCheck(settings, clock);
  expect((await check()).status).toBe("degraded");
  const reg = heartbeatHandler(settings, clock);
  expect(reg.timeoutMs).toBe(10_000);
  expect(HEARTBEAT_SCHEDULE).toEqual({
    name: "system.heartbeat",
    jobType: "system.heartbeat",
    intervalSeconds: 60,
  });
  await reg.handler({} as never, {} as never);
  expect(settings.get("system.lastHeartbeatAt")).toBe("2026-11-05T12:00:00.000Z");
  expect(events).toBe(0);
  expect((await check()).status).toBe("ok");
  clock.advance(3 * 60_000 + 1);
  expect((await check()).status).toBe("degraded");
});

test("jobs check flags stale pending and expired running", async () => {
  const q = new JobQueue(db, clock);
  const check = jobsCheck(q, clock);
  expect((await check()).status).toBe("ok");
  q.enqueue(db, { type: "t", idempotencyKey: "k" });
  clock.advance(14 * 60_000);
  expect((await check()).status).toBe("ok");
  clock.advance(2 * 60_000);
  expect((await check()).status).toBe("degraded");
  q.claim("w", 1000, ["t"]);
  expect((await check()).status).toBe("ok");
  clock.advance(1000);
  expect((await check()).status).toBe("degraded");
});
