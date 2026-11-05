import { afterEach, beforeEach, expect, test } from "bun:test";
import type {
  AIProvider,
  CandidatesResponse,
  PersonDetail,
  ProfileContent,
  ProfileUpdateOutput,
  RecommendationView,
} from "@synapse/contracts";
import { schema } from "@synapse/database";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app";
import { type Container, createContainer } from "../src/container";
import { loadConfig } from "../src/core/config/config";

const fakeProvider: AIProvider = {
  execute: async () => {
    throw new Error("fake provider must not execute");
  },
  getHealth: async () => ({ status: "ok", version: "fake" }),
};
const NOW = "2026-11-05T12:00:00.000Z";
const THEM = "UTHEM00001";
const SECRET = "SECRET-PROFILE-TEXT";

let c: Container;
let app: ReturnType<typeof createApp>;
let seq = 0;

beforeEach(() => {
  seq = 0;
  c = createContainer(loadConfig({ SYNAPSE_DB_PATH: ":memory:" }), {
    run: async () => "Linger=yes",
    provider: fakeProvider,
  });
  app = createApp(c);
  c.db.insert(schema.slackUsers).values({ id: "u1", externalId: THEM, name: "Grace" }).run();
  c.db.insert(schema.slackConversations).values({ id: "c1", externalId: "C1", type: "im" }).run();
});
afterEach(() => c.sqlite.close());

