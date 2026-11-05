import { expect, test } from "bun:test";
import type { MessagePage, SourceMessage } from "@synapse/contracts";
import { parseArgs, summarize } from "../slack-smoke";

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
    ["--pages", "1.5"],
    ["--pages"],
    ["--bogus"],
  ]) {
    expect(() => parseArgs(argv)).toThrow();
  }
});

const msg = (over: Partial<SourceMessage>): SourceMessage => ({
  externalId: "CSECRETID:1700000000.000100",
  conversationId: "CSECRETID",
  conversationType: "channel",
  conversationName: "secret-channel-name",
  ts: "1700000000.000100",
  senderId: "USECRETID",
  senderName: "Secret Person",
  senderEmail: "secret@example.com",
  text: "SECRET-MESSAGE-TEXT",
  permalink: "https://secret.slack.com/archives/CSECRETID/p1",
  sentAt: "2023-11-14T22:13:20.000Z",
  ...over,
});

test("summarize prints counts only and drops text, names, emails, permalinks and ids", () => {
  const page: MessagePage = {
    messages: [
      msg({}),
      msg({
        conversationType: "im",
        conversationId: "DSECRETID",
        externalId: "DSECRETID:1700000001.000100",
        ts: "1700000001.000100",
      }),
    ],
    rejected: 2,
  };
  const out = summarize({
    pages: [page],
    persisted: [{ inserted: 1, duplicates: 1, threadFetches: 3 }],
    searches: 1,
    status: "ok",
  }).join("\n");
  for (const s of ["SECRET", "secret", "Secret", "example.com", "http"]) {
    expect(out).not.toContain(s);
  }
  expect(out).toContain("pages: 1");
  expect(out).toContain("inserted: 1");
  expect(out).toContain("duplicates: 1");
  expect(out).toContain("rejected: 2");
  expect(out).toContain("conversations: channel=1 im=1 mpim=0");
  expect(out).toContain("threadsEnqueued: 3");
  expect(out).toContain("searches: 1");
  expect(out).toContain("run: ok");
});

test("summarize reports an error kind only", () => {
  const out = summarize({
    pages: [],
    persisted: [],
    searches: 0,
    status: "error",
    errorKind: "parse_failed",
  }).join("\n");
  expect(out).toContain("run: error (parse_failed)");
  expect(out).toContain("pages: 0");
});
