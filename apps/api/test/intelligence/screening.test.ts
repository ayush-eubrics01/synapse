import { expect, test } from "bun:test";
import { DEFAULT_KEYWORDS } from "../../src/intelligence/screening/rules";
import {
  invalidKeywordIds,
  type ScreenInput,
  screenMessage,
} from "../../src/intelligence/screening/screen";

const cfg = { keywords: DEFAULT_KEYWORDS, threshold: 2 };
const base: ScreenInput = {
  text: "",
  conversationType: "channel",
  mentionsSelf: false,
  inThreadWithSelf: false,
  priority: "normal",
  extraAttention: false,
};
const run = (over: Partial<ScreenInput>, c = cfg) => screenMessage({ ...base, ...over }, c);

test("priority person with a routine DM is not a candidate", () => {
  const r = run({
    text: "can you look at this when you get a chance",
    conversationType: "im",
    priority: "critical",
  });
  expect(r.candidate).toBe(false);
  expect(r.urgencySignals).toEqual([]);
});

test("non-priority sender reporting an incident in a channel is a critical candidate", () => {
  const r = run({ text: "prod is down, checkout returning 500s" });
  expect(r.candidate).toBe(true);
  expect(r.ruleLevel).toBe("critical");
  expect(r.matchedRules).toContain("incident");
});

test("'this is blocking me' in a DM scores 3, high candidate", () => {
  const r = run({ text: "this is blocking me", conversationType: "im" });
  expect(r.score).toBe(3);
  expect(r.candidate).toBe(true);
  expect(r.ruleLevel).toBe("high");
});

test("'blocked' in a channel scores 2 and is a candidate", () => {
  const r = run({ text: "blocked" });
  expect(r.score).toBe(2);
  expect(r.candidate).toBe(true);
});

test("'today?' scores 1: no candidate normally, medium candidate from a priority sender", () => {
  const normal = run({ text: "today?" });
  expect(normal.score).toBe(1);
  expect(normal.candidate).toBe(false);
  expect(normal.urgencySignals).toEqual(["today"]);
  expect(normal.matchedRules).toContain("question");
  const prio = run({ text: "today?", priority: "high" });
  expect(prio.candidate).toBe(true);
  expect(prio.ruleLevel).toBe("medium");
});

test("context weights: mpim 0.5, mention 1, thread 1, extraAttention 1 and lowered threshold", () => {
  const r = run({
    text: "today",
    conversationType: "mpim",
    mentionsSelf: true,
    inThreadWithSelf: true,
    extraAttention: true,
  });
  expect(r.score).toBe(1 + 0.5 + 1 + 1 + 1);
  expect(run({ text: "today", extraAttention: true }).candidate).toBe(true);
});

test("threshold never drops below 1, and a signal is always required", () => {
  expect(run({ text: "today", priority: "high" }, { ...cfg, threshold: 0.5 }).candidate).toBe(true);
  expect(run({ text: "hello", priority: "critical", extraAttention: true }).candidate).toBe(false);
  expect(
    run({ text: "anyone around?", conversationType: "im", mentionsSelf: true }).candidate,
  ).toBe(false);
});

test("an invalid keyword regex is skipped, not thrown", () => {
  const keywords = [
    { id: "bad", pattern: "(", weight: 5, level: "critical" as const, signal: true },
    ...DEFAULT_KEYWORDS,
  ];
  expect(invalidKeywordIds(keywords)).toEqual(["bad"]);
  const r = run({ text: "blocked" }, { keywords, threshold: 2 });
  expect(r.matchedRules).toEqual(["blocker"]);
  expect(invalidKeywordIds(DEFAULT_KEYWORDS)).toEqual([]);
});
