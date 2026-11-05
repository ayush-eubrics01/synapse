import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
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

function reg(
  handler: JobHandler,
  timeoutMs = 1_000,
  extra: Partial<HandlerRegistration> = {},
): Map<string, HandlerRegistration> {
  return new Map([["t", { handler, timeoutMs, ...extra }]]);
}

function mk(handlers: Map<string, HandlerRegistration>, id = "w1", extra = {}) {
  return new JobWorker(q, handlers, { workerId: id, ...extra });
}

function enqueue(type = "t", key = "k", externalWrite?: boolean) {
  return q.enqueue(db, { type, idempotencyKey: key, externalWrite }).id;
}

function attempt(id: string) {
  return db.select().from(schema.jobAttempts).where(eq(schema.jobAttempts.jobId, id)).get();
}

const VERIFY = { kind: "unknown", message: "verify external outcome before retry" } as const;

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

test("queue errors do not crash the loop and claim failures are logged", async () => {
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
  const spy = spyOn(console, "error").mockImplementation(() => {});
  try {
    w.start();
    await sleep(40);
    await w.stop(100);
    expect(spy.mock.calls).toEqual([["worker: claim failed", "Error: db closed"]]);
  } finally {
    spy.mockRestore();
  }
  expect(calls).toBeGreaterThan(1);
});

test("complete and fail errors are logged with the job id only", async () => {
  const done = enqueue("t", "done");
  const spy = spyOn(console, "error").mockImplementation(() => {});
  q.complete = () => {
    throw new TypeError("db closed");
  };
  q.fail = () => {
    throw new Error("disk full");
  };
  try {
    await mk(reg(async () => ({ secret: "payload" }))).runOnce();
    const failed = enqueue("t", "failed");
    await mk(
      reg(async () => {
        throw new Error("handler said something private");
      }),
    ).runOnce();
    expect(spy.mock.calls).toEqual([
      ["worker: complete failed", done, "TypeError: db closed"],
      ["worker: fail failed", failed, "Error: disk full"],
    ]);
  } finally {
    spy.mockRestore();
  }
});

test("external-write handler timeout goes to NEEDS_ATTENTION, not RETRY", async () => {
  const id = enqueue();
  await mk(reg(() => new Promise(() => {}), 30, { externalWrite: true })).runOnce();
  expect(status(id).status).toBe("NEEDS_ATTENTION");
  expect(status(id).lastError).toEqual(VERIFY);
  expect(attempt(id)?.error).toMatchObject({ kind: "timeout" });
});

test("a job enqueued as externalWrite is honoured even if the handler does not declare it", async () => {
  const id = enqueue("t", "k", true);
  await mk(reg(() => new Promise(() => {}), 30)).runOnce();
  expect(status(id).status).toBe("NEEDS_ATTENTION");
  expect(status(id).lastError).toEqual(VERIFY);
});

test("external-write job force-stopped on shutdown goes to NEEDS_ATTENTION", async () => {
  const id = enqueue();
  const w = mk(
    reg(() => new Promise(() => {}), 5_000, { externalWrite: true }),
    "w1",
    { pollMs: 5 },
  );
  w.start();
  await sleep(15);
  await w.stop(20);
  expect(status(id).status).toBe("NEEDS_ATTENTION");
  expect(status(id).lastError).toEqual(VERIFY);
});

test("an external-write handler's own classified failure keeps normal retry rules", async () => {
  const id = enqueue();
  await mk(
    reg(
      async () => {
        throw new Error("rejected before sending");
      },
      1_000,
      { externalWrite: true },
    ),
  ).runOnce();
  expect(status(id).status).toBe("RETRY");
});

test("a worker whose lease expired without renewal treats the job as lost", async () => {
  const id = enqueue();
  let signal: AbortSignal | undefined;
  const handler: JobHandler = async (_j, ctx) => {
    signal = ctx.signal;
    await sleep(60);
    return "late";
  };
  await mk(reg(handler), "w1", { leaseMs: 30, heartbeatMs: 1_000 }).runOnce();
  expect(signal?.aborted).toBe(true);
  expect(status(id).status).toBe("RUNNING");
});

test("abandoned handler cannot write checkpoints after timeout", async () => {
  const id = enqueue();
  let late: unknown;
  const handler: JobHandler = async (_j, ctx) => {
    ctx.checkpoint("before");
    await sleep(80);
    try {
      ctx.checkpoint("after");
    } catch (e) {
      late = e;
    }
    return "ignored";
  };
  await mk(reg(handler, 30)).runOnce();
  await sleep(90);
  expect(q.getCheckpoint(id)).toBe("before");
  expect(late).toBeDefined();
});

test("handler rejecting with a null-prototype value is classified unknown without leaks", async () => {
  const id = enqueue();
  await mk(
    reg(() => Promise.reject(Object.create(null))),
    "w1",
    { heartbeatMs: 5 },
  ).runOnce();
  await sleep(20);
  expect(status(id).status).toBe("RETRY");
  expect(status(id).lastError?.kind).toBe("unknown");
});

test("onSettled reports id and status after complete, fail and timeout", async () => {
  const settled: unknown[] = [];
  const onSettled = (e: { id: string; status: string }) => settled.push(e);
  const done = enqueue("t", "done");
  await mk(
    reg(async () => "ok"),
    "w1",
    { onSettled },
  ).runOnce();
  const failed = enqueue("t", "failed");
  await mk(
    reg(async () => {
      throw new JobError({ kind: "invalid_input", message: "bad" });
    }),
    "w1",
    { onSettled },
  ).runOnce();
  const slow = enqueue("t", "slow");
  await mk(
    reg(() => new Promise(() => {}), 20),
    "w1",
    { onSettled },
  ).runOnce();
  expect(settled).toEqual([
    { id: done, status: "COMPLETED" },
    { id: failed, status: "FAILED" },
    { id: slow, status: "RETRY" },
  ]);
});
