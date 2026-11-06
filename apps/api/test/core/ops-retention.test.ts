import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, openDatabase, runMigrations } from "@synapse/database";
import { FakeClock } from "@synapse/shared";
import { AuditLogger } from "../../src/core/audit/audit";
import { SettingsService } from "../../src/core/config/settings";
import { DatabaseIntegrity } from "../../src/core/ops/integrity";
import { RetentionService } from "../../src/core/ops/retention";

const NOW = new Date("2026-11-07T12:00:00.000Z");
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

let root: string;
let db: Db;
let sqlite: Database;
let clock: FakeClock;
let settings: SettingsService;
let yields: number;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "syn-"));
  const o = openDatabase(join(root, "synapse.db"));
  db = o.db;
  sqlite = o.sqlite;
  runMigrations(db);
  clock = new FakeClock(NOW);
  settings = new SettingsService(db, clock, () => "");
  yields = 0;
});
afterEach(() => {
  sqlite.close();
  rmSync(root, { recursive: true, force: true });
});

const service = (batchSize?: number) =>
  new RetentionService({
    db,
    sqlite,
    clock,
    settings,
    audit: new AuditLogger(clock),
    integrity: new DatabaseIntegrity(sqlite, clock),
    batchSize,
    yieldFn: async () => {
      yields++;
    },
  });

let n = 0;
const uid = () => `id-${++n}`;
const count = (t: string) => (sqlite.query(`select count(*) c from ${t}`).get() as { c: number }).c;

function insertJob(status: string, days: number, id = uid()) {
  sqlite
    .query(
      `insert into jobs (id, type, status, idempotency_key, run_after, created_at, finished_at)
       values (?, 't', ?, ?, ?, ?, ?)`,
    )
    .run(id, status, `k-${id}`, ago(days), ago(days), ago(days));
  return id;
}
function insertAttempt(jobId: string) {
  sqlite
    .query(
      "insert into job_attempts (id, job_id, attempt, started_at, status) values (?, ?, 1, ?, 'ok')",
    )
    .run(uid(), jobId, ago(40));
  sqlite
    .query(
      "insert into job_checkpoints (id, job_id, checkpoint, updated_at) values (?, ?, '{}', ?)",
    )
    .run(uid(), jobId, ago(40));
}
function insertRun(opts: { days: number; error?: unknown; denials?: unknown; jobId?: string }) {
  const id = uid();
  sqlite
    .query(
      `insert into claude_runs (id, job_id, worker_profile, model, status, num_turns, duration_ms,
         input_tokens, output_tokens, cost_usd_equivalent, permission_denials, error, started_at)
       values (?, ?, 'p', 'haiku', 'completed', 3, 1234, 10, 20, 0.5, ?, ?, ?)`,
    )
    .run(
      id,
      opts.jobId ?? null,
      opts.denials === undefined ? null : JSON.stringify(opts.denials),
      opts.error === undefined ? null : JSON.stringify(opts.error),
      ago(opts.days),
    );
  return id;
}
function insertEvent(days: number, dispatched: boolean, consumptions: string[] = []) {
  const id = uid();
  sqlite
    .query(
      `insert into domain_events (id, type, aggregate_type, aggregate_id, payload, occurred_at, dispatched_at)
       values (?, 'x', 'a', 'a1', '{}', ?, ?)`,
    )
    .run(id, ago(days), dispatched ? ago(days) : null);
  for (const status of consumptions) {
    sqlite
      .query("insert into event_consumptions (id, consumer, event_id, status) values (?, ?, ?, ?)")
      .run(uid(), `c-${uid()}`, id, status);
  }
  return id;
}
function insertNotification(days: number, read: boolean) {
  sqlite
    .query(
      `insert into notifications (id, kind, severity, title, created_at, read_at)
       values (?, 'k', 'info', 't', ?, ?)`,
    )
    .run(uid(), ago(days), read ? ago(days) : null);
}
function insertAudit(days: number, action = "x") {
  sqlite
    .query(
      "insert into audit_events (id, actor, action, result, occurred_at) values (?, 'system', ?, 'ok', ?)",
    )
    .run(uid(), action, ago(days));
}

