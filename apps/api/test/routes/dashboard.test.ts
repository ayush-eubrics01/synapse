import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import {
  type AIProvider,
  type DashboardOverview,
  SANDBOX_ROOT_MASKED_HINT,
} from "@synapse/contracts";
import { schema } from "@synapse/database";
import { createApp } from "../../src/app";
import { type Container, createContainer } from "../../src/container";
import { loadConfig } from "../../src/core/config/config";
import { resolveActions } from "../../src/modules/outgoing/urgent-reply";

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
    expect(o.engineeringLock).toEqual({ held: false });
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

  const commitment = (id: string, reviewStatus: "accepted" | "rejected") =>
    c.db
      .insert(schema.commitments)
      .values({
        id,
        description: "invented commitment",
        ownerSlackUserId: SELF,
        direction: "mine",
        status: "open",
        reviewStatus,
        dedupKey: id,
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();

  test("commitmentsToReview counts only pending_review rows (the Needs-you rule)", async () => {
    seed();
    commitment("cm-rejected", "rejected");
    commitment("cm-accepted", "accepted");
    expect((await overview()).counts.commitmentsToReview).toBe(1);
  });

  test("approvals excludes an approval decided on a pending profile suggestion", async () => {
    seed();
    c.db
      .insert(schema.people)
      .values({ id: "p-ada", slackUserId: "UADA000001", name: "Ada", createdAt: NOW })
      .run();
    c.db
      .insert(schema.approvals)
      .values({
        id: "a-profile",
        action: "people.profile.apply",
        payload: {},
        riskLevel: "low",
        status: "pending",
        idempotencyKey: "k-profile",
        createdAt: NOW,
      })
      .run();
    c.db
      .insert(schema.peopleProfileRecommendations)
      .values({
        id: "r1",
        personId: "p-ada",
        kind: "initial",
        content: {},
        status: "pending",
        approvalId: "a-profile",
        createdAt: NOW,
      })
      .run();
    const o = await overview();
    expect(o.counts.approvals).toBe(1);
    expect(o.counts.profileRecommendations).toBe(1);
    expect(o.pipeline.find((s) => s.id === "surface")?.summary).toBe("1 urgent · 1 approvals");
  });

  test("peopleToEvaluate counts only candidates with the evaluate action", async () => {
    seed();
    c.db
      .insert(schema.slackUsers)
      .values({ id: "u-linus", externalId: "ULINUS0001", name: "Linus" })
      .run();
    c.db
      .insert(schema.slackMessages)
      .values({
        id: "m-linus",
        conversationId: "c1",
        ts: "1793880003.000100",
        senderUserId: "u-linus",
        text: "invented text",
        sentAt: NOW,
        collectedAt: NOW,
      })
      .run();
    // Ada already has a profile, so only Linus can be evaluated.
    c.db
      .insert(schema.people)
      .values({ id: "p-ada", slackUserId: "UADA000001", name: "Ada", createdAt: NOW })
      .run();
    c.db
      .insert(schema.peopleProfiles)
      .values({ id: "pp-ada", personId: "p-ada", currentVersion: 1, content: {}, updatedAt: NOW })
      .run();
    const o = await overview();
    expect(o.counts.peopleToEvaluate).toBe(1);
  });

  test("peopleToEvaluate is 0 while identity is required", async () => {
    seed();
    c.settings.clear("slack.selfUserId");
    expect((await overview()).counts.peopleToEvaluate).toBe(0);
  });

  test("outgoingAttention counts needs_attention and unverified sends, as the feed does", async () => {
    seed();
    const rows: [string, string, string | null][] = [
      ["o1", "needs_attention", null],
      ["o2", "sent_unverified", "unverified"],
      ["o3", "sent_unverified", null],
      ["o4", "sent", null],
    ];
    for (const [id, status, failure] of rows) {
      c.db
        .insert(schema.approvals)
        .values({
          id: `a-${id}`,
          action: "slack.send",
          payload: {},
          riskLevel: "high",
          status: "executed",
          idempotencyKey: `k-${id}`,
          createdAt: NOW,
        })
        .run();
      c.db
        .insert(schema.outgoingMessages)
        .values({
          id,
          approvalId: `a-${id}`,
          conversationExternalId: "C0SYNTH01",
          text: "invented",
          status: status as "sent",
          failure,
          createdAt: NOW,
          updatedAt: NOW,
        })
        .run();
    }
    expect((await overview()).counts.outgoingAttention).toBe(2);
  });

  test("outgoingAttention matches the feed: every status x failure counts iff resolveActions is non-empty", async () => {
    seed();
    const statuses = [
      "pending",
      "sending",
      "sent_unverified",
      "sent",
      "failed",
      "needs_attention",
    ] as const;
    const failures = [null, "unverified", "other"];
    let expected = 0;
    let i = 0;
    for (const status of statuses) {
      for (const failure of failures) {
        i += 1;
        if (resolveActions(status, failure).length > 0) expected += 1;
        c.db
          .insert(schema.approvals)
          .values({
            id: `ax${i}`,
            action: "slack.send",
            payload: {},
            riskLevel: "high",
            status: "executed",
            idempotencyKey: `kx${i}`,
            createdAt: NOW,
          })
          .run();
        c.db
          .insert(schema.outgoingMessages)
          .values({
            id: `ox${i}`,
            approvalId: `ax${i}`,
            conversationExternalId: "C0SYNTH01",
            text: "invented",
            status,
            failure,
            createdAt: NOW,
            updatedAt: NOW,
          })
          .run();
      }
    }
    expect(expected).toBe(4);
    expect((await overview()).counts.outgoingAttention).toBe(expected);
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

  test("a degraded sandbox with run_root_masked carries the XDG_CACHE_HOME hint (H4.6)", async () => {
    c.sqlite.close();
    c = createContainer(loadConfig({ SYNAPSE_DB_PATH: ":memory:" }), {
      run: async () => "Linger=no",
      provider: fakeProvider,
      clock: { now: () => new Date(NOW) },
      which: (b) => `/usr/bin/${b}`,
      // The in-memory run root is `<scratch>-runs` under the OS temp dir, masked by this root.
      sandboxMaskedRoots: [tmpdir()],
    });
    app = createApp(c);
    const issue = (await overview()).health.issues.find((i) => i.check === "sandbox");
    expect(issue).toMatchObject({
      status: "degraded",
      detail: "run_root_masked",
      hint: SANDBOX_ROOT_MASKED_HINT,
    });
  });

  const job = (id: string, status: string, finishedAt: string | null, runAfter = NOW) =>
    c.db
      .insert(schema.jobs)
      .values({
        id,
        type: "urgency.assess",
        status: status as "FAILED",
        idempotencyKey: id,
        runAfter,
        createdAt: finishedAt ?? NOW,
        finishedAt,
      })
      .run();
  const assess = async () => (await overview()).pipeline.find((s) => s.id === "assess");

  test("an assess job in RETRY counts as waiting, even before its runAfter", async () => {
    job("j-retry", "RETRY", null, "2026-11-06T12:05:00.000Z");
    expect(await assess()).toMatchObject({ state: "waiting", summary: "1 waiting" });
  });

  test("an assess job in NEEDS_ATTENTION fails the assess stage", async () => {
    job("j-na", "NEEDS_ATTENTION", NOW);
    expect(await assess()).toMatchObject({
      state: "failing",
      summary: "1 failed in the last 24 h",
    });
  });

  test("a failure older than 24 h is ignored", async () => {
    job("j-old", "FAILED", "2026-11-05T11:59:00.000Z");
    expect(await assess()).toMatchObject({ state: "ok", summary: "up to date" });
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
