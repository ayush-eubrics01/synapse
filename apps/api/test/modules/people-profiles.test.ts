import { beforeEach, describe, expect, test } from "bun:test";
import type { ProfileContent, ProfileUpdateOutput } from "@synapse/contracts";
import { openDatabase, runMigrations, schema } from "@synapse/database";
import { FakeClock } from "@synapse/shared";
import { eq } from "drizzle-orm";
import { ApprovalEngine } from "../../src/core/approvals/approvals";
import { AuditLogger } from "../../src/core/audit/audit";
import { SettingsService } from "../../src/core/config/settings";
import { OutboxDispatcher } from "../../src/core/events/dispatcher";
import { LiveBus } from "../../src/core/events/live-bus";
import { EventPublisher } from "../../src/core/events/publisher";
import { JobQueue } from "../../src/core/jobs/queue";
import { PermissionManager } from "../../src/core/permissions/permissions";
import { ProfileService } from "../../src/modules/people/profiles";
import { ProfileRecommendations, RetryNotAllowed } from "../../src/modules/people/recommendations";
import { PeopleService } from "../../src/modules/people/service";

const NOW = "2026-11-05T12:00:00.000Z";
const SECRET = "SECRET-PROFILE-TEXT";

let db: ReturnType<typeof openDatabase>["db"];
let clock: FakeClock;
let engine: ApprovalEngine;
let dispatcher: OutboxDispatcher;
let service: ProfileService;
let recs: ProfileRecommendations;
let personId: string;
let seq = 0;

beforeEach(() => {
  db = openDatabase(":memory:").db;
  runMigrations(db);
  clock = new FakeClock(NOW);
  seq = 0;
  const events = new EventPublisher(clock);
  const audit = new AuditLogger(clock);
  const settings = new SettingsService(db, clock, events.publish.bind(events));
  engine = new ApprovalEngine(db, clock, events, audit, new PermissionManager(db, audit));
  dispatcher = new OutboxDispatcher(db, clock, new LiveBus());
  const people = new PeopleService({ db, clock, events, audit, settings });
  service = new ProfileService({ db, clock, events, audit });
  service.register(engine, dispatcher);
  recs = new ProfileRecommendations({
    db,
    clock,
    settings,
    events,
    queue: new JobQueue(db, clock),
    approvals: engine,
    people,
  });
  db.insert(schema.slackUsers).values({ id: "u1", externalId: "UTHEM00001", name: "P" }).run();
  db.insert(schema.slackConversations)
    .values({ id: "c1", externalId: "C1", type: "channel" })
    .run();
  personId = db.transaction((tx) => people.ensurePerson(tx, "UTHEM00001"));
});

const obs = (key: string) => ({
  key,
  text: `${SECRET} ${key}`,
  evidence: ["m"],
  confidence: "high" as const,
});
const content = (p: Partial<ProfileContent> = {}): ProfileContent => ({
  professionalContext: [],
  communication: [],
  responseGuidelines: [],
  ...p,
});

function message(over: { text?: string | null; permalink?: string | null } = {}): string {
  seq += 1;
  const id = `m${seq}`;
  db.insert(schema.slackMessages)
    .values({
      id,
      conversationId: "c1",
      ts: `${seq}.0`,
      senderUserId: "u1",
      text: over.text === undefined ? "hello" : over.text,
      permalink: over.permalink ?? null,
      sentAt: NOW,
      collectedAt: NOW,
    })
    .run();
  return id;
}

function store(
  kind: "initial" | "update",
  body: ProfileContent | ProfileUpdateOutput,
  evidence: { key: string; messageId: string }[] = [],
  baseVersion?: number,
) {
  const id = `rec-${++seq}`;
  const approval = db.transaction((tx) => {
    db.insert(schema.peopleProfileRecommendations)
      .values({
        id,
        personId,
        kind,
        baseVersion: baseVersion ?? null,
        content: body,
        status: "pending",
        createdAt: NOW,
      })
      .run();
    for (const e of evidence) {
      tx.insert(schema.peopleProfileEvidence)
        .values({
          id: `ev-${++seq}`,
          recommendationId: id,
          observationKey: e.key,
          messageId: e.messageId,
          sourceExternalRef: `ref-${e.messageId}`,
          confidence: "high",
          observedAt: NOW,
        })
        .run();
    }
    const a = engine.request(tx, {
      action: "records.update",
      targetIntegration: "people",
      targetRef: personId,
      payload: { recommendationId: id },
      riskLevel: "low",
      idempotencyKey: `people.rec:${id}`,
      requestedByModule: "people",
    });
    tx.update(schema.peopleProfileRecommendations)
      .set({ approvalId: a.id })
      .where(eq(schema.peopleProfileRecommendations.id, id))
      .run();
    return a;
  });
  return { id, approvalId: approval.id };
}

