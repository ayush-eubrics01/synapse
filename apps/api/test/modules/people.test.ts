import { beforeEach, expect, test } from "bun:test";
import { openDatabase, runMigrations, schema } from "@synapse/database";
import { FakeClock } from "@synapse/shared";
import { eq } from "drizzle-orm";
import { AuditLogger } from "../../src/core/audit/audit";
import { SettingsService } from "../../src/core/config/settings";
import { EventPublisher } from "../../src/core/events/publisher";
import { PeopleService } from "../../src/modules/people/service";

let db: ReturnType<typeof openDatabase>["db"];
let clock: FakeClock;
let people: PeopleService;
let settings: SettingsService;
let seq = 0;

beforeEach(() => {
  db = openDatabase(":memory:").db;
  runMigrations(db);
  clock = new FakeClock("2026-11-05T12:00:00.000Z");
  const events = new EventPublisher(clock);
  settings = new SettingsService(db, clock, events.publish.bind(events));
  people = new PeopleService({ db, clock, events, audit: new AuditLogger(clock), settings });
  seq = 0;
});

function addUser(externalId: string, name: string | null = null, email: string | null = null) {
  const id = `su-${externalId}`;
  db.insert(schema.slackUsers).values({ id, externalId, name, email }).run();
  return id;
}

function addDm(userInternalIds: string[], convId: string) {
  db.insert(schema.slackConversations)
    .values({ id: convId, externalId: `ext-${convId}`, type: "im" })
    .run();
  for (const u of userInternalIds) {
    seq += 1;
    db.insert(schema.slackMessages)
      .values({
        id: `m${seq}`,
        conversationId: convId,
        ts: `${seq}.000`,
        senderUserId: u,
        text: "x",
        sentAt: clock.now().toISOString(),
        collectedAt: clock.now().toISOString(),
      })
      .run();
  }
}

test("ensurePerson is idempotent and copies name and email", () => {
  addUser("UANN000001", "Ann", "ann@example.com");
  const a = db.transaction((tx) => people.ensurePerson(tx, "UANN000001"));
  const b = db.transaction((tx) => people.ensurePerson(tx, "UANN000001"));
  expect(a).toBe(b);
  const rows = db.select().from(schema.people).all();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.name).toBe("Ann");
  expect(rows[0]?.email).toBe("ann@example.com");
});

test("default priority is normal without a row", () => {
  expect(people.getPriorityBySlackUser("UNOBODY001")).toEqual({
    priority: "normal",
    extraAttention: false,
  });
});

test("setPriority persists, audits ids only and emits settings.changed", () => {
  addUser("UANN000001", "Ann");
  people.setPriority("UANN000001", {
    priority: "critical",
    rationale: "my manager",
    extraAttention: true,
  });
  expect(people.getPriorityBySlackUser("UANN000001")).toEqual({
    priority: "critical",
    extraAttention: true,
  });
  const audit = db.select().from(schema.auditEvents).all();
  expect(audit).toHaveLength(1);
  expect(audit[0]?.action).toBe("people.priority_set");
  expect(audit[0]?.actor).toBe("user");
  expect(JSON.stringify(audit[0]?.details)).not.toContain("my manager");
  expect(JSON.stringify(audit[0]?.details)).toContain("critical");
  const ev = db
    .select()
    .from(schema.domainEvents)
    .where(eq(schema.domainEvents.type, "settings.changed"))
    .all();
  expect(ev.map((e) => (e.payload as { key: string }).key)).toContain("people.priority:UANN000001");

  // updating overwrites the single row
  people.setPriority("UANN000001", { priority: "high" });
  expect(people.getPriorityBySlackUser("UANN000001").priority).toBe("high");
  expect(db.select().from(schema.peoplePrioritySettings).all()).toHaveLength(1);
});

test("setPriority rejects unknown slack users and invalid priority", () => {
  expect(() => people.setPriority("UNOBODY001", { priority: "high" })).toThrow();
  addUser("UANN000001");
  // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid
  expect(() => people.setPriority("UANN000001", { priority: "urgent" as any })).toThrow();
  expect(db.select().from(schema.auditEvents).all()).toHaveLength(0);
});

test("listPeople lists every slack user with defaults", () => {
  addUser("UANN000001", "Ann");
  addUser("UBOB000001", "Bob");
  people.setPriority("UANN000001", { priority: "high" });
  const list = people.listPeople();
  expect(list).toHaveLength(2);
  expect(list.find((p) => p.slackUserId === "UANN000001")).toEqual({
    slackUserId: "UANN000001",
    name: "Ann",
    priority: "high",
    rationale: null,
    extraAttention: false,
  });
  expect(list.find((p) => p.slackUserId === "UBOB000001")?.priority).toBe("normal");
});

test("suggestSelfUserId returns the sender present in most DMs", () => {
  const self = addUser("USELF00001");
  const o1 = addUser("UOTH000001");
  const o2 = addUser("UOTH000002");
  const o3 = addUser("UOTH000003");
  addDm([self, o1, self], "c1");
  addDm([self, o2], "c2");
  addDm([self, o3], "c3");
  expect(people.suggestSelfUserId()).toBe("USELF00001");
});

test("suggestSelfUserId returns null with fewer than two DMs", () => {
  const self = addUser("USELF00001");
  const o1 = addUser("UOTH000001");
  addDm([self, o1], "c1");
  expect(people.suggestSelfUserId()).toBeNull();
});

test("confirmSelfUserId stores a known id and rejects unknown or malformed ones", () => {
  addUser("USELF00001");
  expect(() => people.confirmSelfUserId("UNKNOWN0001")).toThrow();
  expect(() => people.confirmSelfUserId("lower")).toThrow();
  expect(settings.get("slack.selfUserId")).toBeNull();
  people.confirmSelfUserId("USELF00001");
  expect(settings.get("slack.selfUserId")).toBe("USELF00001");
});