const req = (path: string, init?: RequestInit) => app.request(`http://127.0.0.1:7400${path}`, init);
const send = (method: string, path: string, body?: unknown) =>
  req(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const json = async <T>(path: string): Promise<T> => (await req(path)).json() as Promise<T>;

const personId = () => c.db.transaction((tx) => c.people.ensurePerson(tx, THEM));
const content = (p: Partial<ProfileContent> = {}): ProfileContent => ({
  professionalContext: [],
  communication: [],
  responseGuidelines: [],
  ...p,
});
const obs = (key: string) => ({
  key,
  text: `${SECRET} ${key}`,
  evidence: ["m"],
  confidence: "high" as const,
});

function message(permalink: string | null = null): string {
  seq += 1;
  const id = `m${seq}`;
  c.db
    .insert(schema.slackMessages)
    .values({
      id,
      conversationId: "c1",
      ts: `${seq}.0`,
      senderUserId: "u1",
      text: "hello",
      permalink,
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
  const pid = personId();
  const id = `rec-${++seq}`;
  const approval = c.db.transaction((tx) => {
    tx.insert(schema.peopleProfileRecommendations)
      .values({
        id,
        personId: pid,
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
    const a = c.approvals.request(tx, {
      action: "records.update",
      targetIntegration: "people",
      targetRef: pid,
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
  c.db
    .select()
    .from(schema.peopleProfileRecommendations)
    .where(eq(schema.peopleProfileRecommendations.id, id))
    .get();

test("candidates: identity null reports identityRequired and no candidates", async () => {
  const body = await json<CandidatesResponse>("/api/people/candidates");
  expect(body).toEqual({ identityRequired: true, candidates: [] });
});

test("candidates: ranked, with the evaluate action only for people without profile or pending", async () => {
  c.settings.set("slack.selfUserId", "USELF00001");
  c.db.insert(schema.slackUsers).values({ id: "us", externalId: "USELF00001", name: "Me" }).run();
  message();
  const body = await json<CandidatesResponse>("/api/people/candidates?limit=5");
  expect(body.identityRequired).toBe(false);
  expect(body.candidates.map((x) => x.slackUserId)).toEqual([THEM]);
  expect(body.candidates[0]?.actions).toEqual(["evaluate"]);
  store("initial", content());
  const after = await json<CandidatesResponse>("/api/people/candidates");
  expect(after.candidates[0]?.actions).toEqual([]);
});

test("evaluate: 202 and one job, then queued:false; identity and unknown user paths", async () => {
  const noId = await send("POST", `/api/people/${THEM}/evaluate`);
  expect(noId.status).toBe(202);
  expect(await noId.json()).toEqual({ queued: false, reason: "identity_required" });

  c.settings.set("slack.selfUserId", "USELF00001");
  const first = await send("POST", `/api/people/${THEM}/evaluate`);
  expect(first.status).toBe(202);
  expect(await first.json()).toEqual({ queued: true });
  const second = await send("POST", `/api/people/${THEM}/evaluate`);
  expect(await second.json()).toEqual({ queued: false, reason: "already_run_today" });
  expect(
    c.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.type, "people.generate_initial_profile"))
      .all().length,
  ).toBe(1);

  store("initial", content());
  const pending = await send("POST", `/api/people/${THEM}/evaluate`);
  expect(await pending.json()).toEqual({ queued: false, reason: "pending_recommendation" });

  expect((await send("POST", "/api/people/UNKNOWN0001/evaluate")).status).toBe(404);
  expect((await send("POST", "/api/people/lower/evaluate")).status).toBe(400);
});

test("profile: expired evidence is unavailable without permalink; permalink only for http(s)", async () => {
  const good = message("https://x.slack.com/p1");
  const bad = message("javascript:alert(1)");
  const gone = message("https://x.slack.com/p3");
  const { id, approvalId } = store(
    "initial",
    content({ professionalContext: [obs("a"), obs("b"), obs("c")] }),
    [
      { key: "professionalContext.a", messageId: good },
      { key: "professionalContext.b", messageId: bad },
      { key: "professionalContext.c", messageId: gone },
    ],
  );
  const approval = c.approvals.listPending().find((a) => a.id === approvalId);
  if (!approval) throw new Error("approval missing");
  c.profileStore.apply(approval);
  expect(recRow(id)?.status).toBe("applied");
  c.db.delete(schema.slackMessages).where(eq(schema.slackMessages.id, gone)).run();

  const detail = await json<PersonDetail>(`/api/people/${THEM}/profile`);
  expect(detail.profile?.version).toBe(1);
  expect(detail.versions.map((v) => v.version)).toEqual([1]);
  expect(detail.flagCount).toBe(0);
  expect(detail.actions).toEqual([]);
  // Evidence with equal timestamps has no defined order; look rows up by observation key.
  const ev = new Map((detail.profile?.evidence ?? []).map((e) => [e.observationKey, e]));
  const view = (k: string) => [ev.get(k)?.messageAvailable, ev.get(k)?.permalink];
  expect(view("professionalContext.a")).toEqual([true, "https://x.slack.com/p1"]);
  expect(view("professionalContext.b")).toEqual([true, null]);
  expect(view("professionalContext.c")).toEqual([false, null]);
  expect(ev.get("professionalContext.c")?.sourceExternalRef).toBe(`ref-${gone}`);
  expect((await req("/api/people/UNKNOWN0001/profile")).status).toBe(404);
});

test("profile: a known user without profile gets the evaluate action", async () => {
  const detail = await json<PersonDetail>(`/api/people/${THEM}/profile`);
  expect(detail.profile).toBeNull();
  expect(detail.priority).toBe("normal");
  expect(detail.actions).toEqual(["evaluate"]);
});

test("recommendations: initial proposed sections and update diff with evidence and actions", async () => {
  const m1 = message();
  const init = store("initial", content({ communication: [obs("brief")] }), [
    { key: "communication.brief", messageId: m1 },
  ]);
  const list = await json<RecommendationView[]>("/api/people/recommendations?status=pending");
  expect(list).toHaveLength(1);
  const r = list[0] as RecommendationView;
  expect(r.id).toBe(init.id);
  expect(r.proposed?.[0]).toMatchObject({
    section: "communication",
    key: "brief",
    confidence: "high",
  });
  expect(r.proposed?.[0]?.evidence[0]).toMatchObject({ messageAvailable: true });
  expect(r.diff).toBeNull();
  expect(r.approvalId).toBe(init.approvalId);
  expect(r.approvalStatus).toBe("pending");
  expect(r.actions).toEqual(["approve", "reject"]);
  expect(r.person).toEqual({ slackUserId: THEM, name: "Grace" });

  // apply it, then store an update that removes "brief" and adds "async"
  const approval = c.approvals.listPending().find((a) => a.id === init.approvalId);
  if (!approval) throw new Error("approval missing");
  c.profileStore.apply(approval);
  const m2 = message();
  const diff: ProfileUpdateOutput = {
    add: [{ section: "communication", ...obs("async") }],
    remove: [{ section: "communication", key: "brief", evidence: ["m"] }],
    suspectedInjection: { detected: false, severity: "info", quote: "", reason: "" },
  };
  store("update", diff, [{ key: "communication.async", messageId: m2 }], 1);
  const upd = (await json<RecommendationView[]>("/api/people/recommendations"))[0];
  expect(upd?.kind).toBe("update");
  expect(upd?.baseVersion).toBe(1);
  expect(upd?.diff?.added.map((o) => o.key)).toEqual(["async"]);
  expect(upd?.diff?.added[0]?.evidence).toHaveLength(1);
  expect(upd?.diff?.removed[0]).toMatchObject({ key: "brief", text: `${SECRET} brief` });
  expect(upd?.proposed).toBeNull();
});

test("recommendations: a failed approval offers retry only, and retry-apply issues a new approval", async () => {
  const { id, approvalId } = store("initial", content({ communication: [obs("x")] }));
  expect((await send("POST", `/api/people/recommendations/${id}/retry-apply`)).status).toBe(409);
  c.db
    .update(schema.approvals)
    .set({ status: "failed" })
    .where(eq(schema.approvals.id, approvalId))
    .run();
  const r = (await json<RecommendationView[]>("/api/people/recommendations"))[0];
  expect(r?.approvalStatus).toBe("failed");
  expect(r?.actions).toEqual(["retry"]);
  const res = await send("POST", `/api/people/recommendations/${id}/retry-apply`);
  expect(res.status).toBe(200);
  const { approvalId: next } = (await res.json()) as { approvalId: string };
  expect(next).not.toBe(approvalId);
  const after = (await json<RecommendationView[]>("/api/people/recommendations"))[0];
  expect(after?.approvalId).toBe(next);
  expect(after?.actions).toEqual(["approve", "reject"]);
  expect((await send("POST", "/api/people/recommendations/nope/retry-apply")).status).toBe(409);
});

test("accept-suggestion: only a pending suggest_evaluation; marks applied and queues once", async () => {
  c.settings.set("slack.selfUserId", "USELF00001");
  const sugId = c.db.transaction((tx) => c.profiles.storeSuggestion(tx, THEM, "talks a lot"));
  if (!sugId) throw new Error("no suggestion");
  const listed = (await json<RecommendationView[]>("/api/people/recommendations"))[0];
  expect(listed).toMatchObject({
    kind: "suggest_evaluation",
    reason: "talks a lot",
    actions: ["evaluate"],
  });

  const res = await send("POST", `/api/people/recommendations/${sugId}/accept-suggestion`);
  expect(await res.json()).toEqual({ queued: true });
  expect(recRow(sugId)?.status).toBe("applied");
  expect(recRow(sugId)?.decidedAt).not.toBeNull();
  expect(
    c.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.type, "people.generate_initial_profile"))
      .all(),
  ).toHaveLength(1);
  expect(
    (await send("POST", `/api/people/recommendations/${sugId}/accept-suggestion`)).status,
  ).toBe(409);
});

test("accept-suggestion: 409 for other kinds, 404 unknown, and no identity keeps it pending", async () => {
  const init = store("initial", content());
  expect(
    (await send("POST", `/api/people/recommendations/${init.id}/accept-suggestion`)).status,
  ).toBe(409);
  expect(recRow(init.id)?.status).toBe("pending");
  expect((await send("POST", "/api/people/recommendations/nope/accept-suggestion")).status).toBe(
    404,
  );

  c.db
    .update(schema.peopleProfileRecommendations)
    .set({ status: "rejected" })
    .where(eq(schema.peopleProfileRecommendations.id, init.id))
    .run();
  const sugId = c.db.transaction((tx) => c.profiles.storeSuggestion(tx, THEM, "r"));
  const res = await send("POST", `/api/people/recommendations/${sugId}/accept-suggestion`);
  expect(await res.json()).toEqual({ queued: false, reason: "identity_required" });
  expect(recRow(sugId as string)?.status).toBe("pending");
});

test("validation: limit, status, ids and reject reason length", async () => {
  expect((await req("/api/people/candidates?limit=0")).status).toBe(400);
  expect((await req("/api/people/candidates?limit=101")).status).toBe(400);
  expect((await req("/api/people/candidates?limit=100")).status).toBe(200);
  expect((await req("/api/people/recommendations?status=bogus")).status).toBe(400);
  expect((await req("/api/people/u123/profile")).status).toBe(400);
  const long = "x".repeat(65);
  expect((await send("POST", `/api/people/recommendations/${long}/accept-suggestion`)).status).toBe(
    400,
  );
  expect((await send("POST", `/api/people/recommendations/${long}/retry-apply`)).status).toBe(400);
  const { approvalId } = store("initial", content());
  const tooLong = await send("POST", `/api/approvals/${approvalId}/reject`, {
    reason: "x".repeat(501),
  });
  expect(tooLong.status).toBe(400);
  const ok = await send("POST", `/api/approvals/${approvalId}/reject`, { reason: "x".repeat(500) });
  expect(ok.status).toBe(200);
});
