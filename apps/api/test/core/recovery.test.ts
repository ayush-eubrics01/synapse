import { beforeEach, expect, test } from "bun:test";
import { openDatabase, runMigrations, schema } from "@synapse/database";
import { FakeClock } from "@synapse/shared";
import { eq } from "drizzle-orm";
import { AuditLogger } from "../../src/core/audit/audit";
import { JobQueue } from "../../src/core/jobs/queue";
import { LeaseService } from "../../src/core/leases/leases";
import { recoverOnStartup } from "../../src/core/recovery/recovery";

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

function running(key: string, input?: unknown, leaseMs = 1000): string {
  const { id } = q.enqueue(db, { type: "t", idempotencyKey: key, input });
  q.claim(`w-${key}`, leaseMs, ["t"]);
  return id;
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

  const attempts = db
    .select()
    .from(schema.jobAttempts)
    .where(eq(schema.jobAttempts.jobId, retry))
    .all();
  expect(attempts[0]?.status).toBe("interrupted");
  expect(attempts[0]?.finishedAt).toBe("2026-11-05T12:00:05.000Z");

  expect(leases.get("x")).toBeNull();
  expect(leases.get("engineering")).not.toBeNull();
  expect(leases.get("live")).not.toBeNull();

  const rows = db.select().from(schema.auditEvents).all();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.module).toBe("recovery");
  expect(rows[0]?.action).toBe("startup_recovery");
  expect(rows[0]?.details).toEqual(res);
});
