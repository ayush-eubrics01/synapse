import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AIProvider, DashboardOverview } from "@synapse/contracts";
import { schema } from "@synapse/database";
import { createApp } from "../../src/app";
import { type Container, createContainer } from "../../src/container";
import { loadConfig } from "../../src/core/config/config";

const fakeProvider: AIProvider = {
  execute: async () => {
    throw new Error("fake provider must not execute");
  },
  getHealth: async () => ({ status: "ok", version: "fake" }),
};
const NOW = "2026-11-06T12:00:00.000Z";
const SELF = "UGRACE0001";

let c: Container;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  c = createContainer(loadConfig({ SYNAPSE_DB_PATH: ":memory:" }), {
    run: async () => "Linger=no",
    provider: fakeProvider,
    clock: { now: () => new Date(NOW) },
  });
  app = createApp(c);
});
afterEach(() => c.sqlite.close());

const req = (path: string) => app.request(`http://127.0.0.1:7400${path}`);
const overview = async () =>
  (await (await req("/api/dashboard/overview")).json()) as DashboardOverview;

function seed(): void {
  const { db } = c;
  db.insert(schema.slackUsers).values({ id: "u-self", externalId: SELF, name: "Grace" }).run();
  db.insert(schema.slackUsers).values({ id: "u-ada", externalId: "UADA000001", name: "Ada" }).run();
  db.insert(schema.slackConversations)
    .values({ id: "c1", externalId: "C0SYNTH01", type: "channel", name: "ops" })
    .run();
  db.insert(schema.slackConversations)
    .values({ id: "c2", externalId: "D0SYNTH02", type: "im", name: null })
    .run();
  c.settings.set("slack.selfUserId", SELF);
  const msg = (id: string, conv: string, ts: string, extra: object = {}) =>
    db
      .insert(schema.slackMessages)
      .values({
        id,
        conversationId: conv,
        ts,
        senderUserId: "u-ada",
        text: "invented text",
        sentAt: NOW,
        collectedAt: NOW,
        ...extra,
      })
      .run();
  msg("m1", "c1", "1793880000.000100", { urgencyLevel: "high", urgencyReason: "outage" });
  msg("m2", "c1", "1793880001.000100");
  msg("m3", "c2", "1793880002.000100");
  db.insert(schema.approvals)
    .values({
      id: "a1",
      action: "slack.send",
      payload: {},
      riskLevel: "high",
      status: "pending",
      idempotencyKey: "k1",
      createdAt: NOW,
    })
    .run();
  db.insert(schema.securityFlags)
    .values({
      id: "f1",
      messageId: "m1",
      sourceExternalRef: "ref",
      slackUserId: "UADA000001",
      detector: "rules",
      ruleId: "r1",
      severity: "warning",
      excerpt: "invented",
      reason: "invented",
      status: "open",
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run();
  db.insert(schema.commitments)
    .values({
      id: "cm1",
      description: "invented commitment",
      ownerSlackUserId: SELF,
      direction: "mine",
      status: "open",
      reviewStatus: "pending_review",
      dedupKey: "d1",
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run();
  db.insert(schema.followups)
    .values({
      id: "fu1",
      origin: "manual",
      conversationId: "c1",
      draftText: "invented draft",
      status: "draft",
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run();
}

describe("GET /api/dashboard/overview", () => {
  test("empty database: zero counts, no identity, idle surface", async () => {
    const o = await overview();
    expect(o.self).toEqual({ slackUserId: null, name: null });
    expect(Object.values(o.counts).every((n) => n === 0)).toBe(true);
    expect(o.engineeringLock).toBeNull();
    expect(o.lastSlackSyncAt).toBeNull();
    expect(o.pipeline.map((s) => s.id)).toEqual(["collect", "screen", "assess", "surface"]);
    expect(o.pipeline.find((s) => s.id === "surface")?.state).toBe("idle");
    expect(o.pipeline.find((s) => s.id === "collect")?.state).toBe("waiting");
  });

  test("counts match the list endpoints", async () => {
    seed();
    const o = await overview();
    expect(o.generatedAt).toBe(NOW);
    expect(o.self).toEqual({ slackUserId: SELF, name: "Grace" });
    expect(o.counts).toMatchObject({
      urgent: 1,
      approvals: 1,
      outgoingAttention: 0,
      redFlags: 1,
      commitmentsToReview: 1,
      followupDrafts: 1,
      profileRecommendations: 0,
      conversations: 2,
    });
    // Each count equals what its list endpoint returns.
    const len = async (p: string) => ((await (await req(p)).json()) as unknown[]).length;
    expect(o.counts.urgent).toBe(await len("/api/urgent"));
    expect(o.counts.approvals).toBe(await len("/api/approvals?status=pending"));
    expect(o.counts.commitmentsToReview).toBe(await len("/api/commitments?filter=review"));
    expect(o.counts.followupDrafts).toBe(await len("/api/followups?status=draft"));
    expect(o.counts.profileRecommendations).toBe(await len("/api/people/recommendations"));
    const cand = (await (await req("/api/people/candidates")).json()) as { candidates: unknown[] };
    expect(o.counts.peopleToEvaluate).toBe(cand.candidates.length);
    const surface = o.pipeline.find((s) => s.id === "surface");
    expect(surface).toMatchObject({ state: "ok", summary: "1 urgent · 1 approvals" });
  });

  test("outgoingAttention counts needs_attention rows only", async () => {
    seed();
    c.db
      .insert(schema.approvals)
      .values({
        id: "a2",
        action: "slack.send",
        payload: {},
        riskLevel: "high",
        status: "executed",
        idempotencyKey: "k2",
        createdAt: NOW,
      })
      .run();
    c.db
      .insert(schema.outgoingMessages)
      .values({
        id: "o1",
        approvalId: "a2",
        conversationExternalId: "C0SYNTH01",
        text: "invented",
        status: "needs_attention",
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
    expect((await overview()).counts.outgoingAttention).toBe(1);
  });

  test("health.issues lists only non-ok checks with label and hint", async () => {
    const o = await overview();
    const report = await c.health.report();
    const notOk = Object.entries(report.checks).filter(([, r]) => r.status !== "ok");
    expect(o.health.status).toBe(report.status);
    expect(o.health.issues.map((i) => i.check).sort()).toEqual(notOk.map(([k]) => k).sort());
    // The injected `run` reports no linger, so that check must be an issue with its hint.
    const linger = o.health.issues.find((i) => i.check === "linger");
    expect(linger).toMatchObject({
      label: "Services after logout",
      hint: "Run `loginctl enable-linger $USER` so services keep running after logout.",
    });
    for (const i of o.health.issues) expect(i.status).not.toBe("ok");
  });

  test("an assess job that failed recently fails the assess stage", async () => {
    c.db
      .insert(schema.jobs)
      .values({
        id: "j1",
        type: "urgency.assess",
        status: "FAILED",
        idempotencyKey: "j1",
        runAfter: NOW,
        createdAt: NOW,
        finishedAt: NOW,
      })
      .run();
    const o = await overview();
    expect(o.pipeline.find((s) => s.id === "assess")?.state).toBe("failing");
  });
});

describe("GET /api/claude/status thresholds", () => {
  test("includes thresholds from settings even with no quota snapshot", async () => {
    const res = await req("/api/claude/status");
    const body = (await res.json()) as {
      quota: unknown;
      thresholds: { fiveHour: Record<string, number>; sevenDay: Record<string, number> };
    };
    expect(body.quota).toBeNull();
    expect(body.thresholds.fiveHour).toEqual({
      soft: c.settings.get("orchestrator.quota.fiveHour.soft"),
      hard: c.settings.get("orchestrator.quota.fiveHour.hard"),
      stop: c.settings.get("orchestrator.quota.fiveHour.stop"),
    });
    expect(Object.keys(body.thresholds.sevenDay).sort()).toEqual(["hard", "soft"]);
  });
});
