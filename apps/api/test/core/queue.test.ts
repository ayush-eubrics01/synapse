import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDatabase, runMigrations, schema } from "@synapse/database";
import { FakeClock } from "@synapse/shared";
import { eq } from "drizzle-orm";
import { JobQueue } from "../../src/core/jobs/queue";

let db: ReturnType<typeof openDatabase>["db"];
let clock: FakeClock;
let q: JobQueue;

function must<T>(v: T | null): T {
  if (v === null) throw new Error("expected non-null");
  return v;
}

/** Claims the next job as `worker` and returns its per-claim owner token. */
function claimOwner(worker = "w"): string {
  const owner = must(q.claim(worker, 60_000, ["t"])).leaseOwner;
  if (owner === null) throw new Error("claim returned no owner");
  return owner;
}

beforeEach(() => {
  db = openDatabase(":memory:").db;
  runMigrations(db);
  clock = new FakeClock("2026-11-05T12:00:00.000Z");
  q = new JobQueue(db, clock, { random: () => 0.5 });
});

test("idempotent enqueue", () => {
  const a = q.enqueue(db, { type: "t", idempotencyKey: "k" });
  const b = q.enqueue(db, { type: "t", idempotencyKey: "k" });
  expect(a.created).toBe(true);
  expect(b).toEqual({ id: a.id, created: false });
});

test("claim respects priority, run_after and types", () => {
  q.enqueue(db, { type: "t", idempotencyKey: "low", priority: 10 });
  const high = q.enqueue(db, { type: "t", idempotencyKey: "high", priority: 200 });
  q.enqueue(db, {
    type: "t",
    idempotencyKey: "future",
    priority: 500,
    runAfter: "2026-11-06T00:00:00.000Z",
  });
  q.enqueue(db, { type: "other", idempotencyKey: "other", priority: 900 });
  const j = must(q.claim("w", 60_000, ["t"]));
  expect(j.id).toBe(high.id);
  expect(j.status).toBe("RUNNING");
  expect(j.attempts).toBe(1);
  expect(j.leaseOwner).toMatch(/^w:.+/);
  expect(j.leaseExpiresAt).toBe("2026-11-05T12:01:00.000Z");
  const attempts = db
    .select()
    .from(schema.jobAttempts)
    .where(eq(schema.jobAttempts.jobId, j.id))
    .all();
  expect(attempts).toHaveLength(1);
  expect(attempts[0]?.status).toBe("running");
});

test("complete stores output and closes attempt; foreign worker is a no-op", () => {
  const { id } = q.enqueue(db, { type: "t", idempotencyKey: "k" });
  const owner = claimOwner();
  expect(q.complete(id, "other", 1)).toBe(false);
  expect(q.complete(id, owner, { ok: 1 })).toBe(true);
  expect(q.get(id)?.status).toBe("COMPLETED");
  const row = db.select().from(schema.jobs).where(eq(schema.jobs.id, id)).get();
  expect(row?.output).toEqual({ ok: 1 });
  const att = db.select().from(schema.jobAttempts).where(eq(schema.jobAttempts.jobId, id)).get();
  expect(att?.status).toBe("completed");
  expect(att?.finishedAt).not.toBeNull();
  expect(q.complete(id, owner)).toBe(false);
});

test("transient failure retries with backoff then needs attention after 3 attempts", () => {
  q.enqueue(db, { type: "t", idempotencyKey: "k" });
  for (const expected of ["RETRY", "RETRY", "NEEDS_ATTENTION"]) {
    clock.advance(31 * 60_000);
    const j = must(q.claim("w", 60_000, ["t"]));
    expect(q.fail(j.id, must(j.leaseOwner), { kind: "transient_network", message: "x" })).toBe(
      expected as never,
    );
  }
});

test("retry run_after uses backoff and retryAfter override", () => {
  const { id } = q.enqueue(db, { type: "t", idempotencyKey: "k" });
  q.fail(id, claimOwner(), { kind: "transient_network", message: "x" });
  expect(q.get(id)?.runAfter).toBe("2026-11-05T12:00:30.000Z");
  clock.advance(60_000);
  q.fail(id, claimOwner(), {
    kind: "rate_limited",
    message: "x",
    retryAfter: "2026-11-05T13:00:00.000Z",
  });
  expect(q.get(id)?.runAfter).toBe("2026-11-05T13:00:00.000Z");
});

