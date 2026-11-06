import { expect, test } from "bun:test";
import { formatDropped, summarizeInspect } from "../inspect-smoke";

test("formatDropped: reason=count pairs in a stable order, none when empty", () => {
  expect(formatDropped({})).toBe("none");
  expect(formatDropped({ missing: 2, content_secret: 1 })).toBe("content_secret=1 missing=2");
  expect(formatDropped({ missing: 0, too_long: 3 })).toBe("too_long=3");
});

test("summarizeInspect: counts and status only", () => {
  expect(
    summarizeInspect("succeeded", {
      proposed: 5,
      inserted: 4,
      duplicates: 0,
      unknowns: 1,
      dropped: { missing: 1 },
    }),
  ).toEqual(["status: succeeded", "proposed: 5", "inserted: 4", "dropped: missing=1"]);
  expect(summarizeInspect("parse_failed", null)).toEqual(["status: parse_failed"]);
});
