import { expect, test } from "bun:test";
import { dateLine, dayLabel, greeting, relMinutes, timeOfDay } from "../lib/format";

const at = (h: number, m = 0) => new Date(2026, 10, 6, h, m);

test("timeOfDay boundaries", () => {
  expect(timeOfDay(at(4, 59))).toBe("late");
  expect(timeOfDay(at(5))).toBe("morning");
  expect(timeOfDay(at(11, 59))).toBe("morning");
  expect(timeOfDay(at(12))).toBe("afternoon");
  expect(timeOfDay(at(16, 59))).toBe("afternoon");
  expect(timeOfDay(at(17))).toBe("evening");
  expect(timeOfDay(at(21, 59))).toBe("evening");
  expect(timeOfDay(at(22))).toBe("late");
});

test("greeting names the user when known", () => {
  expect(greeting(at(2), "Ada")).toBe("Late night, Ada.");
  expect(greeting(at(9), null)).toBe("Good morning.");
  expect(greeting(at(14), "Grace")).toBe("Good afternoon, Grace.");
  expect(greeting(at(19), "  ")).toBe("Good evening.");
});

test("dateLine is the uppercase weekday, day and month, then the local time", () => {
  const line = dateLine(at(2, 25));
  expect(line.startsWith("FRIDAY, 6 NOVEMBER · ")).toBe(true);
  expect(line).toContain("25");
  expect(line).toBe(line.toUpperCase());
});

test("relMinutes boundaries", () => {
  const now = new Date("2026-11-06T12:00:00.000Z");
  const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
  expect(relMinutes(ago(0), now)).toBe("just now");
  expect(relMinutes(ago(3), now)).toBe("3 min ago");
  expect(relMinutes(ago(59), now)).toBe("59 min ago");
  expect(relMinutes(ago(60), now)).toBe("1 h ago");
  expect(relMinutes(ago(150), now)).toBe("2 h ago");
  expect(relMinutes(ago(60 * 50), now)).toBe("2 d ago");
  expect(relMinutes(null, now)).toBe("never");
  expect(relMinutes("not a date", now)).toBe("never");
  expect(relMinutes(ago(-5), now)).toBe("just now");
});

test("dayLabel says Today, Yesterday, or the weekday and date", () => {
  const now = at(10);
  expect(dayLabel(at(1).toISOString(), now)).toBe("Today");
  expect(dayLabel(new Date(2026, 10, 5, 23).toISOString(), now)).toBe("Yesterday");
  expect(dayLabel(new Date(2026, 10, 5, 0, 1).toISOString(), now)).toBe("Yesterday");
  expect(dayLabel(new Date(2026, 10, 4, 12).toISOString(), now)).toBe("Wednesday, 4 November");
  expect(dayLabel(new Date(2025, 10, 4, 12).toISOString(), now)).toBe("Tuesday, 4 November 2025");
});
