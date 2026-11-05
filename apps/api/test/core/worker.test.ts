import { afterEach, beforeEach, expect, test } from "bun:test";
import { type Job, JobError } from "@synapse/contracts";
import { openDatabase, runMigrations, schema } from "@synapse/database";
import { FakeClock } from "@synapse/shared";
import { eq } from "drizzle-orm";
import { JobQueue } from "../../src/core/jobs/queue";
import { type HandlerRegistration, type JobHandler, JobWorker } from "../../src/core/jobs/worker";

let db: ReturnType<typeof openDatabase>["db"];
let q: JobQueue;
const unhandled: unknown[] = [];
const onUnhandled = (e: unknown) => unhandled.push(e);

beforeEach(() => {
  db = openDatabase(":memory:").db;
  runMigrations(db);
  q = new JobQueue(db, new FakeClock("2026-11-05T12:00:00.000Z"), { random: () => 0.5 });
  process.on("unhandledRejection", onUnhandled);
});

afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
  expect(unhandled).toEqual([]);
});

function reg(handler: JobHandler, timeoutMs = 1_000): Map<string, HandlerRegistration> {
  return new Map([["t", { handler, timeoutMs }]]);
}

function mk(handlers: Map<string, HandlerRegistration>, id = "w1", extra = {}) {
  return new JobWorker(q, handlers, { workerId: id, ...extra });
}

function enqueue(type = "t", key = "k") {
  return q.enqueue(db, { type, idempotencyKey: key }).id;
}

function status(id: string): Job {
  const j = q.get(id);
  if (!j) throw new Error("missing job");
  return j;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("success completes with output", async () => {
  const id = enqueue();
  expect(await mk(reg(async () => ({ ok: 1 }))).runOnce()).toBe(true);
  expect(status(id).status).toBe("COMPLETED");
  expect(await mk(reg(async () => 1)).runOnce()).toBe(false);
});

test("JobError(auth_failed) -> NEEDS_ATTENTION", async () => {
  const id = enqueue();
  await mk(
    reg(async () => {
      throw new JobError({ kind: "auth_failed", message: "no" });
    }),
  ).runOnce();
  expect(status(id).status).toBe("NEEDS_ATTENTION");
  expect(status(id).lastError?.kind).toBe("auth_failed");
});

test("plain Error -> RETRY as unknown", async () => {
  const id = enqueue();
  await mk(
    reg(async () => {
      throw new Error("boom");
    }),
  ).runOnce();
  expect(status(id).status).toBe("RETRY");
  expect(status(id).lastError?.kind).toBe("unknown");
});

test("timeout aborts signal, records timeout and runOnce resolves even if handler hangs", async () => {
  const id = enqueue();
  let signal: AbortSignal | undefined;
  const handler: JobHandler = (_j, ctx) => {
    signal = ctx.signal;
    return new Promise(() => {});
  };
  await mk(reg(handler, 50)).runOnce();
  expect(signal?.aborted).toBe(true);
  expect(status(id).status).toBe("RETRY");
  expect(status(id).lastError?.kind).toBe("timeout");
});

test("lost lease aborts signal and old worker does not complete the job", async () => {
  const id = enqueue();
  let signal: AbortSignal | undefined;
  const handler: JobHandler = async (_j, ctx) => {
    signal = ctx.signal;
    db.update(schema.jobs).set({ leaseOwner: "thief" }).where(eq(schema.jobs.id, id)).run();
    await sleep(60);
    return "late";
  };
  await mk(reg(handler), "w1", { heartbeatMs: 10 }).runOnce();
  expect(signal?.aborted).toBe(true);
  expect(status(id).leaseOwner).toBe("thief");
  await sleep(70);
  expect(status(id).status).toBe("RUNNING");
});

test("stop waits for in-flight handler within grace", async () => {
  const id = enqueue();
  const w = mk(
    reg(async () => {
      await sleep(30);
      return "ok";
    }),
    "w1",
    { pollMs: 5 },
  );
  w.start();
  await sleep(15);
  await w.stop(500);
  expect(status(id).status).toBe("COMPLETED");
});

test("stop aborts handlers that exceed grace and records timeout", async () => {
  const id = enqueue();
  let signal: AbortSignal | undefined;
  const w = mk(
    reg((_j, ctx) => {
      signal = ctx.signal;
      return new Promise(() => {});
    }),
    "w1",
    { pollMs: 5 },
  );
  w.start();
  await sleep(15);
  await w.stop(30);
  expect(signal?.aborted).toBe(true);
  expect(status(id).status).toBe("RETRY");
  expect(status(id).lastError?.kind).toBe("timeout");
});

test("job types without a handler are never claimed", async () => {
  const id = enqueue("other");
  expect(await mk(reg(async () => 1)).runOnce()).toBe(false);
  expect(status(id).status).toBe("PENDING");
});

test("queue errors do not crash the loop", async () => {
  enqueue();
  const w = mk(
    reg(async () => 1),
    "w1",
    { pollMs: 5 },
  );
  const real = q.claim.bind(q);
  let calls = 0;
  q.claim = (...a) => {
    if (calls++ === 0) throw new Error("db closed");
    return real(...a);
  };
  w.start();
  await sleep(40);
  await w.stop(100);
  expect(calls).toBeGreaterThan(1);
});
