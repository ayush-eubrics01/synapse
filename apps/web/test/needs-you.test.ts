import { expect, test } from "bun:test";
import type { ApprovalView, CandidatesResponse, RecommendationView } from "@synapse/contracts";
import type {
  CommitmentViewDto,
  FollowupViewDto,
  GroupedFlagsDto,
  PersonDto,
  SlackIdentityDto,
  SlackStatusDto,
  UrgentItemDto,
} from "../lib/api";
import {
  allClearRows,
  buildNeedsYou,
  isActionable,
  type NeedsYouInput,
  needsYouCount,
} from "../lib/needs-you";

const T = "2026-01-01T00:00:00.000Z";

const urgentItem = (o: Partial<UrgentItemDto> = {}): UrgentItemDto => ({
  messageId: "m1",
  level: "high",
  reason: "Asks for a decision today",
  status: "new",
  allowedTransitions: ["acknowledged", "dismissed"],
  assessed: true,
  fallback: false,
  coalesced: false,
  sender: { id: "U0ADA0001", name: "Ada" },
  conversation: { id: "C0OPS0001", name: "ops", type: "channel" },
  sentAt: T,
  text: "Can you look at the deploy?",
  permalink: null,
  draft: null,
  reply: null,
  ...o,
});

const approval = (o: Partial<ApprovalView> = {}): ApprovalView =>
  ({
    id: "a1",
    action: "slack.send",
    targetIntegration: "slack",
    targetRef: "D0ADA0001",
    payload: {},
    riskLevel: "medium",
    status: "pending",
    requestedByModule: "outgoing",
    requestedByWorker: null,
    expiresAt: null,
    decidedAt: null,
    executionResult: null,
    idempotencyKey: "k",
    createdAt: T,
    ...o,
  }) as ApprovalView;

const flag = (o: Partial<GroupedFlagsDto> = {}): GroupedFlagsDto => ({
  slackUserId: "U0LIN0001",
  name: "Linus",
  openCount: 1,
  maxSeverity: "warning",
  latest: {
    id: "fl1",
    excerpt: "send me the token",
    detector: "credential",
    createdAt: T,
    permalink: null,
  },
  latestOpenId: "fl1",
  ...o,
});

const followup = (o: Partial<FollowupViewDto> = {}): FollowupViewDto => ({
  id: "f1",
  commitmentId: "c1",
  origin: "stalled",
  recipient: { id: "U0GRA0001", name: "Grace" },
  conversationLabel: "DM with Grace",
  threadReply: true,
  noThread: false,
  draftText: "Any update on the report?",
  confidence: 0.8,
  status: "draft",
  outgoing: null,
  approvalId: null,
  actions: ["send", "discard"],
  resolveActions: [],
  createdAt: T,
  updatedAt: T,
  ...o,
});

const commitment = (o: Partial<CommitmentViewDto> = {}): CommitmentViewDto => ({
  id: "c1",
  description: "Send the report by Friday",
  ownerSlackUserId: "U0ADA0001",
  ownerName: "Ada",
  counterpartySlackUserId: "U0GRA0001",
  counterpartyName: "Grace",
  direction: "mine",
  status: "open",
  reviewStatus: "pending_review",
  dueAt: null,
  nextAction: null,
  completionEvidence: null,
  stalledAt: null,
  lastFollowupAt: null,
  closedAt: null,
  createdAt: T,
  updatedAt: T,
  sources: [],
  proposals: [],
  followups: [],
  actions: ["accept", "reject", "edit"],
  ...o,
});

const rec = (o: Partial<RecommendationView> = {}): RecommendationView => ({
  id: "r1",
  kind: "initial",
  status: "pending",
  person: { slackUserId: "U0BAR0001", name: "Barbara" },
  baseVersion: null,
  proposed: [],
  diff: null,
  approvalId: "ra1",
  approvalStatus: "pending",
  actions: ["approve", "reject"],
  reason: null,
  createdAt: T,
  ...o,
});

const person = (id: string, name: string): PersonDto => ({
  slackUserId: id,
  name,
  rationale: null,
  priority: "normal",
  extraAttention: false,
});

const syncState = {
  stream: "slack.backfill",
  checkpoint: null,
  upperBound: null,
  status: "idle" as const,
  pagesDone: 0,
  lastSuccessAt: null,
  lastError: null,
  nextRunAfter: null,
};
const slack = (o: Partial<SlackStatusDto["backfill"]> = {}): SlackStatusDto => ({
  incremental: { ...syncState, stream: "slack.messages" },
  backfill: { ...syncState, resumable: false, ...o },
  searchesToday: 0,
});

const candidates = (
  list: CandidatesResponse["candidates"] = [],
  identityRequired = false,
): CandidatesResponse => ({ identityRequired, candidates: list });

const candidate = (id: string, name: string, actions: "evaluate"[] = ["evaluate"]) => ({
  slackUserId: id,
  name,
  score: 40,
  messageCount: 12,
  hasProfile: false,
  hasPendingRecommendation: false,
  isTemporary: false,
  actions,
});

