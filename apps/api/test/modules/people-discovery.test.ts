import { beforeEach, expect, test } from "bun:test";
import { openDatabase, runMigrations, schema } from "@synapse/database";
import { FakeClock } from "@synapse/shared";
import { eq } from "drizzle-orm";
import { AuditLogger } from "../../src/core/audit/audit";
import { SettingsService } from "../../src/core/config/settings";
import { EventPublisher } from "../../src/core/events/publisher";
import { ContactDiscovery } from "../../src/modules/people/discovery";
import { PeopleService } from "../../src/modules/people/service";
import { TemporaryContacts } from "../../src/modules/people/temporary";

let db: ReturnType<typeof openDatabase>["db"];
let clock: FakeClock;
let settings: SettingsService;
let events: EventPublisher;
let people: PeopleService;
let discovery: ContactDiscovery;
let temporary: TemporaryContacts;
let seq = 0;
const SELF = "USELF00001";

beforeEach(() => {
  db = openDatabase(":memory:").db;
  runMigrations(db);
  clock = new FakeClock("2026-11-05T12:00:00.000Z");
  events = new EventPublisher(clock);
  settings = new SettingsService(db, clock, events.publish.bind(events));
  people = new PeopleService({ db, clock, events, audit: new AuditLogger(clock), settings });
  discovery = new ContactDiscovery({ db, clock, settings });
  temporary = new TemporaryContacts({ db, clock, settings, events });
  seq = 0;
  addUser(SELF, "Me");
  settings.set("slack.selfUserId", SELF);
});

const addUser = (externalId: string, name: string | null = null) => {
  db.insert(schema.slackUsers)
    .values({ id: `su-${externalId}`, externalId, name })
    .run();
};
const addConv = (id: string, type: "im" | "mpim" | "channel") => {
  db.insert(schema.slackConversations)
    .values({ id, externalId: `ext-${id}`, type })
    .run();
};
const daysAgo = (d: number) => new Date(clock.now().getTime() - d * 86_400_000).toISOString();

function addMsg(
  conv: string,
  sender: string,
  over: { text?: string; threadTs?: string; ts?: string; sentAt?: string } = {},
): string {
  seq += 1;
  const id = `m${seq}`;
  db.insert(schema.slackMessages)
    .values({
      id,
      conversationId: conv,
      ts: over.ts ?? `${1000 + seq}.000`,
      threadTs: over.threadTs ?? null,
      senderUserId: `su-${sender}`,
      text: over.text ?? "x",
      sentAt: over.sentAt ?? daysAgo(1),
      collectedAt: daysAgo(1),
    })
    .run();
  return id;
}

const received = (messageId: string) => {
  const ev = {
    id: "e",
    type: "message.received",
    version: 1,
    aggregateType: "message",
    aggregateId: messageId,
    correlationId: "c",
    payload: { messageId },
    occurredAt: clock.now().toISOString(),
  };
  // biome-ignore lint/suspicious/noExplicitAny: minimal event for a direct handler call
  db.transaction((tx) => temporary.handle(ev as any, tx));
};

const discovered = () =>
  db
    .select()
    .from(schema.domainEvents)
    .where(eq(schema.domainEvents.type, "person.discovered"))
    .all();

