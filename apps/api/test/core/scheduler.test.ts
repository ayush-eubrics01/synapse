import { beforeEach, expect, spyOn, test } from "bun:test";
import { openDatabase, runMigrations, schema } from "@synapse/database";
import { FakeClock } from "@synapse/shared";
import { eq } from "drizzle-orm";
import { JobQueue } from "../../src/core/jobs/queue";
import { SchedulerService } from "../../src/core/scheduler/scheduler";

let db: ReturnType<typeof openDatabase>["db"];
let clock: FakeClock;
let sched: SchedulerService;

const jobs = () => db.select().from(schema.jobs).all();
const task = (name: string) => {
  const t = db
    .select()
    .from(schema.scheduledTasks)
    .where(eq(schema.scheduledTasks.name, name))
    .get();
  if (!t) throw new Error("missing task");
  return t;
};

beforeEach(() => {
  db = openDatabase(":memory:").db;
  runMigrations(db);
  clock = new FakeClock("2026-11-05T10:20:00.000Z");
  sched = new SchedulerService(db, clock, new JobQueue(db, clock));
});

test("new schedule runs at first tick, once per time", () => {
  sched.upsert({ name: "s", jobType: "t", intervalSeconds: 600, input: { a: 1 }, priority: 7 });
  expect(sched.tick()).toBe(1);
  expect(sched.tick()).toBe(0);
  const [j] = jobs();
  expect(j?.type).toBe("t");
  expect(j?.priority).toBe(7);
  expect(j?.input).toEqual({ a: 1 });
  expect(task("s").lastRunAt).toBe("2026-11-05T10:20:00.000Z");
});

test("no catch-up storm after a long gap", () => {
  sched.upsert({ name: "s", jobType: "t", intervalSeconds: 600 });
  sched.tick();
  clock.advance(5 * 3600_000);
  expect(sched.tick()).toBe(1);
  expect(jobs().length).toBe(2);
  expect(task("s").nextRunAt).toBe("2026-11-05T15:30:00.000Z");
  expect(sched.tick()).toBe(0);
});

test("cron next run computed in UTC", () => {
  sched.upsert({ name: "c", jobType: "t", cron: "0 * * * *" });
  expect(sched.tick()).toBe(1);
  expect(task("c").nextRunAt).toBe("2026-11-05T11:00:00.000Z");
});

test("disabled schedules are skipped", () => {
  sched.upsert({ name: "s", jobType: "t", intervalSeconds: 60, enabled: false });
  expect(sched.tick()).toBe(0);
});

test("validation", () => {
  expect(() =>
    sched.upsert({ name: "s", jobType: "t", intervalSeconds: 60, cron: "* * * * *" }),
  ).toThrow();
  expect(() => sched.upsert({ name: "s", jobType: "t" })).toThrow();
  expect(() => sched.upsert({ name: "s", jobType: "t", intervalSeconds: 0 })).toThrow();
  expect(() => sched.upsert({ name: "s", jobType: "t", intervalSeconds: 1.5 })).toThrow();
  expect(() => sched.upsert({ name: "s", jobType: "t", cron: "not a cron" })).toThrow();
});

test("upsert keeps next_run_at unless timing changes", () => {
  sched.upsert({ name: "s", jobType: "t", intervalSeconds: 600 });
  sched.tick();
  const next = task("s").nextRunAt;
  clock.advance(1000);
  sched.upsert({ name: "s", jobType: "t2", intervalSeconds: 600, priority: 5 });
  expect(task("s").nextRunAt).toBe(next);
  expect(task("s").jobType).toBe("t2");
  sched.upsert({ name: "s", jobType: "t2", intervalSeconds: 300 });
  expect(task("s").nextRunAt).toBe("2026-11-05T10:20:01.000Z");
});