const recRow = (id: string) =>
  db
    .select()
    .from(schema.peopleProfileRecommendations)
    .where(eq(schema.peopleProfileRecommendations.id, id))
    .get();
const approveAndRun = async (approvalId: string) => {
  engine.approve(approvalId);
  return engine.execute(approvalId);
};
const addDiff = (section: "communication", key: string) => ({
  section,
  ...obs(key),
});
const diff = (d: Partial<ProfileUpdateOutput>): ProfileUpdateOutput => ({
  add: [],
  remove: [],
  suspectedInjection: { detected: false, severity: "info", quote: "", reason: "" },
  ...d,
});

describe("applying approvals", () => {
  test("initial: version 1, profile, evidence linked, event, audit without profile text", async () => {
    const m = message();
    const r = store("initial", content({ communication: [obs("a")] }), [
      { key: "communication.a", messageId: m },
    ]);
    const out = await approveAndRun(r.approvalId);
    expect(out.status).toBe("executed");
    expect(recRow(r.id)?.status).toBe("applied");
    expect(recRow(r.id)?.decidedAt).toBe(NOW);
    const profile = service.getProfile(personId);
    expect(profile?.version).toBe(1);
    expect(profile?.content.communication[0]?.key).toBe("a");
    expect(profile?.evidence).toEqual([
      {
        observationKey: "communication.a",
        sourceExternalRef: `ref-${m}`,
        messageAvailable: true,
        confidence: "high",
        permalink: null,
      },
    ]);
    // recommendation-linked rows are kept for history
    const rows = db.select().from(schema.peopleProfileEvidence).all();
    expect(rows.filter((e) => e.recommendationId !== null)).toHaveLength(1);
    expect(rows.filter((e) => e.versionId !== null)).toHaveLength(1);
    const ev = db
      .select()
      .from(schema.domainEvents)
      .where(eq(schema.domainEvents.type, "person.profile_approved"))
      .all();
    expect(ev.map((e) => e.payload)).toEqual([{ personId, version: 1 }]);
    const audit = db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, "people.profile_applied"))
      .all();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.details).toEqual({ recommendationId: r.id, personId, version: 1 });
    expect(JSON.stringify(audit) + JSON.stringify(ev)).not.toContain(SECRET);
  });

  test("initial when a profile exists: superseded and skipped, approval executed", async () => {
    const first = store("initial", content({ communication: [obs("a")] }));
    await approveAndRun(first.approvalId);
    const second = store("initial", content({ communication: [obs("b")] }));
    const out = await approveAndRun(second.approvalId);
    expect(out.status).toBe("executed");
    expect(out.result).toEqual({ status: "skipped", reason: "profile_exists" });
    expect(recRow(second.id)?.status).toBe("superseded");
    expect(service.getProfile(personId)?.version).toBe(1);
  });

  test("two updates on base 1: first gives version 2, second is superseded, no duplicate", async () => {
    await approveAndRun(store("initial", content({ communication: [obs("a")] })).approvalId);
    const u1 = store("update", diff({ add: [addDiff("communication", "b")] }), [], 1);
    const u2 = store("update", diff({ add: [addDiff("communication", "c")] }), [], 1);
    engine.approve(u1.approvalId);
    engine.approve(u2.approvalId);
    expect((await engine.execute(u1.approvalId)).result).toEqual({ status: "applied", version: 2 });
    expect((await engine.execute(u2.approvalId)).result).toEqual({
      status: "skipped",
      reason: "stale_base",
    });
    expect(recRow(u2.id)?.status).toBe("superseded");
    const versions = db.select().from(schema.peopleProfileVersions).all();
    expect(versions.map((v) => v.version).sort()).toEqual([1, 2]);
    expect(service.getProfile(personId)?.content.communication.map((o) => o.key)).toEqual([
      "a",
      "b",
    ]);
  });

  test("diff removes A and adds B; history keeps versions 1 and 2 intact; evidence carries forward", async () => {
    const m1 = message();
    const m2 = message();
    const m3 = message();
    await approveAndRun(
      store("initial", content({ communication: [obs("a")], responseGuidelines: [obs("g")] }), [
        { key: "communication.a", messageId: m1 },
        { key: "responseGuidelines.g", messageId: m2 },
      ]).approvalId,
    );
    const u = store(
      "update",
      diff({
        remove: [{ section: "communication", key: "a", evidence: ["m"] }],
        add: [addDiff("communication", "b")],
      }),
      [{ key: "communication.b", messageId: m3 }],
      1,
    );
    await approveAndRun(u.approvalId);
    const profile = service.getProfile(personId);
    expect(profile?.version).toBe(2);
    expect(profile?.content.communication.map((o) => o.key)).toEqual(["b"]);
    expect(profile?.content.responseGuidelines.map((o) => o.key)).toEqual(["g"]);
    expect(profile?.evidence.map((e) => e.observationKey).sort()).toEqual([
      "communication.b",
      "responseGuidelines.g",
    ]);
    const versions = db.select().from(schema.peopleProfileVersions).all();
    const v1 = versions.find((v) => v.version === 1);
    expect((v1?.content as ProfileContent | undefined)?.communication.map((o) => o.key)).toEqual([
      "a",
    ]);
    expect(service.listVersions(personId).map((v) => v.version)).toEqual([1, 2]);
    expect(service.getResponseGuidelines(personId).map((o) => o.key)).toEqual(["g"]);
  });

  test("getResponseGuidelines is [] without a profile", () => {
    expect(service.getResponseGuidelines(personId)).toEqual([]);
    expect(service.getProfile(personId)).toBeNull();
  });

  test("expired source message: messageAvailable false, ref kept; permalink only for http(s)", async () => {
    const live = message({ permalink: "https://slack.example/p1" });
    const bad = message({ permalink: "javascript:alert(1)" });
    const gone = message();
    await approveAndRun(
      store("initial", content({ communication: [obs("a"), obs("b"), obs("c")] }), [
        { key: "communication.a", messageId: live },
        { key: "communication.b", messageId: bad },
        { key: "communication.c", messageId: gone },
      ]).approvalId,
    );
    db.update(schema.slackMessages)
      .set({ text: null })
      .where(eq(schema.slackMessages.id, gone))
      .run();
    const ev = service.getProfile(personId)?.evidence ?? [];
    const by = (k: string) => ev.find((e) => e.observationKey === k);
    expect(by("communication.a")).toMatchObject({
      messageAvailable: true,
      permalink: "https://slack.example/p1",
    });
    expect(by("communication.b")).toMatchObject({ messageAvailable: true, permalink: null });
    expect(by("communication.c")).toMatchObject({
      messageAvailable: false,
      sourceExternalRef: `ref-${gone}`,
      permalink: null,
    });
    // hard delete of the message row: ref still kept
    db.delete(schema.slackMessages).where(eq(schema.slackMessages.id, live)).run();
    expect(
      service.getProfile(personId)?.evidence.find((e) => e.observationKey === "communication.a"),
    ).toMatchObject({
      messageAvailable: false,
      sourceExternalRef: `ref-${live}`,
    });
  });
});

