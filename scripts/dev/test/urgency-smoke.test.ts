import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupDir,
  type FlagRow,
  type MessageRow,
  parseArgs,
  summarize,
  tally,
} from "../urgency-smoke";

test("parseArgs: --pages defaults to 1 and accepts 1..3", () => {
  expect(parseArgs([])).toEqual({ pages: 1 });
  expect(parseArgs(["--pages", "3"])).toEqual({ pages: 3 });
  expect(parseArgs(["--pages=2"])).toEqual({ pages: 2 });
});

test("parseArgs: invalid input is a usage error", () => {
  for (const argv of [
    ["--pages", "0"],
    ["--pages", "4"],
    ["--pages", "x"],
    ["--pages"],
    ["--bogus"],
  ]) {
    expect(() => parseArgs(argv)).toThrow();
  }
});

const messages: MessageRow[] = [
  {
    screening: { candidate: true, fallback: false },
    urgencyLevel: "critical",
    text: "SECRET-MESSAGE-TEXT",
    senderName: "Secret Person",
    id: "USECRETID",
  },
  {
    screening: { candidate: true, fallback: true },
    urgencyLevel: "high",
    text: "SECRET-MESSAGE-TEXT",
  },
  { screening: { candidate: false }, urgencyLevel: null, text: "SECRET-MESSAGE-TEXT" },
  { screening: null, urgencyLevel: null },
];
const flags: FlagRow[] = [
  { severity: "high", excerpt: "SECRET-EXCERPT", slackUserId: "USECRETID" },
  { severity: "info", excerpt: "SECRET-EXCERPT" },
];

test("tally counts screened, candidates, flags, assessed (excluding fallbacks) and fallbacks", () => {
  const c = tally(messages, flags, 2);
  expect(c.messages).toBe(4);
  expect(c.screened).toBe(3);
  expect(c.candidates).toBe(2);
  expect(c.fallbacks).toBe(1);
  expect(c.assessed).toEqual({ critical: 1, high: 0, medium: 0, low: 0 });
  expect(c.flags).toEqual({ info: 1, warning: 0, high: 1 });
  expect(c.drafts).toBe(2);
});

test("summarize prints counts only and drops text, names, excerpts and ids", () => {
  const out = summarize({
    counts: tally(messages, flags, 0),
    collect: "ok",
    assess: "ok",
  }).join("\n");
  for (const s of ["SECRET", "Secret", "http", "@"]) expect(out).not.toContain(s);
  expect(out).toContain("messages: 4");
  expect(out).toContain("screened: 3");
  expect(out).toContain("candidates: 2");
  expect(out).toContain("flags: info=1 warning=0 high=1");
  expect(out).toContain("assessed: critical=1 high=0 medium=0 low=0");
  expect(out).toContain("fallback: 1");
  expect(out).toContain("drafts: 0");
  expect(out).toContain("run: collect=ok assess=ok");
});

test("summarize reports an error kind only", () => {
  const out = summarize({
    counts: tally([], [], 0),
    collect: "error",
    assess: "none",
    errorKind: "parse_failed",
  }).join("\n");
  expect(out).toContain("run: collect=error assess=none (parse_failed)");
});

test("cleanupDir removes the temp dir and its contents", () => {
  const d = mkdtempSync(join(tmpdir(), "urgency-smoke-test-"));
  writeFileSync(join(d, "x.db"), "x");
  cleanupDir(d);
  expect(existsSync(d)).toBe(false);
});