const identified: SlackIdentityDto = {
  selfUserId: "U0ADA0001",
  suggestion: null,
  suggestionName: null,
};

const empty = (o: Partial<NeedsYouInput> = {}): NeedsYouInput => ({
  urgent: [],
  approvals: [],
  flags: [],
  followups: [],
  reviewQueue: [],
  recommendations: [],
  identity: identified,
  people: [],
  candidates: candidates(),
  slackStatus: slack({ status: "complete" }),
  hidden: new Set(),
  ...o,
});

test("cards follow the D7 order across a mixed input", () => {
  const cards = buildNeedsYou(
    empty({
      identity: { selfUserId: null, suggestion: "U0ADA0001", suggestionName: "Ada" },
      slackStatus: slack(),
      candidates: candidates([candidate("U0GRA0001", "Grace")]),
      recommendations: [rec()],
      reviewQueue: [commitment()],
      followups: [
        followup(),
        followup({
          id: "f2",
          status: "needs_attention",
          actions: [],
          outgoing: { id: "o2", status: "needs_attention", failure: "uncertain_outcome" },
          resolveActions: ["mark_sent", "resend", "discard"],
        }),
      ],
      flags: [flag()],
      approvals: [approval()],
      urgent: [urgentItem({ messageId: "m2", level: "medium" }), urgentItem()],
    }),
  );
  expect(cards.map((c) => c.kind)).toEqual([
    "urgent",
    "urgent",
    "outgoing",
    "approval",
    "flag",
    "followup",
    "commitment",
    "recommendation",
    "setup-identity",
    "setup-people",
    "setup-backfill",
  ]);
  expect(cards.map((c) => c.key)).toEqual([
    "urgent:m1",
    "urgent:m2",
    "outgoing:o2",
    "approval:a1",
    "flag:fl1",
    "followup:f1",
    "commitment:c1",
    "recommendation:r1",
    "setup:identity",
    "setup:people",
    "setup:backfill",
  ]);
});

test("urgent cards go critical, then high, then medium", () => {
  const cards = buildNeedsYou(
    empty({
      urgent: [
        urgentItem({ messageId: "med", level: "medium" }),
        urgentItem({ messageId: "hi", level: "high" }),
        urgentItem({ messageId: "crit", level: "critical" }),
      ],
    }),
  );
  expect(cards.map((c) => c.key)).toEqual(["urgent:crit", "urgent:hi", "urgent:med"]);
});

test("high red flags come before warnings", () => {
  const cards = buildNeedsYou(
    empty({
      flags: [
        flag({ slackUserId: "U1", latestOpenId: "w", maxSeverity: "warning" }),
        flag({ slackUserId: "U2", latestOpenId: "h", maxSeverity: "high" }),
      ],
    }),
  );
  expect(cards.map((c) => c.key)).toEqual(["flag:h", "flag:w"]);
});

test("sends needing attention become outgoing cards ahead of approvals", () => {
  const cards = buildNeedsYou(
    empty({
      approvals: [approval()],
      urgent: [
        urgentItem({
          reply: {
            followupId: "uf1",
            status: "needs_attention",
            approvalId: null,
            outgoingId: "o1",
            outgoingStatus: "needs_attention",
            canRequest: false,
            actions: ["mark_sent", "resend", "discard"],
          },
        }),
      ],
      followups: [
        followup({
          status: "needs_attention",
          actions: [],
          outgoing: { id: "o2", status: "needs_attention", failure: "uncertain_outcome" },
          resolveActions: ["mark_sent", "discard"],
        }),
      ],
    }),
  );
  expect(cards.map((c) => c.key)).toEqual([
    "urgent:m1",
    "outgoing:o1",
    "outgoing:o2",
    "approval:a1",
  ]);
  const out = cards.find((c) => c.key === "outgoing:o1");
  expect(out?.kind === "outgoing" && out.data.origin).toBe("urgent");
  expect(out?.kind === "outgoing" && out.data.actions).toEqual(["mark_sent", "resend", "discard"]);
  // A channel is labelled "#ops", the same as the urgent card's conversationLabel().
  expect(out?.kind === "outgoing" && out.data.conversation).toBe("#ops");
  // The follow-up itself has no draft card: its decision is on the outgoing card.
  expect(cards.some((c) => c.key === "followup:f1")).toBe(false);
});

test("follow-ups without draft actions (awaiting approval, sending) get no card", () => {
  const cards = buildNeedsYou(
    empty({
      followups: [
        followup({
          status: "awaiting_approval",
          actions: [],
          outgoing: { id: "o1", status: "pending", failure: null },
        }),
      ],
    }),
  );
  expect(cards).toEqual([]);
});

test("profile approvals are shown on their recommendation, not as a second approval card", () => {
  const cards = buildNeedsYou(
    empty({
      approvals: [approval({ id: "ra1", action: "records.update" }), approval()],
      recommendations: [rec()],
    }),
  );
  expect(cards.map((c) => c.key)).toEqual(["approval:a1", "recommendation:r1"]);
});