describe("failure paths", () => {
  test("unknown recommendation fails the approval with a content-free message", async () => {
    const a = engine.request(db, {
      action: "records.update",
      targetIntegration: "people",
      targetRef: personId,
      payload: { recommendationId: "nope" },
      riskLevel: "low",
      idempotencyKey: "k1",
      requestedByModule: "people",
    });
    const out = await approveAndRun(a.id);
    expect(out).toEqual({ status: "failed", result: { error: "recommendation not found" } });
  });

  test("invalid payload fails; a failed write rolls back everything", async () => {
    const bad = engine.request(db, {
      action: "records.update",
      targetIntegration: "people",
      targetRef: personId,
      payload: {},
      riskLevel: "low",
      idempotencyKey: "k2",
      requestedByModule: "people",
    });
    expect((await approveAndRun(bad.id)).result).toEqual({ error: "invalid approval payload" });

    // corrupt update diff on base 1 makes the write fail after nothing is committed
    await approveAndRun(store("initial", content({ communication: [obs("a")] })).approvalId);
    const u = store("update", { nonsense: true } as unknown as ProfileUpdateOutput, [], 1);
    const out = await approveAndRun(u.approvalId);
    expect(out.result).toEqual({ error: "profile write failed" });
    expect(recRow(u.id)?.status).toBe("pending");
    expect(db.select().from(schema.peopleProfileVersions).all()).toHaveLength(1);
    expect(service.getProfile(personId)?.version).toBe(1);
  });

  test("reject and expire update the recommendation; nothing else changes", () => {
    const r = store("initial", content({ communication: [obs("a")] }));
    engine.reject(r.approvalId, "no");
    dispatcher.dispatchOnce();
    expect(recRow(r.id)?.status).toBe("rejected");
    expect(db.select().from(schema.peopleProfiles).all()).toHaveLength(0);
    const decided = db
      .select()
      .from(schema.domainEvents)
      .where(eq(schema.domainEvents.type, "person.recommendation_decided"))
      .all();
    expect(decided.map((e) => e.payload)).toEqual([{ recommendationId: r.id, status: "rejected" }]);

    const e = store("initial", content({ communication: [obs("b")] }));
    db.update(schema.approvals)
      .set({ expiresAt: "2026-11-05T11:00:00.000Z" })
      .where(eq(schema.approvals.id, e.approvalId))
      .run();
    engine.expireDue();
    dispatcher.dispatchOnce();
    expect(recRow(e.id)?.status).toBe("expired");
  });

  test("rejections of other integrations are ignored", () => {
    const r = store("initial", content({ communication: [obs("a")] }));
    const other = engine.request(db, {
      action: "records.update",
      targetIntegration: "jira",
      targetRef: "X",
      payload: { recommendationId: r.id },
      riskLevel: "low",
      idempotencyKey: "other",
      requestedByModule: "x",
    });
    engine.reject(other.id, "no");
    expect(dispatcher.dispatchOnce().failed).toBe(0);
    expect(recRow(r.id)?.status).toBe("pending");
  });
});

