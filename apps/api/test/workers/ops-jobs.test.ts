import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobError, retryDecision } from "@synapse/contracts";
import { type Db, openDatabase, runMigrations } from "@synapse/database";
import { FakeClock } from "@synapse/shared";
import { AuditLogger } from "../../src/core/audit/audit";
import { SettingsService } from "../../src/core/config/settings";
import { JobQueue } from "../../src/core/jobs/queue";
import type { HandlerRegistration } from "../../src/core/jobs/worker";
import { BackupService } from "../../src/core/ops/backup";
import { SchedulerService } from "../../src/core/scheduler/scheduler";
import {
  backupJobLive,
  OPS_BACKUP_JOB,
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

test("tick before the hour is not_due and writes nothing", () => {
  expect(runBackupTick(deps())).toEqual({ skipped: "not_due" });
  expect(files()).toEqual([]);
});

test("tick at the hour backs up and records the date; later ticks are done_today", () => {
  at = { date: "2026-11-07", hour: 3 };
  const r = runBackupTick(deps());
  expect(r).toMatchObject({ date: "2026-11-07", backup: { ok: true } });
  expect(settings.get("ops.backup.lastRunDate")).toBe("2026-11-07");
  at = { date: "2026-11-07", hour: 3 };
  expect(runBackupTick(deps())).toEqual({ skipped: "done_today" });
  // a fresh registration (restart) reads the stored date
  const d = deps();
  registerOpsJobs(d);
  expect(runBackupTick(d)).toEqual({ skipped: "done_today" });
});

test("disabled: no file, date still recorded", () => {
  settings.set("ops.backup.enabled", false);
  at = { date: "2026-11-07", hour: 4 };
  expect(runBackupTick(deps())).toEqual({ date: "2026-11-07", backup: "disabled" });
  expect(files()).toEqual([]);
  expect(settings.get("ops.backup.lastRunDate")).toBe("2026-11-07");
});

test("a failed backup still records the date (no retry every tick)", () => {
  free = 1;
  at = { date: "2026-11-07", hour: 4 };
  expect(runBackupTick(deps())).toEqual({
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
  expect(reg?.timeoutMs).toBe(600_000);
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
