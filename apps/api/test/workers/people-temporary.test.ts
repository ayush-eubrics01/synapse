import { beforeEach, expect, test } from "bun:test";
import type { Job } from "@synapse/contracts";
import { openDatabase, runMigrations, schema } from "@synapse/database";
import { FakeClock } from "@synapse/shared";
import { AuditLogger } from "../../src/core/audit/audit";
import { SettingsService } from "../../src/core/config/settings";
import { EventPublisher } from "../../src/core/events/publisher";
import { JobQueue } from "../../src/core/jobs/queue";
import type { HandlerRegistration } from "../../src/core/jobs/worker";
import { SchedulerService } from "../../src/core/scheduler/scheduler";
import { PeopleService } from "../../src/modules/people/service";
import { TemporaryContacts } from "../../src/modules/people/temporary";
import { registerPeopleJobs } from "../../src/workers/people";

let db: ReturnType<typeof openDatabase>["db"];
let clock: FakeClock;
let handlers: Map<string, HandlerRegistration>;
let scheduler: SchedulerService;
let people: PeopleService;

beforeEach(() => {
  db = openDatabase(":memory:").db;
  runMigrations(db);
  clock = new FakeClock("2026-11-05T12:00:00.000Z");
  const events = new EventPublisher(clock);
  const settings = new SettingsService(db, clock, events.publish.bind(events));
  people = new PeopleService({ db, clock, events, audit: new AuditLogger(clock), settings });
  const queue = new JobQueue(db, clock);
  scheduler = new SchedulerService(db, clock, queue);
  handlers = new Map();
  registerPeopleJobs({
    db,
    clock,
    settings,
    scheduler,
    queue,
    handlers,
    // The expiry job uses none of the Claude-path dependencies.
    recommendations: {} as never,
    orchestrator: {} as never,
    securityFlags: {} as never,
    temporary: new TemporaryContacts({ db, clock, settings, events, queue }),
  });
});

const iso = (offsetDays: number) =>
  new Date(clock.now().getTime() + offsetDays * 86_400_000).toISOString();
const addTemp = (slackUserId: string, expiresAt: string) =>
  db
    .insert(schema.temporaryContacts)
    .values({
      id: `t-${slackUserId}`,
      slackUserId,
      firstSeenAt: iso(-40),
      lastSeenAt: iso(-40),
      messageCount: 1,
      expiresAt,
    })
    .run();

test("registers a daily coalesced schedule", () => {
  const task = db.select().from(schema.scheduledTasks).get();
  expect(task?.jobType).toBe("people.expire_temporary");
  expect(task?.intervalSeconds).toBe(86_400);
  expect(handlers.has("people.expire_temporary")).toBe(true);
});

test("expiry deletes only expired rows without a pending recommendation", async () => {
  addTemp("UFRESH0001", iso(5));
  addTemp("UEXPIRED01", iso(-1));
  addTemp("UPENDING01", iso(-1));
  db.insert(schema.slackUsers).values({ id: "su1", externalId: "UPENDING01" }).run();
  const pid = db.transaction((tx) => people.ensurePerson(tx, "UPENDING01"));
  db.insert(schema.peopleProfileRecommendations)
    .values({ id: "r", personId: pid, kind: "initial", status: "pending", createdAt: iso(-2) })
    .run();
  const out = await handlers.get("people.expire_temporary")?.handler({} as Job, {} as never);
  expect(out).toEqual({ deleted: 1 });
  expect(
    db
      .select()
      .from(schema.temporaryContacts)
      .all()
      .map((r) => r.slackUserId)
      .sort(),
  ).toEqual(["UFRESH0001", "UPENDING01"]);
});