test("scores: 3 per DM, 2 per mpim, 2 per mention, 1 per thread reply; order and fields", () => {
  for (const u of ["UDM0000001", "UMP0000001", "UMEN000001", "UTHR000001", "UNONE00001"])
    addUser(u, u);
  addConv("dm", "im");
  addConv("mp", "mpim");
  addConv("ch", "channel");
  addMsg("dm", "UDM0000001");
  addMsg("dm", "UDM0000001"); // 6
  addMsg("mp", "UMP0000001");
  addMsg("mp", "UMP0000001");
  addMsg("mp", "UMP0000001"); // 6 too, ties by id
  addMsg("ch", "UMEN000001", { text: `hey <@${SELF}> look` });
  addMsg("ch", "UMEN000001", { text: `hey &lt;@${SELF}&gt; look` });
  addMsg("ch", "UMEN000001", { text: `hey <@${SELF}|me> look` }); // 6
  addMsg("ch", "UMEN000001", { text: "<@USELF000019> not me" }); // 0
  addMsg("ch", SELF, { ts: "500.000" }); // self root
  addMsg("ch", "UTHR000001", { threadTs: "500.000", ts: "501.000" }); // 1
  addMsg("ch", "UTHR000001", { threadTs: "999.000", ts: "502.000" }); // self absent: 0
  addMsg("ch", "UNONE00001");
  const list = discovery.listContactCandidates();
  expect(list.map((c) => c.slackUserId)).toEqual([
    "UDM0000001",
    "UMEN000001",
    "UMP0000001",
    "UTHR000001",
    "UNONE00001",
  ]);
  expect(list.map((c) => c.score)).toEqual([6, 6, 6, 1, 0]);
  expect(list[0]).toEqual({
    slackUserId: "UDM0000001",
    name: "UDM0000001",
    score: 6,
    messageCount: 2,
    hasProfile: false,
    hasPendingRecommendation: false,
    isTemporary: false,
  });
  expect(list.find((c) => c.slackUserId === "UMEN000001")?.messageCount).toBe(4);
  expect(discovery.listContactCandidates({ limit: 2 })).toHaveLength(2);
});

test("self is excluded; null self returns []; old messages are outside the window", () => {
  addUser("UANN000001");
  addConv("dm", "im");
  addMsg("dm", SELF);
  addMsg("dm", "UANN000001", { sentAt: daysAgo(200) });
  expect(discovery.listContactCandidates()).toEqual([]);
  addMsg("dm", "UANN000001");
  expect(discovery.listContactCandidates().map((c) => c.slackUserId)).toEqual(["UANN000001"]);
  settings.clear("slack.selfUserId");
  expect(discovery.listContactCandidates()).toEqual([]);
});

test("flags reflect profile, pending recommendation and temporary contact", () => {
  addUser("UANN000001");
  addUser("UBOB000001");
  addConv("dm", "im");
  addMsg("dm", "UANN000001");
  addMsg("dm", "UBOB000001");
  const annId = db.transaction((tx) => people.ensurePerson(tx, "UANN000001"));
  db.insert(schema.peopleProfiles)
    .values({ id: "pp", personId: annId, currentVersion: 1, content: {}, updatedAt: daysAgo(1) })
    .run();
  db.insert(schema.peopleProfileRecommendations)
    .values({ id: "pr", personId: annId, kind: "update", status: "pending", createdAt: daysAgo(1) })
    .run();
  db.insert(schema.temporaryContacts)
    .values({
      id: "t",
      slackUserId: "UBOB000001",
      firstSeenAt: daysAgo(1),
      lastSeenAt: daysAgo(1),
      messageCount: 1,
      expiresAt: daysAgo(-5),
    })
    .run();
  const byId = Object.fromEntries(discovery.listContactCandidates().map((c) => [c.slackUserId, c]));
  expect(byId.UANN000001).toMatchObject({
    hasProfile: true,
    hasPendingRecommendation: true,
    isTemporary: false,
  });
  expect(byId.UBOB000001).toMatchObject({
    hasProfile: false,
    hasPendingRecommendation: false,
    isTemporary: true,
  });
});

test("unknown sender becomes one temporary contact, one event, count increments", () => {
  addUser("UNEW000001");
  addConv("ch", "channel");
  received(addMsg("ch", "UNEW000001"));
  received(addMsg("ch", "UNEW000001"));
  const rows = db.select().from(schema.temporaryContacts).all();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.messageCount).toBe(2);
  expect(rows[0]?.expiresAt).toBe(new Date(clock.now().getTime() + 30 * 86_400_000).toISOString());
  expect(discovered()).toHaveLength(1);
  expect(discovered()[0]?.payload).toEqual({ slackUserId: "UNEW000001" });
});

