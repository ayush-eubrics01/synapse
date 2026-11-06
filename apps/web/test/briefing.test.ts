import { expect, test } from "bun:test";
import type { DashboardOverview } from "@synapse/contracts";
import { briefing } from "../lib/briefing";

const now = new Date("2026-11-06T10:00:00Z");
const synced = new Date(now.getTime() - 3 * 60_000).toISOString();

function overview(
  counts: Partial<DashboardOverview["counts"]> = {},
  over: Partial<DashboardOverview> = {},
): DashboardOverview {
  return {
    generatedAt: now.toISOString(),
    self: { slackUserId: "U1", name: "Ada" },
    counts: {
      urgent: 0,
      approvals: 0,
      outgoingAttention: 0,
      redFlags: 0,
      commitmentsToReview: 0,
      followupDrafts: 0,
      profileRecommendations: 0,
      peopleToEvaluate: 0,
      conversations: 0,
      jiraAttention: 0,
      brainReview: 0,
      engineeringAwaiting: 0,
      ...counts,
    },
    away: { on: false, highPriorityCount: 0 },
    lastSlackSyncAt: synced,
    health: { status: "ok", issues: [] },
    pipeline: [],
    upcoming: [],
    engineeringLock: null,
    ...over,
  } as DashboardOverview;
}

const started = { backfillStarted: true };

test("nothing to do", () => {
  expect(briefing(overview(), now, started)).toBe(
    "Nothing urgent. You're all caught up. Slack synced 3 min ago.",
  );
});

test("flag, commitment and two setup steps", () => {
  const o = overview({ redFlags: 1, commitmentsToReview: 1, peopleToEvaluate: 4 });
  expect(briefing(o, now, { backfillStarted: false })).toBe(
    "Nothing urgent. 1 red flag, 1 possible commitment and 2 setup steps waiting on you. Slack synced 3 min ago.",
  );
});

test("identity unconfirmed counts as a setup step", () => {
  const o = overview({}, { self: { slackUserId: null, name: null } });
  expect(briefing(o, now, started)).toBe(
    "Nothing urgent. 1 setup step waiting on you. Slack synced 3 min ago.",
  );
});

test("urgent count, order of parts and plurals", () => {
  const o = overview({
    urgent: 2,
    approvals: 2,
    outgoingAttention: 1,
    redFlags: 3,
    followupDrafts: 1,
    commitmentsToReview: 2,
    profileRecommendations: 1,
  });
  expect(briefing(o, now, started)).toBe(
    "2 urgent items. 2 messages awaiting approval, 1 send needs attention, 3 red flags, 1 follow-up draft, 2 possible commitments and 1 profile suggestion waiting on you. Slack synced 3 min ago.",
  );
  expect(briefing(overview({ urgent: 1 }), now, started)).toStartWith("1 urgent item. ");
});

test("never synced", () => {
  expect(briefing(overview({}, { lastSlackSyncAt: null }), now, started)).toBe(
    "Nothing urgent. You're all caught up. Slack hasn't synced yet.",
  );
});
