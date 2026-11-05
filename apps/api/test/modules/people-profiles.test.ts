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
import {
  DiscardNotAllowed,
  ProfileRecommendations,
  RecommendationNotFound,
  RetryNotAllowed,
} from "../../src/modules/people/recommendations";
import { PeopleService } from "../../src/modules/people/service";

const NOW = "2026-11-05T12:00:00.000Z";
const SECRET = "SECRET-PROFILE-TEXT";

let db: ReturnType<typeof openDatabase>["db"];
let clock: FakeClock;
let engine: ApprovalEngine;
let permissions: PermissionManager;
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
  permissions = new PermissionManager(db, audit);
  engine = new ApprovalEngine(db, clock, events, audit, permissions);
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
    expect(() => recs.retryApply("missing")).toThrow(RecommendationNotFound);
    await approveAndRun(r.approvalId);
    expect(() => recs.retryApply(r.id)).toThrow(RetryNotAllowed);
  });
});

const versionEvidence = (version: number) => {
  const v = db
    .select()
    .from(schema.peopleProfileVersions)
    .all()
    .find((x) => x.version === version);
  return db
    .select()
    .from(schema.peopleProfileEvidence)
    .where(eq(schema.peopleProfileEvidence.versionId, v?.id ?? "none"))
    .all()
    .map((e) => `${e.observationKey}:${e.messageId}`)
    .sort();
};

describe("evidence carry-over", () => {
  test("a modified key takes the recommendation's evidence, not the old; no duplicates", async () => {
    const [m1, m2, m3] = [message(), message(), message()];
    await approveAndRun(
      store("initial", content({ communication: [obs("a"), obs("k")] }), [
        { key: "communication.a", messageId: m1 },
        { key: "communication.k", messageId: m2 },
      ]).approvalId,
    );
    const u = store(
      "update",
      diff({
        remove: [{ section: "communication", key: "k", evidence: ["m"] }],
        add: [addDiff("communication", "k")],
      }),
      [{ key: "communication.k", messageId: m3 }],
      1,
    );
    await approveAndRun(u.approvalId);
    expect(versionEvidence(2)).toEqual([`communication.a:${m1}`, `communication.k:${m3}`]);
    expect(versionEvidence(1)).toEqual([`communication.a:${m1}`, `communication.k:${m2}`]);
  });

  test("v1 -> v2 -> v3 carries untouched evidence through both steps", async () => {
    const [m1, m2, m3] = [message(), message(), message()];
    await approveAndRun(
      store("initial", content({ communication: [obs("a")] }), [
        { key: "communication.a", messageId: m1 },
      ]).approvalId,
    );
    await approveAndRun(
      store(
        "update",
        diff({ add: [addDiff("communication", "b")] }),
        [{ key: "communication.b", messageId: m2 }],
        1,
      ).approvalId,
    );
    await approveAndRun(
      store(
        "update",
        diff({ add: [addDiff("communication", "c")] }),
        [{ key: "communication.c", messageId: m3 }],
        2,
      ).approvalId,
    );
    expect(versionEvidence(3)).toEqual([
      `communication.a:${m1}`,
      `communication.b:${m2}`,
      `communication.c:${m3}`,
    ]);
    expect(service.getProfile(personId)?.evidence).toHaveLength(3);
  });

  test("an update copies recommendation evidence only for changed keys", async () => {
    const [m1, m2] = [message(), message()];
    await approveAndRun(
      store("initial", content({ communication: [obs("a")] }), [
        { key: "communication.a", messageId: m1 },
      ]).approvalId,
    );
    // stray evidence on the update for an untouched key must not duplicate the carried row
    const u = store(
      "update",
      diff({ add: [addDiff("communication", "b")] }),
      [
        { key: "communication.b", messageId: m2 },
        { key: "communication.a", messageId: m2 },
      ],
      1,
    );
    await approveAndRun(u.approvalId);
    expect(versionEvidence(2)).toEqual([`communication.a:${m1}`, `communication.b:${m2}`]);
  });
});

