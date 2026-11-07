import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobError, retryDecision } from "@synapse/contracts";
import { type Db, openDatabase, runMigrations, schema } from "@synapse/database";
import { FakeClock } from "@synapse/shared";
import { eq } from "drizzle-orm";
import { AuditLogger } from "../../src/core/audit/audit";
import { SettingsService } from "../../src/core/config/settings";
import { JobQueue } from "../../src/core/jobs/queue";
import type { HandlerRegistration } from "../../src/core/jobs/worker";
import { BackupService } from "../../src/core/ops/backup";
import { DatabaseIntegrity } from "../../src/core/ops/integrity";
import { RetentionService } from "../../src/core/ops/retention";
import { SchedulerService } from "../../src/core/scheduler/scheduler";
import {
  backupJobLive,
  OPS_BACKUP_JOB,
  OPS_RETENTION_JOB,
  registerOpsJobs,
  runBackupTick,
} from "../../src/workers/ops";

let root: string;
let db: Db;
let sqlite: Database;
let clock: FakeClock;
let settings: SettingsService;
let free: number;
let at = { date: "2026-11-07", hour: 2 };

const deps = () => {
  const backup = new BackupService({
    db,
    sqlite,
    clock,
    audit: new AuditLogger(clock),
    dir: join(root, "backups"),
    dbPath: join(root, "synapse.db"),
    diskFree: () => free,
    fileName: () => "synapse-20261107-030000.db",
  });
  const queue = new JobQueue(db, clock);
  return {
    db,
    handlers: new Map<string, HandlerRegistration>(),
    scheduler: new SchedulerService(db, clock, queue),
    queue,
    settings,
    clock,
    backup,
    retention: new RetentionService({
      db,
      sqlite,
      clock,
      settings,
      audit: new AuditLogger(clock),
      integrity: new DatabaseIntegrity(sqlite, clock),
    }),
    localTime: () => at,
  };
};
const files = () => {
  try {
    return readdirSync(join(root, "backups"));
  } catch {
    return [];
  }
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "syn-"));
  const o = openDatabase(join(root, "synapse.db"));
  db = o.db;
  sqlite = o.sqlite;
  runMigrations(db);
  clock = new FakeClock(new Date("2026-11-07T03:00:00.000Z"));
  settings = new SettingsService(db, clock, () => "");
  free = 100 * 2 ** 30;
  at = { date: "2026-11-07", hour: 2 };
});
afterEach(() => {
  sqlite.close();
  rmSync(root, { recursive: true, force: true });
});

test("tick before the hour is not_due and writes nothing", async () => {
  expect(await runBackupTick(deps())).toEqual({ skipped: "not_due" });
  expect(files()).toEqual([]);
});

test("tick at the hour backs up and records the date; later ticks are done_today", async () => {
  at = { date: "2026-11-07", hour: 3 };
  const r = await runBackupTick(deps());
  expect(r).toMatchObject({ date: "2026-11-07", backup: { ok: true } });
  expect(settings.get("ops.backup.lastRunDate")).toBe("2026-11-07");
  at = { date: "2026-11-07", hour: 3 };
  expect(await runBackupTick(deps())).toEqual({ skipped: "done_today" });
  // a fresh registration (restart) reads the stored date
  const d = deps();
  registerOpsJobs(d);
  expect(await runBackupTick(d)).toEqual({ skipped: "done_today" });
});

test("disabled: no file, date still recorded", async () => {
  settings.set("ops.backup.enabled", false);
  at = { date: "2026-11-07", hour: 4 };
  expect(await runBackupTick(deps())).toEqual({ date: "2026-11-07", backup: "disabled" });
  expect(files()).toEqual([]);
  expect(settings.get("ops.backup.lastRunDate")).toBe("2026-11-07");
});

test("a failed backup still records the date (no retry every tick)", async () => {
  free = 1;
  at = { date: "2026-11-07", hour: 4 };
  expect(await runBackupTick(deps())).toEqual({
    date: "2026-11-07",
    backup: { ok: false, failure: "insufficient_space" },
  });
  expect(settings.get("ops.backup.lastRunDate")).toBe("2026-11-07");
});