test("auth_failed goes straight to NEEDS_ATTENTION; invalid_input to FAILED", () => {
  q.enqueue(db, { type: "t", idempotencyKey: "a" });
  const a = must(q.claim("w", 60_000, ["t"]));
  expect(q.fail(a.id, must(a.leaseOwner), { kind: "auth_failed", message: "x" })).toBe(
    "NEEDS_ATTENTION",
  );
  q.enqueue(db, { type: "t", idempotencyKey: "b" });
  const b = must(q.claim("w", 60_000, ["t"]));
  expect(q.fail(b.id, must(b.leaseOwner), { kind: "invalid_input", message: "x" })).toBe("FAILED");
  expect(q.get(b.id)?.finishedAt).not.toBeNull();
});

test("quota_exhausted defers without consuming an attempt", () => {
  q.enqueue(db, { type: "t", idempotencyKey: "k" });
  const j = must(q.claim("w", 60_000, ["t"]));
  q.fail(j.id, must(j.leaseOwner), {
    kind: "quota_exhausted",
    message: "x",
    retryAfter: "2026-11-05T15:00:00.000Z",
  });
  const after = must(q.get(j.id));
  expect(after.status).toBe("PENDING");
  expect(after.attempts).toBe(0);
  expect(after.runAfter).toBe("2026-11-05T15:00:00.000Z");
  const att = db.select().from(schema.jobAttempts).where(eq(schema.jobAttempts.jobId, j.id)).get();
  expect(att?.status).toBe("deferred");
});

test("quota_exhausted without retryAfter defers 15 minutes", () => {
  q.enqueue(db, { type: "t", idempotencyKey: "k" });
  const j = must(q.claim("w", 60_000, ["t"]));
  expect(q.fail(j.id, must(j.leaseOwner), { kind: "quota_exhausted", message: "x" })).toBe(
    "PENDING",
  );
  expect(q.get(j.id)?.runAfter).toBe("2026-11-05T12:15:00.000Z");
});

test("fail by non-owner returns current status unchanged", () => {
  const { id } = q.enqueue(db, { type: "t", idempotencyKey: "k" });
  claimOwner();
  expect(q.fail(id, "x", { kind: "invalid_input", message: "m" })).toBe("RUNNING");
  expect(q.get(id)?.status).toBe("RUNNING");
});

test("only one RUNNING job per concurrency group", () => {
  q.enqueue(db, { type: "t", idempotencyKey: "a", concurrencyGroup: "engineering" });
  q.enqueue(db, { type: "t", idempotencyKey: "b", concurrencyGroup: "engineering" });
  expect(q.claim("w1", 60_000, ["t"])).not.toBeNull();
  expect(q.claim("w2", 60_000, ["t"])).toBeNull();
});

test("heartbeat extends lease and fails for a stolen lease", () => {
  const { id } = q.enqueue(db, { type: "t", idempotencyKey: "k" });
  const w1 = claimOwner("w1");
  clock.advance(10_000);
  expect(q.heartbeat(id, w1, 60_000)).toBe(true);
  expect(q.get(id)?.leaseExpiresAt).toBe("2026-11-05T12:01:10.000Z");
  // lease expires, recovery puts the job back, another worker claims it
  db.update(schema.jobs)
    .set({ status: "PENDING", leaseOwner: null })
    .where(eq(schema.jobs.id, id))
    .run();
  const w2 = claimOwner("w2");
  expect(q.heartbeat(id, w1, 60_000)).toBe(false);
  expect(q.heartbeat(id, w2, 60_000)).toBe(true);
});

test("explicit defer, cancel and list", () => {
  const a = q.enqueue(db, { type: "t", idempotencyKey: "a" });
  const b = q.enqueue(db, { type: "t", idempotencyKey: "b" });
  q.defer(a.id, claimOwner(), "2026-11-05T20:00:00.000Z");
  expect(q.get(a.id)).toMatchObject({
    status: "PENDING",
    attempts: 0,
    runAfter: "2026-11-05T20:00:00.000Z",
  });
  expect(q.cancel(a.id)).toBe(true);
  expect(q.cancel(a.id)).toBe(false);
  expect(q.list({ status: "CANCELLED" }).map((j) => j.id)).toEqual([a.id]);
  expect(q.list({}).length).toBe(2);
  expect(q.get(b.id)).not.toBeNull();
  expect(q.get("nope")).toBeNull();
});

test("checkpoint round-trips", () => {
  const { id } = q.enqueue(db, { type: "t", idempotencyKey: "k" });
  expect(q.getCheckpoint(id)).toBeUndefined();
  const owner = claimOwner();
  q.checkpoint(id, owner, { step: 1 });
  q.checkpoint(id, owner, { step: 2 });
  expect(q.getCheckpoint<{ step: number }>(id)).toEqual({ step: 2 });
});

