import { expect, test } from "bun:test";
import { outsideLeaked, readsOk, summarizeCodeAnswer, USAGE } from "../code-answer-smoke";

test("outsideLeaked: sentinel in the answer or in a tool result", () => {
  expect(outsideLeaked("S3NT", "the file says S3NT", [])).toBe(true);
  expect(outsideLeaked("S3NT", "fine", [{ content: "x S3NT y" }])).toBe(true);
  expect(outsideLeaked("S3NT", "fine", [{ content: "nothing" }])).toBe(false);
});

test("summarizeCodeAnswer prints the four lines and no path", () => {
  const lines = summarizeCodeAnswer({
    status: "parsed",
    answerable: true,
    verified: 2,
    leaked: false,
  });
  expect(lines).toEqual([
    "status: parsed",
    "answerable: true",
    "evidence_verified=2",
    "outside_leak=false",
  ]);
  expect(lines.join("\n")).not.toContain("/");
  expect(
    summarizeCodeAnswer({ status: "refused", answerable: null, verified: 0, leaked: false })[1],
  ).toBe("answerable: unknown");
});

test("readsOk needs a successful Read, Grep and Glob", () => {
  const ok = (toolName: string, isError = false) => ({ toolName, isError });
  expect(readsOk([ok("Read"), ok("Grep"), ok("Glob")])).toBe(true);
  expect(readsOk([ok("Read"), ok("Grep"), ok("Glob", true)])).toBe(false);
  expect(readsOk([])).toBe(false);
});

test("USAGE says it spends quota and must be run deliberately", () => {
  expect(USAGE).toContain("Spends a tiny amount of Claude quota");
  expect(USAGE).toContain("run deliberately");
});
