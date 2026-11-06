import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupDir, parseArgs, type SmokeInput, summarize } from "../people-smoke";

test("parseArgs: defaults, --pages and --self in both forms", () => {
  expect(parseArgs([])).toEqual({ pages: 1, self: null });
  expect(parseArgs(["--pages", "3", "--self", "U012ABC"])).toEqual({ pages: 3, self: "U012ABC" });
  expect(parseArgs(["--pages=2", "--self=W012ABC"])).toEqual({ pages: 2, self: "W012ABC" });
});

test("parseArgs: invalid input is a usage error", () => {
  for (const argv of [
    ["--pages", "0"],
    ["--pages", "4"],
    ["--pages", "x"],
    ["--pages"],
    ["--self"],
    ["--self", "bob"],
    ["--bogus"],
  ]) {
    expect(() => parseArgs(argv)).toThrow();
  }
});

const input: SmokeInput = {
  messages: 12,
  candidates: 3,
  identity: "set",
  history: 9,
  dropped: 2,
  content: {
    professionalContext: [{ key: "k", text: "SECRET-OBSERVATION", evidence: ["USECRETID"] }],
    communication: [
      { key: "k", text: "SECRET-OBSERVATION" },
      { key: "j", text: "SECRET" },
    ],
    responseGuidelines: [],
  },
  evidenceRows: 4,
  recommendation: true,
  collect: "ok",
  run: "ok",
  name: "Secret Person",
  slackUserId: "USECRETID",
  reason: "SECRET-REASON",
};

test("summarize prints counts only and drops names, ids, text and reasons", () => {
  const out = summarize(input).join("\n");
  for (const s of ["SECRET", "Secret", "http", "@"]) expect(out).not.toContain(s);
  expect(out).toContain("messages: 12");
  expect(out).toContain("candidates: 3");
  expect(out).toContain("history items: 9");
  expect(out).toContain("observations: professionalContext=1 communication=2 responseGuidelines=0");
  expect(out).toContain("observations dropped: 2");
  expect(out).toContain("evidence rows: 4");
  expect(out).toContain("recommendation created: yes");
  expect(out).toContain("run: collect=ok initial=ok");
});

test("summarize without identity prints identity: none after the collection counts", () => {
  const out = summarize({ ...input, identity: "none", candidates: 0 });
  expect(out).toEqual(["messages: 12", "candidates: 0", "identity: none", "run: collect=ok"]);
});

test("summarize reports an error kind only", () => {
  const out = summarize({
    ...input,
    content: null,
    recommendation: false,
    run: "error",
    errorKind: "parse_failed",
  });
  expect(out.join("\n")).toContain("recommendation created: no");
  expect(out.join("\n")).toContain("initial=error (parse_failed)");
});

test("cleanupDir removes the temp dir and its contents", () => {
  const d = mkdtempSync(join(tmpdir(), "people-smoke-test-"));
  writeFileSync(join(d, "x.db"), "x");
  cleanupDir(d);
  expect(existsSync(d)).toBe(false);
});