/** Minimal row for any table: fills NOT NULL columns without a default (foreign keys are off). */
function seedMinimal(table: string, overrides: Record<string, unknown> = {}) {
  const cols = sqlite.query(`pragma table_info(${table})`).all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }[];
  const values: Record<string, unknown> = {};
  for (const c of cols) {
    if (c.name in overrides) values[c.name] = overrides[c.name];
    else if (c.pk === 1 && c.name === "id") values[c.name] = uid();
    else if (c.notnull && c.dflt_value === null) {
      values[c.name] = /int|real|bool/i.test(c.type)
        ? 1
        : c.name.endsWith("_at") || c.name.endsWith("At")
          ? ago(400)
          : /json|text/i.test(c.type)
            ? "{}"
            : "x";
      if (c.name.endsWith("_at")) values[c.name] = ago(400);
    }
  }
  const names = Object.keys(values);
  sqlite
    .query(`insert into ${table} (${names.join(",")}) values (${names.map(() => "?").join(",")})`)
    .run(...(Object.values(values) as never[]));
}

test("jobs: terminal old jobs go with attempts and checkpoints, the run keeps its row unlinked", async () => {
  const done = ["COMPLETED", "CANCELLED", "FAILED"].map((s) => insertJob(s, 40));
  for (const id of done) insertAttempt(id);
  const runId = insertRun({ days: 10, jobId: done[0] });
  const kept = ["PENDING", "RUNNING", "RETRY", "NEEDS_ATTENTION"].map((s) => insertJob(s, 40));
  const young = insertJob("COMPLETED", 10);
  const r = await service().run("2026-11-07");
  expect(r.jobs).toBe(3);
  const ids = (sqlite.query("select id from jobs").all() as { id: string }[]).map((x) => x.id);
  expect(ids.sort()).toEqual([...kept, young].sort());
  expect(count("job_attempts")).toBe(0);
  expect(count("job_checkpoints")).toBe(0);
  expect(
    (sqlite.query("select job_id from claude_runs where id = ?").get(runId) as { job_id: null })
      .job_id,
  ).toBeNull();
});

test("batching: 1203 jobs with batch 500 are all deleted and the loop yields", async () => {
  sqlite.exec("begin");
  for (let i = 0; i < 1203; i++) insertJob("COMPLETED", 40);
  sqlite.exec("commit");
  const r = await service(500).run("2026-11-07");
  expect(r.jobs).toBe(1203);
  expect(count("jobs")).toBe(0);
  expect(yields).toBeGreaterThanOrEqual(2);
});

test("notifications: only old and read go", async () => {
  insertNotification(40, true);
  insertNotification(40, false);
  insertNotification(5, true);
  const r = await service().run("2026-11-07");
  expect(r.notifications).toBe(1);
  expect(count("notifications")).toBe(2);
});

test("events: only dispatched, old, with every consumption done", async () => {
  const gone = insertEvent(8, true, ["done", "done"]);
  const failed = insertEvent(8, true, ["done", "failed"]);
  const undispatched = insertEvent(8, false);
  const young = insertEvent(6, true, ["done"]);
  const r = await service().run("2026-11-07");
  expect(r.events).toBe(1);
  const left = (sqlite.query("select id from domain_events").all() as { id: string }[]).map(
    (x) => x.id,
  );
  expect(left.sort()).toEqual([failed, undispatched, young].sort());
  expect(left).not.toContain(gone);
  expect(count("event_consumptions")).toBe(3);
});

test("audit: older than auditDays goes", async () => {
  insertAudit(400);
  insertAudit(100);
  const r = await service().run("2026-11-07");
  // the retention run's own audit row is written after the count
  expect(r.audit).toBe(1);
  expect(count("audit_events")).toBe(2);
});