describe("atomicity after writes", () => {
  const counts = () => ({
    versions: db.select().from(schema.peopleProfileVersions).all().length,
    evidence: db.select().from(schema.peopleProfileEvidence).all().length,
    profile: JSON.stringify(service.getProfile(personId)),
  });

  test("a failure after the profile write rolls everything back; retry works once fixed", async () => {
    const m = message();
    const first = store("initial", content({ communication: [obs("a")] }), [
      { key: "communication.a", messageId: m },
    ]);
    await approveAndRun(first.approvalId);
    const u = store(
      "update",
      diff({ add: [addDiff("communication", "b")] }),
      [{ key: "communication.b", messageId: m }],
      1,
    );
    const profileId = db.select().from(schema.peopleProfiles).get()?.id ?? "";
    // a conflicting version 2 makes the version insert fail after the profile row was updated
    db.insert(schema.peopleProfileVersions)
      .values({
        id: "blocker",
        profileId,
        version: 2,
        content: content(),
        recommendationId: first.id,
        createdAt: NOW,
      })
      .run();
    const before = counts();
    const out = await approveAndRun(u.approvalId);
    expect(out).toEqual({ status: "failed", result: { error: "profile write failed" } });
    expect(counts()).toEqual(before);
    expect(db.select().from(schema.peopleProfiles).get()?.currentVersion).toBe(1);
    expect(recRow(u.id)?.status).toBe("pending");
    expect(
      db
        .select()
        .from(schema.domainEvents)
        .where(eq(schema.domainEvents.type, "person.profile_approved"))
        .all(),
    ).toHaveLength(1);

    // retry path: still blocked -> fails again with nothing written
    const r1 = recs.retryApply(u.id);
    expect((await approveAndRun(r1.approvalId)).status).toBe("failed");
    expect(counts()).toEqual(before);
    expect(recRow(u.id)?.status).toBe("pending");

    db.delete(schema.peopleProfileVersions)
      .where(eq(schema.peopleProfileVersions.id, "blocker"))
      .run();
    const r2 = recs.retryApply(u.id);
    expect((await approveAndRun(r2.approvalId)).status).toBe("executed");
    expect(service.getProfile(personId)?.version).toBe(2);
    expect(recRow(u.id)?.status).toBe("applied");
  });
});

describe("decisions and kinds", () => {
  test("suggest_evaluation is superseded and skipped, never failed", async () => {
    const id = "rec-se";
    db.insert(schema.peopleProfileRecommendations)
      .values({ id, personId, kind: "suggest_evaluation", status: "pending", createdAt: NOW })
      .run();
    const a = engine.request(db, {
      action: "records.update",
      targetIntegration: "people",
      targetRef: personId,
      payload: { recommendationId: id },
      riskLevel: "low",
      idempotencyKey: "se",
      requestedByModule: "people",
    });
    const out = await approveAndRun(a.id);
    expect(out.status).toBe("executed");
    expect(out.result).toEqual({ status: "skipped", reason: "unsupported_kind" });
    expect(recRow(id)?.status).toBe("superseded");
  });

  test("re-delivered reject is a no-op; reject never touches an applied recommendation", async () => {
    const r = store("initial", content({ communication: [obs("a")] }));
    engine.reject(r.approvalId, "no");
    dispatcher.dispatchOnce();
    const decidedAt = recRow(r.id)?.decidedAt;
    const count = () =>
      db
        .select()
        .from(schema.domainEvents)
        .where(eq(schema.domainEvents.type, "person.recommendation_decided"))
        .all();
    expect(count()).toHaveLength(1);
    expect(count()[0]?.aggregateId).toBe(personId);
    // simulate redelivery of the same event
    db.update(schema.domainEvents)
      .set({ dispatchedAt: null })
      .where(eq(schema.domainEvents.type, "approval.rejected"))
      .run();
    db.delete(schema.eventConsumptions).run();
    dispatcher.dispatchOnce();
    expect(count()).toHaveLength(1);
    expect(recRow(r.id)?.decidedAt).toBe(decidedAt ?? null);

    const ok = store("initial", content({ communication: [obs("z")] }));
    // personId has no profile yet, so this applies
    await approveAndRun(ok.approvalId);
    expect(recRow(ok.id)?.status).toBe("applied");
    db.update(schema.approvals)
      .set({ status: "approved" })
      .where(eq(schema.approvals.id, ok.approvalId))
      .run();
    // force a rejected event for the applied recommendation's approval
    db.insert(schema.domainEvents)
      .values({
        id: "forced",
        type: "approval.rejected",
        version: 1,
        aggregateType: "approval",
        aggregateId: ok.approvalId,
        correlationId: "c",
        payload: { approvalId: ok.approvalId },
        occurredAt: NOW,
      })
      .run();
    dispatcher.dispatchOnce();
    expect(recRow(ok.id)?.status).toBe("applied");
  });
});

