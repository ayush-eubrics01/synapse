import { expect, test } from "bun:test";
import { backoffMs } from "../src/index.ts";

test("backoff doubles and caps", () => {
  const r = () => 0.5; // jitter factor exactly 1.0
  expect(backoffMs(1, { random: r })).toBe(30_000);
  expect(backoffMs(2, { random: r })).toBe(60_000);
  expect(backoffMs(20, { random: r })).toBe(1_800_000);
});

test("backoff jitter stays within ±20%", () => {
  expect(backoffMs(1, { random: () => 0 })).toBe(24_000);
  expect(backoffMs(1, { random: () => 1 })).toBe(36_000);
});