test("self, known people and profiled senders create no temporary contact", () => {
  addUser("UKNOWN0001");
  addUser("UPROF00001");
  addConv("ch", "channel");
  db.transaction((tx) => people.ensurePerson(tx, "UKNOWN0001"));
  const pid = db.transaction((tx) => people.ensurePerson(tx, "UPROF00001"));
  db.insert(schema.peopleProfiles)
    .values({ id: "pp", personId: pid, currentVersion: 1, content: {}, updatedAt: daysAgo(1) })
    .run();
  received(addMsg("ch", SELF));
  received(addMsg("ch", "UKNOWN0001"));
  received(addMsg("ch", "UPROF00001"));
  expect(db.select().from(schema.temporaryContacts).all()).toHaveLength(0);
  expect(discovered()).toHaveLength(0);
});

test("messages older than people.history.days are ignored; null self creates none", () => {
  addUser("UOLD000001");
  addConv("ch", "channel");
  received(addMsg("ch", "UOLD000001", { sentAt: daysAgo(91) }));
  expect(db.select().from(schema.temporaryContacts).all()).toHaveLength(0);
  settings.clear("slack.selfUserId");
  received(addMsg("ch", "UOLD000001"));
  expect(db.select().from(schema.temporaryContacts).all()).toHaveLength(0);
});

test("handler never throws and rolls back its writes on failure", () => {
  addUser("UNEW000001");
  addConv("ch", "channel");
  const id = addMsg("ch", "UNEW000001");
  const broken = new TemporaryContacts({
    db,
    clock,
    settings,
    events: {
      publish: () => {
        throw new Error("boom SECRET text");
      },
    } as unknown as EventPublisher,
  });
  const errs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => errs.push(a.join(" "));
  try {
    // biome-ignore lint/suspicious/noExplicitAny: minimal event
    const ev: any = { type: "message.received", correlationId: "c", payload: { messageId: id } };
    db.transaction((tx) => broken.handle(ev, tx));
  } finally {
    console.error = orig;
  }
  expect(db.select().from(schema.temporaryContacts).all()).toHaveLength(0);
  expect(errs.join()).not.toContain("SECRET");
});

test("G2: ensurePerson refreshes a changed name and email, keeps them if slack row has none", () => {
  addUser("UANN000001", "Ann");
  db.transaction((tx) => people.ensurePerson(tx, "UANN000001"));
  db.update(schema.slackUsers)
    .set({ name: "Ann B", email: "a@x.io" })
    .where(eq(schema.slackUsers.externalId, "UANN000001"))
    .run();
  db.transaction((tx) => people.ensurePerson(tx, "UANN000001"));
  let row = db.select().from(schema.people).get();
  expect(row?.name).toBe("Ann B");
  expect(row?.email).toBe("a@x.io");
  db.update(schema.slackUsers)
    .set({ name: null, email: null })
    .where(eq(schema.slackUsers.externalId, "UANN000001"))
    .run();
  db.transaction((tx) => people.ensurePerson(tx, "UANN000001"));
  row = db.select().from(schema.people).get();
  expect(row?.name).toBe("Ann B");
});

test("G3: setPriority patches; null rationale clears", () => {
  addUser("UANN000001");
  people.setPriority("UANN000001", {
    priority: "critical",
    rationale: "boss",
    extraAttention: true,
  });
  people.setPriority("UANN000001", { priority: "high" });
  const get = () => db.select().from(schema.peoplePrioritySettings).get();
  expect(get()).toMatchObject({ priority: "high", rationale: "boss", extraAttention: true });
  people.setPriority("UANN000001", { priority: "high", rationale: null });
  expect(get()).toMatchObject({ rationale: null, extraAttention: true });
  people.setPriority("UANN000001", { priority: "normal", extraAttention: false });
  expect(get()).toMatchObject({ priority: "normal", extraAttention: false });
});