describe("R6: stuck recommendations", () => {
  const HOUR = 3_600_000;
  const decided = () =>
    db
      .select()
      .from(schema.domainEvents)
      .where(eq(schema.domainEvents.type, "person.recommendation_decided"))
      .all()
      .map((e) => e.payload);
  const initial = () => store("initial", content({ communication: [obs("a")] }));
  const expectDiscarded = (id: string) => {
    expect(recRow(id)).toMatchObject({ status: "rejected", reason: "discarded", decidedAt: NOW });
    expect(decided()).toContainEqual({ recommendationId: id, status: "rejected" });
  };

  test("(a) a revoked approval rejects the recommendation with reason revoked", () => {
    const r = initial();
    engine.approve(r.approvalId);
    engine.revoke(r.approvalId, "changed my mind");
    dispatcher.dispatchOnce();
    expect(recRow(r.id)).toMatchObject({ status: "rejected", reason: "revoked" });
    expect(decided()).toEqual([{ recommendationId: r.id, status: "rejected" }]);
  });

  test("(b) discard: revoked, rejected and expired approvals whose decision never landed", () => {
    // no dispatch: the decision consumer never ran (or failed), so each stays pending
    const revoked = initial();
    engine.approve(revoked.approvalId);
    engine.revoke(revoked.approvalId, "x");
    const rejected = store("initial", content({ communication: [obs("b")] }));
    engine.reject(rejected.approvalId, "x");
    const expired = store("initial", content({ communication: [obs("c")] }));
    db.update(schema.approvals)
      .set({ expiresAt: "2026-11-05T11:00:00.000Z" })
      .where(eq(schema.approvals.id, expired.approvalId))
      .run();
    engine.expireDue();
    for (const r of [revoked, rejected, expired]) {
      expect(recRow(r.id)?.status).toBe("pending");
      expect(recs.canDiscard(r.id)).toBe(true);
      recs.discard(r.id);
      expectDiscarded(r.id);
    }
  });

  test("(b) discard: a failed apply can be discarded instead of retried", async () => {
    const r = initial();
    db.update(schema.peopleProfileRecommendations)
      .set({ content: { bad: 1 } })
      .where(eq(schema.peopleProfileRecommendations.id, r.id))
      .run();
    expect((await approveAndRun(r.approvalId)).status).toBe("failed");
    recs.discard(r.id);
    expectDiscarded(r.id);
    expect(() => recs.retryApply(r.id)).toThrow(RetryNotAllowed);
  });

  test("(b) discard: permission tightened after approve leaves it approved; discardable after 1 hour", async () => {
    const r = initial();
    engine.approve(r.approvalId);
    permissions.setOverride("records.update", "denied");
    expect((await engine.execute(r.approvalId)).status).toBe("skipped");
    expect(recRow(r.id)?.status).toBe("pending");
    expect(recs.canDiscard(r.id)).toBe(false);
    expect(() => recs.discard(r.id)).toThrow(DiscardNotAllowed);
    clock.advance(HOUR + 1);
    expect(recs.canDiscard(r.id)).toBe(true);
    recs.discard(r.id);
    expect(recRow(r.id)).toMatchObject({ status: "rejected", reason: "discarded" });
  });

  test("(b) discard: a crash after the claim (execution started, never finished)", () => {
    const r = initial();
    engine.approve(r.approvalId);
    db.update(schema.approvals)
      .set({ executionStartedAt: NOW })
      .where(eq(schema.approvals.id, r.approvalId))
      .run();
    clock.advance(HOUR + 1);
    recs.discard(r.id);
    expect(recRow(r.id)).toMatchObject({ status: "rejected", reason: "discarded" });
  });

  test("(b) discard refused: pending approval, fresh approval, applied, suggestion; 404 unknown", async () => {
    const r = initial();
    expect(() => recs.discard(r.id)).toThrow(DiscardNotAllowed);
    engine.approve(r.approvalId);
    expect(() => recs.discard(r.id)).toThrow(DiscardNotAllowed);
    await engine.execute(r.approvalId);
    expect(recRow(r.id)?.status).toBe("applied");
    clock.advance(HOUR + 1);
    expect(() => recs.discard(r.id)).toThrow(DiscardNotAllowed);
    db.insert(schema.peopleProfileRecommendations)
      .values({
        id: "sug",
        personId,
        kind: "suggest_evaluation",
        status: "pending",
        createdAt: NOW,
      })
      .run();
    expect(() => recs.discard("sug")).toThrow(DiscardNotAllowed);
    expect(() => recs.discard("missing")).toThrow(RecommendationNotFound);
    expect(recRow(r.id)?.status).toBe("applied");
  });

  test("(c) a failing decision rolls back in a savepoint and logs the id and error class only", () => {
    const broken = new OutboxDispatcher(db, clock, new LiveBus());
    const failing = new EventPublisher(clock);
    const publish = failing.publish.bind(failing);
    failing.publish = ((tx, e) => {
      if (e.type === "person.recommendation_decided") throw new TypeError(`leak ${SECRET}`);
      return publish(tx, e);
    }) as EventPublisher["publish"];
    const other = new ApprovalEngine(
      db,
      clock,
      new EventPublisher(clock),
      new AuditLogger(clock),
      new PermissionManager(db, new AuditLogger(clock)),
    );
    new ProfileService({ db, clock, events: failing, audit: new AuditLogger(clock) }).register(
      other,
      broken,
    );
    const r = initial();
    engine.reject(r.approvalId, "no");
    const errs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => errs.push(a.join(" "));
    try {
      expect(broken.dispatchOnce().failed).toBe(0);
    } finally {
      console.error = orig;
    }
    // nothing half-written: the status update rolled back with the failed publish
    expect(recRow(r.id)).toMatchObject({ status: "pending", decidedAt: null });
    expect(errs.join("\n")).toContain(`approval=${r.approvalId}`);
    expect(errs.join("\n")).toContain("error=TypeError");
    expect(errs.join("\n")).not.toContain(SECRET);
    // and the user can clear it
    recs.discard(r.id);
    expect(recRow(r.id)).toMatchObject({ status: "rejected", reason: "discarded" });
  });
});
