import { expect, test } from "bun:test";
import { FakeClock, isoNow, systemClock } from "../src/index.ts";

test("FakeClock advances", () => {
  const c = new FakeClock("2026-11-05T10:00:00.000Z");
  c.advance(60_000);
  expect(isoNow(c)).toBe("2026-11-05T10:01:00.000Z");
});

test("FakeClock set replaces the current time", () => {
  const c = new FakeClock(new Date("2026-11-05T10:00:00.000Z"));
  c.set("2027-01-01T00:00:00.000Z");
  expect(isoNow(c)).toBe("2027-01-01T00:00:00.000Z");
});

test("systemClock returns the current time", () => {
  const before = Date.now();
  const t = systemClock.now().getTime();
  expect(t).toBeGreaterThanOrEqual(before);
  expect(t).toBeLessThanOrEqual(Date.now());
});
