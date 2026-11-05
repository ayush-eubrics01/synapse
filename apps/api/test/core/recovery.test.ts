import { beforeEach, expect, test } from "bun:test";
import { openDatabase, runMigrations, schema } from "@synapse/database";
import { FakeClock } from "@synapse/shared";
import { eq } from "drizzle-orm";
import { AuditLogger } from "../../src/core/audit/audit";
import { JobQueue } from "../../src/core/jobs/queue";
import { LeaseService } from "../../src/core/leases/leases";
import { reapExpiredJobs, recoverOnStartup } from "../../src/core/recovery/recovery";

let db: ReturnType<typeof openDatabase>["db"];
let clock: FakeClock;
let q: JobQueue;
let leases: LeaseService;
let audit: AuditLogger;

beforeEach(() => {
  db = openDatabase(":memory:").db;
  runMigrations(db);
  clock = new FakeClock("2026-11-05T12:00:00.000Z");
  q = new JobQueue(db, clock);
  leases = new LeaseService(db, clock);
  audit = new AuditLogger(clock);
});

function running(
  key: string,
  input?: unknown,
  leaseMs = 1000,
  extra: { externalWrite?: boolean; concurrencyGroup?: string; maxAttempts?: number } = {},
): string {
  const { id } = q.enqueue(db, { type: "t", idempotencyKey: key, input, ...extra });
  const claimed = q.claim(`w-${key}`, leaseMs, ["t"]);
  if (claimed?.id !== id) throw new Error(`expected to claim ${key}`);
  return id;
}

function attemptRows(jobId: string) {
  return db.select().from(schema.jobAttempts).where(eq(schema.jobAttempts.jobId, jobId)).all();
}

test("recovers expired running jobs, leaves live ones, prunes leases", () => {
  const retry = running("a");
  const external = running("b", { externalWrite: true });
  const live = running("c", undefined, 60_000);
  leases.acquire("x", "h", 1000);
  leases.acquire("engineering", "h", 1000);
  leases.acquire("live", "h", 60_000);
  clock.advance(5000);

  const res = recoverOnStartup({ db, clock, leases, audit });
  expect(res).toEqual({ requeued: 1, needsAttention: 1, leasesReleased: 1 });

  const r = q.get(retry);
  expect(r?.status).toBe("RETRY");
  expect(r?.attempts).toBe(1);
  expect(r?.leaseOwner).toBeNull();
  expect(r?.leaseExpiresAt).toBeNull();
  expect(r?.runAfter).toBe("2026-11-05T12:00:05.000Z");
  const e = q.get(external);
  expect(e?.status).toBe("NEEDS_ATTENTION");
  expect(e?.lastError).toEqual({
    kind: "unknown",
    message: "verify external outcome before retry",
  });
  expect(q.get(live)?.status).toBe("RUNNING");

  const attempts = attemptRows(retry);
  expect(attempts[0]?.status).toBe("interrupted");
  expect(attempts[0]?.finishedAt).toBe("2026-11-05T12:00:05.000Z");
  const extAttempts = attemptRows(external);
  expect(extAttempts).toHaveLength(1);
  expect(extAttempts[0]?.status).toBe("interrupted");
  expect(extAttempts[0]?.finishedAt).toBe("2026-11-05T12:00:05.000Z");
  expect(attemptRows(live)[0]?.status).toBe("running");

  expect(leases.get("x")).toBeNull();
  expect(leases.get("engineering")).not.toBeNull();
  expect(leases.get("live")).not.toBeNull();

  const rows = db.select().from(schema.auditEvents).all();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.module).toBe("recovery");
  expect(rows[0]?.action).toBe("startup_recovery");
  expect(rows[0]?.details).toEqual(res);
});

test("startup recovery with nothing to do still audits zero counts", () => {
  const res = recoverOnStartup({ db, clock, leases, audit });
  expect(res).toEqual({ requeued: 0, needsAttention: 0, leasesReleased: 0 });
  const rows = db.select().from(schema.auditEvents).all();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.action).toBe("startup_recovery");
  expect(rows[0]?.details).toEqual({ requeued: 0, needsAttention: 0, leasesReleased: 0 });
});

