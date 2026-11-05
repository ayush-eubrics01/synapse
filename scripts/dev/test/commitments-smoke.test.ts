import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageSink } from "@synapse/contracts";
import { NoopDesktopNotifier } from "../../../apps/api/src/infrastructure/notifier";
import {
  cleanupDir,
  createSmokeContainer,
  parseArgs,
  type SmokeInput,
  summarize,
  throwingSink,
} from "../commitments-smoke";

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
  messages: 40,
  eligible: 12,
  candidates: 5,
  dropped: 2,
  created: 3,
  mine: 1,
  theirs: 2,
  proposed: 1,
  identity: "set",
  collect: "ok",
  run: "ok",
  description: "SECRET-DESCRIPTION",
  slackUserId: "USECRETID",
  text: "SECRET-TEXT",
};

test("summarize prints counts only and drops names, ids and text", () => {
  const out = summarize(input).join("\n");
  for (const s of ["SECRET", "http", "@"]) expect(out).not.toContain(s);
  expect(out).toContain("messages: 40");
  expect(out).toContain("eligible: 12");
  expect(out).toContain("candidates: 5");
  expect(out).toContain("dropped: 2");
  expect(out).toContain("commitments created: 3 (mine=1 theirs=2)");
  expect(out).toContain("completion proposals: 1");
  expect(out).toContain("run: collect=ok extract=ok");
});

test("summarize without identity prints identity: none after the collection counts", () => {
  expect(summarize({ ...input, identity: "none" })).toEqual([
    "messages: 40",
    "identity: none",
    "run: collect=ok",
  ]);
});

test("summarize reports an error kind only", () => {
  const out = summarize({ ...input, run: "error", errorKind: "parse_failed" }).join("\n");
  expect(out).toContain("extract=error (parse_failed)");
});

test("the container gets a sink that throws if called, and a no-op notifier", async () => {
  let seen: { sink?: MessageSink; notifier?: unknown } | undefined;
  const fake = { sqlite: { close() {} } };
  const c = createSmokeContainer(
    {} as never,
    ((_config: unknown, deps: typeof seen) => {
      seen = deps;
      return fake;
    }) as never,
  );
  expect(c).toBe(fake as never);
  expect(seen?.sink).toBe(throwingSink);
  expect(seen?.notifier).toBeInstanceOf(NoopDesktopNotifier);
  await expect(throwingSink.send({} as never, new AbortController().signal)).rejects.toThrow();
  await expect(throwingSink.findSent({} as never, "0")).rejects.toThrow();
});

test("cleanupDir removes the temp dir and its contents", () => {
  const d = mkdtempSync(join(tmpdir(), "commitments-smoke-test-"));
  writeFileSync(join(d, "x.db"), "x");
  cleanupDir(d);
  expect(existsSync(d)).toBe(false);
});