test("claude_runs are compacted, never deleted, and foreign keys stay valid", async () => {
  const old = insertRun({
    days: 100,
    error: { kind: "timeout", message: "SENTINEL-ROW-7f3a" },
    denials: ["Bash"],
  });
  const young = insertRun({
    days: 10,
    error: { kind: "timeout", message: "SENTINEL-ROW-7f3a" },
    denials: ["Bash"],
  });
  const noError = insertRun({ days: 100, denials: ["Bash"] });
  seedMinimal("security_flags", { claude_run_id: old });
  sqlite
    .query(
      "insert into job_attempts (id, job_id, attempt, started_at, status, claude_run_id) values (?, ?, 1, ?, 'ok', ?)",
    )
    .run(uid(), insertJob("PENDING", 1), ago(100), old);
  const before = sqlite.query("select * from claude_runs where id = ?").get(old) as Record<
    string,
    unknown
  >;
  const r = await service().run("2026-11-07");
  expect(r.claudeRunsCompacted).toBe(2);
  const after = sqlite.query("select * from claude_runs where id = ?").get(old) as Record<
    string,
    unknown
  >;
  expect(JSON.parse(after.error as string)).toEqual({ kind: "timeout" });
  expect(after.permission_denials).toBeNull();
  for (const k of [
    "status",
    "started_at",
    "finished_at",
    "duration_ms",
    "input_tokens",
    "output_tokens",
    "cost_usd_equivalent",
    "num_turns",
  ]) {
    expect(after[k]).toEqual(before[k]);
  }
  const y = sqlite
    .query("select error, permission_denials from claude_runs where id = ?")
    .get(young) as {
    error: string;
    permission_denials: string;
  };
  expect(y.error).toContain("SENTINEL-ROW-7f3a");
  expect(y.permission_denials).not.toBeNull();
  const ne = sqlite
    .query("select error, permission_denials from claude_runs where id = ?")
    .get(noError) as {
    error: null;
    permission_denials: null;
  };
  expect(ne.error).toBeNull();
  expect(ne.permission_denials).toBeNull();
  expect(count("claude_runs")).toBe(3);
  expect(sqlite.query("pragma foreign_key_check").all()).toEqual([]);
  // a second run has nothing left to compact
  expect((await service().run("2026-11-07")).claudeRunsCompacted).toBe(0);
});

test("protected tables are never touched and no foreign key breaks", async () => {
  const tables = [
    "approvals",
    "outgoing_messages",
    "auto_replies",
    "security_flags",
    "engineering_tasks",
    "commitments",
  ];
  sqlite.exec("pragma foreign_keys = off");
  for (const t of tables) seedMinimal(t);
  sqlite.exec("pragma foreign_keys = on");
  const before = tables.map((t) => count(t));
  expect(before.every((c) => c === 1)).toBe(true);
  insertJob("COMPLETED", 400);
  insertAudit(400);
  await service().run("2026-11-07");
  expect(tables.map((t) => count(t))).toEqual(before);
});

test("summary, setting and a counts-only audit row", async () => {
  insertJob("COMPLETED", 40);
  insertRun({ days: 100, error: { kind: "k", message: "SENTINEL-ROW-7f3a" }, denials: ["Bash"] });
  const r = await service().run("2026-11-07");
  expect(r).toEqual({
    at: NOW.toISOString(),
    date: "2026-11-07",
    jobs: 1,
    notifications: 0,
    events: 0,
    audit: 0,
    claudeRunsCompacted: 1,
    quickCheck: "ok",
  });
  expect(settings.get("ops.retention.lastRun")?.date).toBe("2026-11-07");
  const rows = sqlite
    .query("select details, result from audit_events where action = 'ops.retention_ran'")
    .all() as { details: string; result: string }[];
  expect(rows).toHaveLength(1);
  expect(rows[0]?.details).not.toContain("SENTINEL");
  expect(JSON.parse(rows[0]?.details ?? "{}")).toMatchObject({ jobs: 1, claudeRunsCompacted: 1 });
});

test("DatabaseIntegrity reports ok and remembers the last result", () => {
  const i = new DatabaseIntegrity(sqlite, clock);
  expect(i.last()).toBeNull();
  expect(i.check()).toBe("ok");
  expect(i.last()).toEqual({ result: "ok", at: NOW.toISOString() });
});

test("DatabaseIntegrity reports failed when quick_check does not return a single ok", () => {
  const stub = {
    query: () => ({ all: () => [{ quick_check: "row 1 missing from index" }] }),
  } as unknown as Database;
  const i = new DatabaseIntegrity(stub, clock);
  expect(i.check()).toBe("failed");
  expect(i.last()?.result).toBe("failed");
  const throwing = {
    query: () => {
      throw new Error("disk image is malformed");
    },
  } as unknown as Database;
  expect(new DatabaseIntegrity(throwing, clock).check()).toBe("failed");
});