describe("retryApply", () => {
  const failFirst = async () => {
    const r = store("initial", content({ communication: [obs("a")] }));
    // break the recommendation so apply fails, then repair it for the retry
    db.update(schema.peopleProfileRecommendations)
      .set({ content: { bad: 1 } })
      .where(eq(schema.peopleProfileRecommendations.id, r.id))
      .run();
    expect((await approveAndRun(r.approvalId)).status).toBe("failed");
    db.update(schema.peopleProfileRecommendations)
      .set({ content: content({ communication: [obs("a")] }) })
      .where(eq(schema.peopleProfileRecommendations.id, r.id))
      .run();
    return r;
  };

  test("fresh approval with key :2, then :3; the retry applies", async () => {
    const r = await failFirst();
    const { approvalId } = recs.retryApply(r.id);
    expect(recRow(r.id)?.approvalId).toBe(approvalId);
    const a = db.select().from(schema.approvals).where(eq(schema.approvals.id, approvalId)).get();
    expect(a?.idempotencyKey).toBe(`people.rec:${r.id}:2`);
    // not retryable while the new approval is pending
    expect(() => recs.retryApply(r.id)).toThrow(RetryNotAllowed);
    db.update(schema.peopleProfileRecommendations)
      .set({ content: { bad: 1 } })
      .where(eq(schema.peopleProfileRecommendations.id, r.id))
      .run();
    expect((await approveAndRun(approvalId)).status).toBe("failed");
    expect(recs.retryApply(r.id).approvalId).not.toBe(approvalId);
    expect(
      db
        .select()
        .from(schema.approvals)
        .where(eq(schema.approvals.id, recRow(r.id)?.approvalId ?? ""))
        .get()?.idempotencyKey,
    ).toBe(`people.rec:${r.id}:3`);
  });

  test("retry applies the profile once repaired", async () => {
    const r = await failFirst();
    const { approvalId } = recs.retryApply(r.id);
    expect((await approveAndRun(approvalId)).status).toBe("executed");
    expect(service.getProfile(personId)?.version).toBe(1);
    expect(recRow(r.id)?.status).toBe("applied");
  });

  test("refused for a pending approval, an unknown or a non-pending recommendation", async () => {
    const r = store("initial", content({ communication: [obs("a")] }));
    expect(() => recs.retryApply(r.id)).toThrow(RetryNotAllowed);
    expect(() => recs.retryApply("missing")).toThrow(RetryNotAllowed);
    await approveAndRun(r.approvalId);
    expect(() => recs.retryApply(r.id)).toThrow(RetryNotAllowed);
  });
});
