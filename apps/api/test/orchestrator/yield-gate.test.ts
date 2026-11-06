import { describe, expect, test } from "bun:test";
import type { PriorityClass } from "@synapse/contracts";
import {
  shouldYield,
  YIELD_MIN_RETRY_MS,
  yieldRetryAfter,
} from "../../src/core/orchestrator/yield-gate";

const DEF = { yieldWhenActive: true, yieldEngineering: false };
const NOW = new Date("2026-11-06T12:00:00.000Z");
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

describe("shouldYield", () => {
  test("batch and backfill yield when active", () => {
    expect(shouldYield("batch", DEF, true)).toBe(true);
    expect(shouldYield("backfill", DEF, true)).toBe(true);
  });
  test("engineering yields only with yieldEngineering", () => {
    expect(shouldYield("engineering", DEF, true)).toBe(false);
    expect(shouldYield("engineering", { ...DEF, yieldEngineering: true }, true)).toBe(true);
  });
  test.each(["urgent", "send", "collection"] as PriorityClass[])("%s never yields", (c) => {
    for (const yieldWhenActive of [true, false])
      for (const yieldEngineering of [true, false])
        expect(shouldYield(c, { yieldWhenActive, yieldEngineering }, true)).toBe(false);
  });
  test("inactive or yieldWhenActive false never yields", () => {
    expect(shouldYield("batch", DEF, false)).toBe(false);
    expect(shouldYield("batch", { ...DEF, yieldWhenActive: false }, true)).toBe(false);
    expect(
      shouldYield("engineering", { yieldWhenActive: false, yieldEngineering: true }, true),
    ).toBe(false);
  });
});

describe("yieldRetryAfter", () => {
  test("floors at now + 2 min", () => {
    expect(YIELD_MIN_RETRY_MS).toBe(120_000);
    expect(yieldRetryAfter(at(30_000), NOW)).toBe(at(120_000));
    expect(yieldRetryAfter(null, NOW)).toBe(at(120_000));
    expect(yieldRetryAfter("garbage", NOW)).toBe(at(120_000));
  });
  test("later until wins", () => {
    expect(yieldRetryAfter(at(9 * 60_000), NOW)).toBe(at(9 * 60_000));
  });
});