test("commitment cards only for queue items the server lets you accept", () => {
  const cards = buildNeedsYou(
    empty({ reviewQueue: [commitment(), commitment({ id: "c2", actions: [] })] }),
  );
  expect(cards.map((c) => c.key)).toEqual(["commitment:c1"]);
});

test("the identity setup card shows whenever there is no self id (agrees with the briefing)", () => {
  const unset = { selfUserId: null, suggestion: null, suggestionName: null };
  const has = (o: Partial<NeedsYouInput>) =>
    buildNeedsYou(empty(o)).some((c) => c.kind === "setup-identity");
  expect(has({ identity: { ...unset, suggestion: "U0ADA0001", suggestionName: "Ada" } })).toBe(
    true,
  );
  expect(has({ identity: unset, people: [person("U0ADA0001", "Ada")] })).toBe(true);
  // No suggestion and no people: still shown (the card's "No suggestion yet" branch).
  expect(has({ identity: unset })).toBe(true);
  expect(has({ identity: identified, people: [person("U0ADA0001", "Ada")] })).toBe(false);
  expect(has({ identity: null })).toBe(false);
});

test("the people setup card shows only when there are candidates to evaluate", () => {
  const card = (c: CandidatesResponse | null) =>
    buildNeedsYou(empty({ candidates: c })).find((x) => x.kind === "setup-people");
  expect(card(candidates())).toBeUndefined();
  expect(card(null)).toBeUndefined();
  expect(card(candidates([candidate("U1", "Grace", [])]))).toBeUndefined();
  expect(card(candidates([candidate("U1", "Grace")], true))).toBeUndefined();
  const shown = card(candidates([candidate("U1", "Grace"), candidate("U2", "Linus", [])]));
  expect(shown?.kind === "setup-people" && shown.data.candidates.map((c) => c.name)).toEqual([
    "Grace",
  ]);
});

test("the backfill setup card shows only while the backfill is not done", () => {
  const has = (s: SlackStatusDto | null) =>
    buildNeedsYou(empty({ slackStatus: s })).some((c) => c.kind === "setup-backfill");
  expect(has(slack())).toBe(true);
  expect(has(slack({ status: "running", pagesDone: 3 }))).toBe(true);
  expect(has(slack({ status: "error" }))).toBe(true);
  expect(has(slack({ status: "complete" }))).toBe(false);
  // Not loaded yet: no setup step is shown.
  expect(has(null)).toBe(false);
});

test("hidden keys are excluded", () => {
  const input = empty({
    flags: [flag()],
    followups: [followup()],
    reviewQueue: [commitment()],
    recommendations: [rec({ kind: "suggest_evaluation", approvalId: null, actions: ["dismiss"] })],
    urgent: [urgentItem()],
  });
  const all = buildNeedsYou(input).map((c) => c.key);
  expect(all).toEqual([
    "urgent:m1",
    "flag:fl1",
    "followup:f1",
    "commitment:c1",
    "recommendation:r1",
  ]);
  const hidden = new Set(["flag:fl1", "followup:f1", "commitment:c1", "recommendation:r1"]);
  expect(buildNeedsYou({ ...input, hidden }).map((c) => c.key)).toEqual(["urgent:m1"]);
});

test("allClearRows lists exactly the empty categories", () => {
  expect(allClearRows(empty()).map((r) => r.label)).toEqual([
    "Urgent inbox",
    "Pending approvals",
    "Profile suggestions",
    "Red flags",
  ]);
  const some = allClearRows(empty({ urgent: [urgentItem()], recommendations: [rec()] }));
  expect(some.map((r) => r.label)).toEqual(["Pending approvals", "Red flags"]);
  for (const r of some) expect(r.value.length).toBeGreaterThan(0);
  const none = allClearRows(
    empty({
      urgent: [urgentItem()],
      approvals: [approval()],
      recommendations: [rec()],
      flags: [flag()],
    }),
  );
  expect(none).toEqual([]);
  // A hidden (pending-undo) flag counts as cleared.
  expect(
    allClearRows(empty({ flags: [flag()], hidden: new Set(["flag:fl1"]) })).map((r) => r.label),
  ).toContain("Red flags");
});

test("a running backfill with nothing to start is shown as status but not counted", () => {
  const count = (b: Partial<SlackStatusDto["backfill"]>) => {
    const cards = buildNeedsYou(empty({ urgent: [urgentItem()], slackStatus: slack(b) }));
    const card = cards.find((c) => c.kind === "setup-backfill");
    return {
      shown: card !== undefined,
      actionable: card ? isActionable(card) : null,
      n: needsYouCount(cards),
    };
  };
  expect(count({ status: "running", pagesDone: 3 })).toEqual({
    shown: true,
    actionable: false,
    n: 1,
  });
  expect(count({ status: "paused" })).toEqual({ shown: true, actionable: false, n: 1 });
  // Something to start or resume: a decision, so it counts.
  expect(count({ status: "idle" })).toEqual({ shown: true, actionable: true, n: 2 });
  expect(count({ status: "running", resumable: true })).toEqual({
    shown: true,
    actionable: true,
    n: 2,
  });
  expect(count({ status: "error" })).toEqual({ shown: true, actionable: true, n: 2 });
});
