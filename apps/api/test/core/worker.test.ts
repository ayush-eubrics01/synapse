import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { type Job, JobError } from "@synapse/contracts";
import { openDatabase, runMigrations, schema } from "@synapse/database";
import { FakeClock } from "@synapse/shared";
import { eq } from "drizzle-orm";
import { AuditLogger } from "../../src/core/audit/audit";
import { JobQueue } from "../../src/core/jobs/queue";
import { type HandlerRegistration, type JobHandler, JobWorker } from "../../src/core/jobs/worker";
import { reapExpiredJobs } from "../../src/core/recovery/recovery";

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

test("a function timeoutMs is read when the job starts, and the message names that value", async () => {
  const id = enqueue();
  let current = 10_000;
  const handlers = reg(() => new Promise(() => {}), 1_000);
  handlers.set("t", { handler: () => new Promise(() => {}), timeoutMs: () => current });
  current = 50;
  await mk(handlers).runOnce();
  expect(status(id).lastError?.kind).toBe("timeout");
  expect(status(id).lastError?.message).toContain("50ms");
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

test("a handler's externalWrite flag is persisted at claim, before the handler runs (G2)", async () => {
  const id = enqueue();
  expect(status(id).externalWrite).toBe(false);
  let seenInHandler: boolean | undefined;
  await mk(
    reg(
      async () => {
        seenInHandler = status(id).externalWrite;
        return new Promise(() => {});
      },
      30,
      { externalWrite: true },
    ),
  ).runOnce();
  expect(seenInHandler).toBe(true);
  expect(status(id).status).toBe("NEEDS_ATTENTION");

  // A crash (no settle) leaves RUNNING; the reaper must honour the persisted flag.
  const crashed = enqueue("t", "k2");
  const owner = q.claim("w9", 1_000, ["t"])?.leaseOwner ?? "";
  expect(q.markExternalWrite(crashed, owner)).toBe(true);
  const clock = new FakeClock("2026-11-05T12:00:00.000Z");
  clock.advance(2_000);
  const reaped = reapExpiredJobs({ db, clock, audit: new AuditLogger(clock) });
  expect(reaped).toEqual({ requeued: 0, needsAttention: 1 });
  expect(status(crashed).status).toBe("NEEDS_ATTENTION");
});

test("claim errors are logged once per interval and recovery is logged once (G7)", async () => {
  let nowMs = 1_000;
  const nowSpy = spyOn(performance, "now").mockImplementation(() => nowMs);
  const claimSpy = spyOn(q, "claim").mockImplementation(() => {
    throw new Error("db locked");
  });
  const errSpy = spyOn(console, "error").mockImplementation(() => {});
  const logSpy = spyOn(console, "log").mockImplementation(() => {});
  try {
    const w = mk(
      reg(async () => 1),
      "w1",
      { claimErrorLogIntervalMs: 60_000 },
    );
    const polls = async (n: number) => {
      for (let i = 0; i < n; i++) {
        await w.runOnce();
        nowMs += 1_000;
      }
    };
    await polls(10);
    expect(errSpy.mock.calls).toEqual([["worker: claim failed", "Error: db locked"]]);
    nowMs += 60_000;
    await polls(1);
    expect(errSpy).toHaveBeenCalledTimes(2);
    claimSpy.mockRestore();
    await polls(2);
    expect(errSpy).toHaveBeenCalledTimes(2);
    expect(logSpy.mock.calls).toEqual([["worker: claim recovered"]]);
  } finally {
    nowSpy.mockRestore();
    claimSpy.mockRestore();
    errSpy.mockRestore();
    logSpy.mockRestore();
  }
});

test("I3c: an external-write job failing with an uncertain provider_error goes to NEEDS_ATTENTION", async () => {
  const uncertain = () => {
    throw new JobError({ kind: "provider_error", message: "x", details: { uncertain: true } });
  };
  const viaReg = enqueue("t", "reg");
  await mk(reg(async () => uncertain(), 1_000, { externalWrite: true })).runOnce();
  expect(status(viaReg).status).toBe("NEEDS_ATTENTION");
  expect(status(viaReg).lastError).toEqual(VERIFY);
  expect(attempt(viaReg)?.error).toMatchObject({ kind: "provider_error" });

  const viaColumn = enqueue("t", "col", true);
  await mk(reg(async () => uncertain())).runOnce();
  expect(status(viaColumn).status).toBe("NEEDS_ATTENTION");
});

test("I3c: an uncertain failure on a non-external job keeps normal retry rules", async () => {
  const id = enqueue();
  await mk(
    reg(async () => {
      throw new JobError({ kind: "provider_error", message: "x", details: { uncertain: true } });
    }),
  ).runOnce();
  expect(status(id).status).toBe("RETRY");
});

test("checkpoint rejected by the queue is a lost lease: abort, throw, no completion", async () => {
  const id = enqueue();
  let signal: AbortSignal | undefined;
  let thrown: unknown;
  const handler: JobHandler = async (_j, ctx) => {
    signal = ctx.signal;
    db.update(schema.jobs).set({ leaseOwner: "thief" }).where(eq(schema.jobs.id, id)).run();
    try {
      ctx.checkpoint("x");
    } catch (e) {
      thrown = e;
    }
    return "late";
  };
  await mk(reg(handler), "w1", { heartbeatMs: 10_000 }).runOnce();
  expect(signal?.aborted).toBe(true);
  expect(thrown).toBe(signal?.reason);
  expect((thrown as Error).message).toBe("lease lost");
  expect(q.getCheckpoint(id)).toBeUndefined();
  expect(status(id).status).toBe("RUNNING");
  expect(status(id).leaseOwner).toBe("thief");
});
