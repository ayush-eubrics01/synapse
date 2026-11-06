import { expect, test } from "bun:test";
import type { AutoReplyKind } from "@synapse/contracts";
import {
  ACK_TEXT,
  decideAutoReply,
  hasAutoReplyTag,
  type PolicyInput,
  withAutoReplyTag,
} from "../../src/modules/auto-reply/policy";

const NOW = "2026-11-06T12:00:00.000Z";
const ALL: AutoReplyKind[] = [
  "code_answer",
  "stalled_reminder",
  "followup_question",
  "acknowledgement",
];
const base = (o: Partial<PolicyInput> = {}): PolicyInput => ({
  awayOn: true,
  kind: "followup_question",
  allowedKinds: ALL,
  recipientPriority: "high",
  incomingText: "hello there",
  incomingFlagged: false,
  sentToRecipientLast24h: 0,
  lastSentInThreadAt: null,
  now: NOW,
  confidence: 0.9,
  candidateText: "Could you share the CSV you uploaded?",
  maxPerDay: 3,
  minGapMinutes: 30,
  minConfidence: 0.75,
  ...o,
});
const minutesAgo = (m: number) => new Date(Date.parse(NOW) - m * 60_000).toISOString();

test("clean input sends", () => expect(decideAutoReply(base())).toEqual({ send: true }));

test.each([
  ["away_off", { awayOn: false }],
  ["kind_not_allowed", { allowedKinds: ["acknowledgement"] as AutoReplyKind[] }],
  ["not_priority", { recipientPriority: "normal" as const }],
  ["loop_tag", { incomingText: "ok\n\nSent  using @Claude" }],
  ["flagged", { incomingFlagged: true }],
  ["daily_cap", { sentToRecipientLast24h: 3 }],
  ["thread_gap", { lastSentInThreadAt: minutesAgo(29) }],
  ["low_confidence", { confidence: 0.5 }],
  ["content_secret", { candidateText: "xoxb-123456-abc" }],
  ["content_internal_url", { candidateText: "http://localhost:3000/x" }],
  ["content_link", { candidateText: "See https://example.com/doc" }],
  ["content_mention", { candidateText: "<!here> any update?" }],
  ["content_promise", { candidateText: "I'll have it ready by Friday" }],
] as const)("reason %s", (reason, o) => {
  expect(decideAutoReply(base(o as Partial<PolicyInput>))).toEqual({ send: false, reason });
});

test("a candidate that already carries the tag is held: loop_tag (no double tag)", () => {
  expect(
    decideAutoReply(
      base({ incomingText: null, candidateText: "Any update?\n\nsent using @claude" }),
    ),
  ).toEqual({ send: false, reason: "loop_tag" });
});

test("first failure wins in A4 order", () => {
  const all = base({
    awayOn: false,
    allowedKinds: [],
    recipientPriority: "normal",
    incomingText: "Sent using @claude",
    incomingFlagged: true,
    sentToRecipientLast24h: 9,
    lastSentInThreadAt: minutesAgo(1),
    confidence: null,
    candidateText: "xoxb-1 I'll http://localhost:1 https://example.com/x <!here>",
  });
  const order = [
    "away_off",
    "kind_not_allowed",
    "not_priority",
    "loop_tag",
    "flagged",
    "daily_cap",
    "thread_gap",
    "low_confidence",
    "content_secret",
    "content_internal_url",
    "content_link",
    "content_mention",
    "content_promise",
  ];
  let i: PolicyInput = all;
  for (const reason of order) {
    expect(decideAutoReply(i)).toEqual({ send: false, reason } as never);
    if (reason === "away_off") i = { ...i, awayOn: true };
    if (reason === "kind_not_allowed") i = { ...i, allowedKinds: ALL };
    if (reason === "not_priority") i = { ...i, recipientPriority: "critical" };
    if (reason === "loop_tag") i = { ...i, incomingText: null };
    if (reason === "flagged") i = { ...i, incomingFlagged: false };
    if (reason === "daily_cap") i = { ...i, sentToRecipientLast24h: 0 };
    if (reason === "thread_gap") i = { ...i, lastSentInThreadAt: null };
    if (reason === "low_confidence") i = { ...i, confidence: 1 };
    if (reason === "content_secret") {
      i = { ...i, candidateText: "I'll http://localhost:1 https://example.com/x <!here>" };
    }
    if (reason === "content_internal_url") {
      i = { ...i, candidateText: "I'll https://example.com/x <!here>" };
    }
    if (reason === "content_link") i = { ...i, candidateText: "I'll <!here>" };
    if (reason === "content_mention") i = { ...i, candidateText: "I'll" };
  }
  expect(decideAutoReply({ ...i, candidateText: "Any update?" })).toEqual({ send: true });
});

test("priority high and critical both pass", () => {
  expect(decideAutoReply(base({ recipientPriority: "critical" }))).toEqual({ send: true });
  expect(decideAutoReply(base({ recipientPriority: "high" }))).toEqual({ send: true });
});

test("daily cap: 2 ok, 3 held", () => {
  expect(decideAutoReply(base({ sentToRecipientLast24h: 2 })).send).toBe(true);
  expect(decideAutoReply(base({ sentToRecipientLast24h: 3 }))).toEqual({
    send: false,
    reason: "daily_cap",
  });
});

test("thread gap: 29 min held, 31 ok, exactly 30 ok, unparseable held", () => {
  expect(decideAutoReply(base({ lastSentInThreadAt: minutesAgo(29) })).send).toBe(false);
  expect(decideAutoReply(base({ lastSentInThreadAt: minutesAgo(31) })).send).toBe(true);
  expect(decideAutoReply(base({ lastSentInThreadAt: minutesAgo(30) })).send).toBe(true);
  expect(decideAutoReply(base({ lastSentInThreadAt: "garbage" }))).toEqual({
    send: false,
    reason: "thread_gap",
  });
});

test("confidence: ack skips it, others need it; null is below; equal threshold passes", () => {
  expect(
    decideAutoReply(base({ kind: "acknowledgement", confidence: null, candidateText: ACK_TEXT })),
  ).toEqual({ send: true });
  expect(decideAutoReply(base({ confidence: null }))).toEqual({
    send: false,
    reason: "low_confidence",
  });
  expect(decideAutoReply(base({ kind: "stalled_reminder", confidence: null })).send).toBe(false);
  expect(decideAutoReply(base({ confidence: 0.75 })).send).toBe(true);
});

test("ACK_TEXT is the spec text and sends", () => {
  expect(ACK_TEXT).toBe(
    "Thanks, I'm away at the moment. I've noted your message and will get back to you as soon as I can.",
  );
  expect(
    decideAutoReply(base({ kind: "acknowledgement", confidence: null, candidateText: ACK_TEXT })),
  ).toEqual({ send: true });
});

test("withAutoReplyTag", () => {
  expect(withAutoReplyTag("hi  ")).toBe("hi\n\nSent using @claude");
  expect(hasAutoReplyTag(withAutoReplyTag("hi"))).toBe(true);
});

test.each([
  ["Sent using @claude", true],
  ["SENT USING @CLAUDE", true],
  ["a\n\nsent   using\n@claude", true],
  ["R&amp;D note &amp; more\n\nSent using @claude", true],
  ["Sent using &amp;claude", false],
  ["Sent using claude", false],
  ["hello", false],
])("hasAutoReplyTag(%j) = %p", (t, want) => expect(hasAutoReplyTag(t)).toBe(want));
