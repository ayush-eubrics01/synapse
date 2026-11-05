import { beforeEach, expect, test } from "bun:test";
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