test("fail waits for another connection's commit instead of throwing SQLITE_BUSY_SNAPSHOT", async () => {
  const dir = mkdtempSync(join(tmpdir(), "synapse-busy-"));
  try {
    const dbPath = join(dir, "test.db");
    const a = openDatabase(dbPath);
    runMigrations(a.db);
    const qa = new JobQueue(a.db, clock);
    const { id } = qa.enqueue(a.db, { type: "t", idempotencyKey: "k" });
    const owner = must(qa.claim("w", 60_000, ["t"])).leaseOwner ?? "";
    const proc = Bun.spawn(["bun", "apps/api/test/fixtures/hold-lock.ts", dbPath], {
      cwd: resolve(import.meta.dir, "../../../.."),
      stdout: "pipe",
      stderr: "inherit",
    });
    const reader = proc.stdout.getReader();
    await reader.read(); // "locked": the other connection now holds the write lock
    expect(qa.fail(id, owner, { kind: "invalid_input", message: "x" })).toBe("FAILED");
    await proc.exited;
    a.sqlite.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("externalWrite is persisted at enqueue and defaults to false", () => {
  const ext = q.enqueue(db, { type: "t", idempotencyKey: "ext", externalWrite: true });
  const plain = q.enqueue(db, { type: "t", idempotencyKey: "plain" });
  expect(q.get(ext.id)?.externalWrite).toBe(true);
  expect(q.get(plain.id)?.externalWrite).toBe(false);
});

test("list orders newest first on request; default keeps claim order", () => {
  const older = q.enqueue(db, { type: "t", idempotencyKey: "older", priority: 10 });
  clock.advance(1000);
  const newer = q.enqueue(db, { type: "t", idempotencyKey: "newer", priority: 10 });
  clock.advance(1000);
  const urgent = q.enqueue(db, {
    type: "t",
    idempotencyKey: "urgent",
    priority: 500,
    runAfter: "2026-11-05T11:00:00.000Z",
  });
  expect(q.list({ order: "newest" }).map((j) => j.id)).toEqual([urgent.id, newer.id, older.id]);
  expect(q.list({ order: "newest", limit: 1 }).map((j) => j.id)).toEqual([urgent.id]);
  expect(q.list({}).map((j) => j.id)).toEqual([urgent.id, older.id, newer.id]);
});

test("failUncertain parks an owned job in NEEDS_ATTENTION and keeps the cause on the attempt", () => {
  const { id } = q.enqueue(db, { type: "t", idempotencyKey: "k", externalWrite: true });
  const owner = claimOwner();
  const cause = { kind: "timeout" as const, message: "timed out" };
  expect(q.failUncertain(id, "other", cause)).toBe("RUNNING");
  expect(q.failUncertain(id, owner, cause)).toBe("NEEDS_ATTENTION");
  const job = must(q.get(id));
  expect(job).toMatchObject({
    status: "NEEDS_ATTENTION",
    leaseOwner: null,
    leaseExpiresAt: null,
    finishedAt: "2026-11-05T12:00:00.000Z",
    lastError: { kind: "unknown", message: "verify external outcome before retry" },
  });
  const attempt = db
    .select()
    .from(schema.jobAttempts)
    .where(eq(schema.jobAttempts.jobId, id))
    .get();
  expect(attempt?.status).toBe("failed");
  expect(attempt?.error).toEqual(cause);
});

test("a stale owner token cannot act after the same worker re-claims the job (G1)", () => {
  const { id } = q.enqueue(db, { type: "t", idempotencyKey: "g1" });
  const t1 = claimOwner();
  clock.advance(60_000);
  db.update(schema.jobs)
    .set({ status: "RETRY", leaseOwner: null, leaseExpiresAt: null })
    .where(eq(schema.jobs.id, id))
    .run();
  const t2 = claimOwner();
  expect(t1).not.toBe(t2);
  expect(q.complete(id, t1)).toBe(false);
  expect(q.heartbeat(id, t1, 60_000)).toBe(false);
  expect(q.markExternalWrite(id, t1)).toBe(false);
  expect(q.complete(id, t2)).toBe(true);
});

test("markExternalWrite sets the flag only for the owner", () => {
  const { id } = q.enqueue(db, { type: "t", idempotencyKey: "mew" });
  const owner = claimOwner();
  expect(q.markExternalWrite(id, "w")).toBe(false);
  expect(q.get(id)?.externalWrite).toBe(false);
  expect(q.markExternalWrite(id, owner)).toBe(true);
  expect(q.get(id)?.externalWrite).toBe(true);
});
