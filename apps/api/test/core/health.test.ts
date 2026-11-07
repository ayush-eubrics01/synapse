import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DbOrTx } from "@synapse/database";
import { openDatabase, runMigrations, schema } from "@synapse/database";
import { FakeClock } from "@synapse/shared";
import { SettingsService } from "../../src/core/config/settings";
import {
  bunVersionCheck,
  claudeSettingsCheck,
  databaseCheck,
  eventsCheck,
  heartbeatCheck,
  jobsCheck,
  lingerCheck,
  sandboxCheck,
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
  const check = jobsCheck(db, clock);
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

test("jobs check reports NEEDS_ATTENTION jobs with a count", async () => {
  const q = new JobQueue(db, clock);
  const check = jobsCheck(db, clock);
  for (const key of ["a", "b"]) {
    const { id } = q.enqueue(db, { type: "t", idempotencyKey: key });
    const owner = q.claim("w", 60_000, ["t"])?.leaseOwner ?? "";
    q.fail(id, owner, { kind: "auth_failed", message: "no" });
  }
  expect(await check()).toEqual({ status: "degraded", detail: "2 job(s) need attention" });
});

test("jobs check lists every problem it finds", async () => {
  const q = new JobQueue(db, clock);
  const parked = q.enqueue(db, { type: "t", idempotencyKey: "parked" }).id;
  const owner = q.claim("w", 60_000, ["t"])?.leaseOwner ?? "";
  q.fail(parked, owner, { kind: "auth_failed", message: "no" });
  q.enqueue(db, { type: "t", idempotencyKey: "stuck" });
  q.claim("w", 1000, ["t"]);
  q.enqueue(db, { type: "t", idempotencyKey: "waiting" });
  clock.advance(16 * 60_000);
  expect(await jobsCheck(db, clock)()).toEqual({
    status: "degraded",
    detail:
      "oldest due pending job is from 2026-11-05T12:00:00.000Z; " +
      "1 running job(s) with expired lease; 1 job(s) need attention",
  });
});

test("events check is degraded while any consumer has failed an event", async () => {
  const check = eventsCheck(db);
  expect(await check()).toEqual({ status: "ok" });
  for (const id of ["e1", "e2"]) {
    db.insert(schema.domainEvents)
      .values({
        id,
        type: "settings.changed",
        aggregateType: "settings",
        aggregateId: "k",
        payload: { key: "k" },
        occurredAt: "2026-11-05T12:00:00.000Z",
      })
      .run();
  }
  const consumption = (consumer: string, eventId: string, status: string) =>
    db
      .insert(schema.eventConsumptions)
      .values({ id: `${consumer}-${eventId}`, consumer, eventId, status })
      .run();
  consumption("a", "e1", "done");
  consumption("a", "e2", "pending");
  expect(await check()).toEqual({ status: "ok" });
  consumption("b", "e1", "failed");
  consumption("b", "e2", "failed");
  expect(await check()).toEqual({ status: "degraded", detail: "2 failed event consumption(s)" });
});

test("database check goes down when the last quick_check failed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "synapse-health-"));
  try {
    const { sqlite } = openDatabase(join(dir, "t.db"));
    const at = "2026-11-07T12:00:00.000Z";
    expect(await databaseCheck(sqlite, { last: () => ({ result: "failed", at }) })()).toEqual({
      status: "down",
      detail: "quick_check failed",
    });
    expect(await databaseCheck(sqlite, { last: () => ({ result: "ok", at }) })()).toEqual({
      status: "ok",
    });
    expect(await databaseCheck(sqlite, { last: () => null })()).toEqual({ status: "ok" });
    sqlite.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed quick_check is down even when the database is not in WAL mode", async () => {
  const { sqlite } = openDatabase(":memory:");
  const at = "2026-11-07T12:00:00.000Z";
  expect(await databaseCheck(sqlite, { last: () => ({ result: "failed", at }) })()).toEqual({
    status: "down",
    detail: "quick_check failed",
  });
});

test("sandbox check reports the missing binaries in order (F1.4)", async () => {
  const mk = (found: string[]) =>
    sandboxCheck({ settings, which: (b) => (found.includes(b) ? `/usr/bin/${b}` : null) });
  expect(await mk(["bwrap"])()).toEqual({ status: "degraded", detail: "missing: socat" });
  expect(await mk([])()).toEqual({ status: "degraded", detail: "missing: bwrap, socat" });
  expect(await mk(["bwrap", "socat"])()).toEqual({ status: "ok" });
  settings.set("engineering.sandbox.enabled", false);
  expect(await mk([])()).toEqual({ status: "ok", detail: "disabled" });
});

test("sandbox check reports a masked run root after the binaries (H4.6)", async () => {
  const both = (b: string) => `/usr/bin/${b}`;
  const mk = (which: (b: string) => string | null) =>
    sandboxCheck({ settings, which, runRootMasked: () => true });
  expect(await mk(both)()).toEqual({ status: "degraded", detail: "run_root_masked" });
  expect(await mk((b) => (b === "socat" ? null : both(b)))()).toEqual({
    status: "degraded",
    detail: "missing: socat",
  });
  settings.set("engineering.sandbox.enabled", false);
  expect(await mk(both)()).toEqual({ status: "ok", detail: "disabled" });
});

test("claude_settings check mirrors the orchestrator's refusal condition (F3.3)", async () => {
  const mk = (p: { widen?: boolean; servers?: string[] }) =>
    claudeSettingsCheck({
      provider: {
        userPermissionsWidenScope: p.widen ?? false,
        userAllowedConnectorServers: p.servers ?? [],
      },
      knownServers: () => ["mcp__claude_ai_Slack"],
    });
  expect(await mk({ widen: true })()).toEqual({
    status: "degraded",
    detail: "unsafe_user_settings",
  });
  expect(await mk({ servers: ["mcp__other"] })()).toEqual({
    status: "degraded",
    detail: "unsafe_user_settings",
  });
  expect(await mk({ servers: ["mcp__claude_ai_Slack"] })()).toEqual({ status: "ok" });
  expect(await mk({})()).toEqual({ status: "ok" });
});