test("startup recovery parks a job interrupted at max attempts instead of looping", () => {
  const id = running("max", undefined, 1000, { maxAttempts: 1 });
  clock.advance(5000);
  expect(recoverOnStartup({ db, clock, leases, audit })).toEqual({
    requeued: 0,
    needsAttention: 1,
    leasesReleased: 0,
  });
  expect(q.get(id)).toMatchObject({
    status: "NEEDS_ATTENTION",
    attempts: 1,
    leaseOwner: null,
    finishedAt: "2026-11-05T12:00:05.000Z",
    lastError: { kind: "unknown", message: "interrupted after max attempts" },
  });
  expect(attemptRows(id)[0]?.status).toBe("interrupted");
});

test("reaper reclaims an unexpired RUNNING job of a dead owner once its lease expires", () => {
  const id = running("dead", undefined, 60_000);
  expect(reapExpiredJobs({ db, clock, audit })).toEqual({ requeued: 0, needsAttention: 0 });
  expect(q.get(id)?.status).toBe("RUNNING");
  clock.advance(59_999);
  expect(reapExpiredJobs({ db, clock, audit })).toEqual({ requeued: 0, needsAttention: 0 });
  expect(q.get(id)?.status).toBe("RUNNING");
  expect(db.select().from(schema.auditEvents).all()).toHaveLength(0);

  clock.advance(1);
  expect(reapExpiredJobs({ db, clock, audit })).toEqual({ requeued: 1, needsAttention: 0 });
  expect(q.get(id)).toMatchObject({
    status: "RETRY",
    attempts: 1,
    leaseOwner: null,
    leaseExpiresAt: null,
    runAfter: "2026-11-05T12:01:00.000Z",
  });
  expect(attemptRows(id)[0]?.status).toBe("interrupted");
  const rows = db.select().from(schema.auditEvents).all();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.action).toBe("reap_expired_jobs");
  expect(rows[0]?.details).toEqual({ requeued: 1, needsAttention: 0 });

  // A resumed original worker no longer owns the job; the next claim runs it again.
  expect(q.heartbeat(id, "w-dead", 60_000)).toBe(false);
  expect(q.complete(id, "w-dead", "late")).toBe(false);
  expect(q.claim("w-new", 60_000, ["t"])?.id).toBe(id);
  expect(q.get(id)?.attempts).toBe(2);
});

test("an orphaned grouped job stops blocking its group after reaping", () => {
  const orphan = running("orphan", undefined, 60_000, { concurrencyGroup: "engineering" });
  const next = q.enqueue(db, {
    type: "t",
    idempotencyKey: "next",
    concurrencyGroup: "engineering",
  }).id;
  expect(q.claim("w2", 60_000, ["t"])).toBeNull();
  clock.advance(60_000);
  expect(q.claim("w2", 60_000, ["t"])).toBeNull();
  reapExpiredJobs({ db, clock, audit });
  const claimed = q.claim("w2", 60_000, ["t"]);
  expect(claimed).not.toBeNull();
  expect([orphan, next]).toContain(claimed?.id ?? "");
  expect(q.claim("w3", 60_000, ["t"])).toBeNull();
});

test("reaper parks external-write and max-attempt jobs in NEEDS_ATTENTION", () => {
  const ext = running("ext", undefined, 1000, { externalWrite: true });
  const legacy = running("legacy", { externalWrite: true });
  const max = running("max", undefined, 1000, { maxAttempts: 1 });
  const plain = running("plain");
  clock.advance(1000);
  expect(reapExpiredJobs({ db, clock, audit })).toEqual({ requeued: 1, needsAttention: 3 });
  const verify = { kind: "unknown", message: "verify external outcome before retry" };
  expect(q.get(ext)).toMatchObject({ status: "NEEDS_ATTENTION", lastError: verify });
  expect(q.get(legacy)).toMatchObject({ status: "NEEDS_ATTENTION", lastError: verify });
  expect(q.get(max)).toMatchObject({
    status: "NEEDS_ATTENTION",
    lastError: { kind: "unknown", message: "interrupted after max attempts" },
  });
  expect(q.get(plain)?.status).toBe("RETRY");
  for (const id of [ext, legacy, max, plain]) {
    expect(attemptRows(id)[0]?.status).toBe("interrupted");
  }
});