test("a failed backup ends the job as a fixed-code non-retryable error", async () => {
  free = 1;
  const d = deps();
  registerOpsJobs(d);
  const h = d.handlers.get(OPS_BACKUP_JOB)?.handler;
  const caught = async (input: unknown) => {
    try {
      await h?.({ input } as never, {} as never);
    } catch (e) {
      return e;
    }
    return null;
  };
  const manual = (await caught({ manual: true })) as JobError;
  expect(manual).toBeInstanceOf(JobError);
  expect(manual.classified.message).toBe("backup_failed:insufficient_space");
  expect(retryDecision(manual.classified.kind)).toBe("fail");
  at = { date: "2026-11-07", hour: 4 };
  const sched = (await caught(null)) as JobError;
  expect(sched).toBeInstanceOf(JobError);
  expect(settings.get("ops.backup.lastRunDate")).toBe("2026-11-07");
  expect(await caught(null)).toBeNull(); // done_today: no retry loop
});

test("registerOpsJobs registers handler and schedule; manual runs even when disabled", async () => {
  settings.set("ops.backup.enabled", false);
  const d = deps();
  registerOpsJobs(d);
  const reg = d.handlers.get(OPS_BACKUP_JOB);
  expect(reg?.timeoutMs).toBe(660_000);
  const manual = (await reg?.handler({ input: { manual: true } } as never, {} as never)) as {
    ok: boolean;
  };
  expect(manual.ok).toBe(true);
  expect(files()).toHaveLength(1);
  const sched = sqlite.query("select name, interval_seconds from scheduled_tasks").all();
  expect(sched).toContainEqual({ name: OPS_BACKUP_JOB, interval_seconds: 900 });
  // scheduled input with disabled setting does nothing
  at = { date: "2026-11-07", hour: 5 };
  const sch = await reg?.handler({ input: null } as never, {} as never);
  expect(sch).toMatchObject({ backup: "disabled" });
});

test("backupJobLive sees pending manual jobs only", () => {
  const d = deps();
  expect(backupJobLive(db)).toBe(false);
  d.queue.enqueue(db, { type: OPS_BACKUP_JOB, input: null, idempotencyKey: "sched" });
  expect(backupJobLive(db)).toBe(false);
  d.queue.enqueue(db, { type: OPS_BACKUP_JOB, input: { manual: true }, idempotencyKey: "m1" });
  expect(backupJobLive(db)).toBe(true);
});

test("the backup tick enqueues ops.retention for the date, even when backup is disabled", async () => {
  at = { date: "2026-11-07", hour: 3 };
  const d = deps();
  await runBackupTick(d);
  const job = (key: string) =>
    db.select().from(schema.jobs).where(eq(schema.jobs.idempotencyKey, key)).get();
  expect(job("ops.retention:2026-11-07")?.type).toBe(OPS_RETENTION_JOB);
  expect(job("ops.retention:2026-11-07")?.input).toEqual({ date: "2026-11-07" });

  settings.set("ops.backup.enabled", false);
  at = { date: "2026-11-08", hour: 4 };
  await runBackupTick(d);
  expect(job("ops.retention:2026-11-08")).toBeDefined();
});

test("the retention handler runs once per date", async () => {
  const d = deps();
  const retention = new RetentionService({
    db,
    sqlite,
    clock,
    settings,
    audit: new AuditLogger(clock),
    integrity: new DatabaseIntegrity(sqlite, clock),
    yieldFn: async () => {},
  });
  registerOpsJobs({ ...d, retention });
  const h = d.handlers.get(OPS_RETENTION_JOB);
  expect(h?.timeoutMs).toBe(600_000);
  const first = await h?.handler({ input: { date: "2026-11-07" } } as never, {} as never);
  expect(first).toMatchObject({ date: "2026-11-07", quickCheck: "ok" });
  expect(await h?.handler({ input: { date: "2026-11-07" } } as never, {} as never)).toEqual({
    skipped: "done_today",
  });
});

test("the retention handler rejects bad input with a fixed-code non-retryable error", async () => {
  const d = deps();
  registerOpsJobs(d);
  const h = d.handlers.get(OPS_RETENTION_JOB)?.handler;
  for (const input of [null, {}, { date: 5 }, { date: "yesterday" }]) {
    let caught: unknown = null;
    try {
      await h?.({ input } as never, { signal: new AbortController().signal } as never);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(JobError);
    const err = caught as JobError;
    expect(err.classified.message).toBe("retention_bad_input");
    expect(retryDecision(err.classified.kind)).toBe("fail");
  }
});