test("R58: coalesce skips enqueue while a PENDING/RETRY/RUNNING job exists, still advances", () => {
  sched.upsert({ name: "s", jobType: "t", intervalSeconds: 600, coalesce: true });
  expect(sched.tick()).toBe(1);
  // Simulate a deferral: the job sits PENDING far in the future (e.g. auth pause).
  db.update(schema.jobs).set({ runAfter: "2026-11-06T00:00:00.000Z" }).run();
  for (let i = 1; i <= 3; i++) {
    clock.advance(600_000);
    expect(sched.tick()).toBe(0);
    expect(task("s").nextRunAt).toBe(new Date(clock.now().getTime() + 600_000).toISOString());
  }
  expect(jobs()).toHaveLength(1);
  for (const status of ["RETRY", "RUNNING"] as const) {
    db.update(schema.jobs).set({ status }).run();
    clock.advance(600_000);
    expect(sched.tick()).toBe(0);
    expect(jobs()).toHaveLength(1);
  }
  db.update(schema.jobs).set({ status: "COMPLETED" }).run();
  clock.advance(600_000);
  expect(sched.tick()).toBe(1);
  expect(jobs()).toHaveLength(2);
});

test("R58: without coalesce a waiting job does not block the next enqueue", () => {
  sched.upsert({ name: "s", jobType: "t", intervalSeconds: 600 });
  sched.tick();
  clock.advance(600_000);
  expect(sched.tick()).toBe(1);
  expect(jobs()).toHaveLength(2);
});

test("R58: coalesce only looks at jobs of the schedule's own type", () => {
  sched.upsert({ name: "a", jobType: "ta", intervalSeconds: 600, coalesce: true });
  sched.upsert({ name: "b", jobType: "tb", intervalSeconds: 600, coalesce: true });
  expect(sched.tick()).toBe(2);
  db.update(schema.jobs).set({ status: "COMPLETED" }).where(eq(schema.jobs.type, "tb")).run();
  clock.advance(600_000);
  expect(sched.tick()).toBe(1);
  expect(jobs().filter((j) => j.type === "tb")).toHaveLength(2);
});

test("runNow makes an enabled schedule due on the next tick", () => {
  sched.upsert({ name: "s", jobType: "t", intervalSeconds: 900 });
  expect(sched.tick()).toBe(1);
  expect(sched.tick()).toBe(0);
  expect(sched.runNow("s")).toBe(true);
  expect(sched.tick()).toBe(1);
});

test("runNow is false for a missing or disabled schedule", () => {
  expect(sched.runNow("missing")).toBe(false);
  sched.upsert({ name: "d", jobType: "t", intervalSeconds: 900, enabled: false });
  expect(sched.runNow("d")).toBe(false);
});

test("one failing task does not stop the others and is retried in 60 s", () => {
  const real = new JobQueue(db, clock);
  const queue = {
    enqueue: (
      tx: Parameters<JobQueue["enqueue"]>[0],
      input: Parameters<JobQueue["enqueue"]>[1],
    ) => {
      if (input.type === "boom") throw new Error("nope");
      return real.enqueue(tx, input);
    },
  } as unknown as JobQueue;
  const s = new SchedulerService(db, clock, queue);
  s.upsert({ name: "a", jobType: "boom", intervalSeconds: 600 });
  s.upsert({ name: "b", jobType: "ok", intervalSeconds: 600 });
  const spy = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(s.tick()).toBe(1);
    expect(jobs().map((j) => j.type)).toEqual(["ok"]);
    expect(spy.mock.calls).toEqual([["scheduler: task failed name=a error=Error"]]);
    expect(task("a").nextRunAt).toBe("2026-11-05T10:21:00.000Z");
    expect(s.tick()).toBe(0);
    expect(spy.mock.calls.length).toBe(1);
  } finally {
    spy.mockRestore();
  }
});

test("upsert clamps intervalSeconds to 7 days", () => {
  sched.upsert({ name: "big", jobType: "t", intervalSeconds: 10_000_000 });
  expect(task("big").intervalSeconds).toBe(604_800);
  expect(() => sched.upsert({ name: "z", jobType: "t", intervalSeconds: 0 })).toThrow();
});
