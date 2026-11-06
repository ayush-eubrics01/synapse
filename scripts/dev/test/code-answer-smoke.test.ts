import { expect, test } from "bun:test";
import { outsideLeaked, summarizeCodeAnswer, toolsOk, USAGE } from "../code-answer-smoke";

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

test("toolsOk counts successful Read, Grep and Glob results only", () => {
  const ok = (toolName: string, isError = false) => ({ toolName, isError });
  expect(toolsOk([ok("Read"), ok("Read"), ok("Glob"), ok("Grep", true), ok("Bash")])).toBe(
    "tools_ok: Read=2 Grep=0 Glob=1",
  );
  expect(toolsOk([])).toBe("tools_ok: Read=0 Grep=0 Glob=0");
});

test("USAGE says it spends quota and must be run deliberately", () => {
  expect(USAGE).toContain("Spends a tiny amount of Claude quota");
  expect(USAGE).toContain("run deliberately");
});
