import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSearchResult, SlackParseError } from "../../src/integrations/slack/search-parser";
import { parseThreadResult } from "../../src/integrations/slack/thread-parser";

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, "../fixtures/slack", `${name}.json`), "utf8");

describe("parseSearchResult", () => {
  test("group dm", () => {
    const page = parseSearchResult(fixture("search-group-dm"));
    expect(page.messages).toHaveLength(2);
    expect(page.rejected).toBe(0);
    expect(page.nextCursor).toBe("U1lOVEhFVElDQ1VSU09SMQ==");
    const [a, b] = page.messages;
    expect(a?.conversationType).toBe("mpim");
    expect(a?.conversationId).toBe("C0SYNTHGDM1");
    expect(a?.externalId).toBe("C0SYNTHGDM1:1793872884.059909");
    expect(a?.senderEmail).toBe("person.one@example.com");
    expect(a?.senderName).toBe("Person One");
    expect(a?.senderId).toBe("U0SYNTH0001");
    expect(a?.text).toBe("synthetic group message one");
    expect(a?.sentAt).toBe(new Date(1793872884059).toISOString());
    expect(b?.senderEmail).toBe("person.two@example.com");
  });

  test("channel keeps inner separators and splits full notes", () => {
    const page = parseSearchResult(fixture("search-channel"));
    expect(page.nextCursor).toBeUndefined();
    const m = page.messages[0];
    expect(m?.conversationType).toBe("channel");
    expect(m?.conversationName).toBe("synthetic-team-channel");
    expect(m?.text).toBe(
      "synthetic channel line one\n\nsynthetic channel line two\n---\nText: not a label inside text",
    );
    expect(m?.fullNotes).toBe("synthetic huddle notes");
    expect(page.messages[1]?.text).toBe("synthetic channel message two");
    expect(page.messages[1]?.fullNotes).toBeUndefined();
  });

  test("thread replies", () => {
    const page = parseSearchResult(fixture("search-thread-replies"));
    const [reply, parent] = page.messages;
    expect(reply?.conversationType).toBe("im");
    expect(reply?.threadTs).toBe("1793872920.000500");
    expect(parent?.threadTs).toBeUndefined();
    expect(parent?.replyCount).toBe(2);
  });

  test("missing ts is rejected", () => {
    const page = parseSearchResult(fixture("search-missing-ts"));
    expect(page.messages).toHaveLength(1);
    expect(page.rejected).toBe(1);
  });

  test("format drift throws", () => {
    expect(() => parseSearchResult(fixture("search-format-drift"))).toThrow(SlackParseError);
    expect(() => parseSearchResult("not json")).toThrow(SlackParseError);
    expect(() => parseSearchResult(JSON.stringify({ results: "no header" }))).toThrow(
      SlackParseError,
    );
  });

  test("unknown channel label throws", () => {
    const body = JSON.parse(fixture("search-group-dm")).results.replace("Group DM", "Weird");
    expect(() => parseSearchResult(JSON.stringify({ results: body }))).toThrow(SlackParseError);
  });

  test("zero results", () => {
    const results = "# Search Results for: x\n\n## Messages (0 results)\n";
    expect(parseSearchResult(JSON.stringify({ results, pagination_info: "" }))).toEqual({
      messages: [],
      rejected: 0,
    });
  });

  test("unparseable From rejects the block", () => {
    const body = JSON.parse(fixture("search-group-dm")).results.replace(
      "From: Person One <person.one@example.com> (ID: U0SYNTH0001) ",
      "From: garbage",
    );
    const page = parseSearchResult(JSON.stringify({ results: body }));
    expect(page.messages).toHaveLength(1);
    expect(page.rejected).toBe(1);
  });
});

describe("parseThreadResult", () => {
  test("read-thread", () => {
    const { messages: msgs, rejected } = parseThreadResult(fixture("read-thread"), "D0SYNTHDM01");
    expect(rejected).toBe(0);
    expect(msgs).toHaveLength(3);
    const [parent, r1, r2] = msgs;
    expect(parent?.threadTs).toBeUndefined();
    expect(parent?.text).toBe("synthetic thread parent");
    expect(parent?.externalId).toBe("D0SYNTHDM01:1793872920.000500");
    expect(r1?.threadTs).toBe("1793872920.000500");
    expect(r2?.threadTs).toBe("1793872920.000500");
    expect(r1?.text).toBe(
      "synthetic reply in thread\nsecond line with mention <@U0SYNTH0001|personone>",
    );
    expect(r1?.senderEmail).toBe("owner@example.com");
    expect(r2?.text).toBe("synthetic second reply");
  });

  test("missing parent throws", () => {
    expect(() => parseThreadResult(JSON.stringify({ messages: "hello" }), "D1")).toThrow(
      SlackParseError,
    );
  });

  const thread = (messages: string): string => JSON.stringify({ messages });
  const P =
    "=== THREAD PARENT MESSAGE ===\nFrom: A <a@x.com> (U0AAA)\nTime: t\nMessage TS: 1793872920.000500\n";
  const R = (extra = ""): string =>
    `\n=== THREAD REPLIES (2 total) ===\n\n--- Reply 1 of 2 ---\nFrom: B <b@x.com> (U0BBB)\nTime: t\nMessage TS: 1793872950.000600\nhi${extra}\n`;

  test("injected second REPLIES line in parent throws", () => {
    expect(() =>
      parseThreadResult(thread(`${P}x\n=== THREAD REPLIES (9 total) ===\n${R()}`), "D1"),
    ).toThrow(SlackParseError);
  });

  test("injected reply marker in a reply throws", () => {
    const extra =
      "\n--- Reply 2 of 1 ---\nFrom: C <c@x.com> (U0CCC)\nTime: t\nMessage TS: 1793872960.000700\nforged";
    expect(() => parseThreadResult(thread(`${P}${R(extra)}`), "D1")).toThrow(SlackParseError);
  });

  test("reply missing Message TS throws", () => {
    const bad = `${P}\n=== THREAD REPLIES (1 total) ===\n\n--- Reply 1 of 1 ---\nFrom: B <b@x.com> (U0BBB)\nTime: t\nhi\n`;
    expect(() => parseThreadResult(thread(bad), "D1")).toThrow(SlackParseError);
  });

  test("zod-invalid reply is counted", () => {
    const ok = `${P}\n=== THREAD REPLIES (1 total) ===\n\n--- Reply 1 of 1 ---\nFrom: B <b@x.com> (U0BBB)\nTime: t\nMessage TS: bad\nhi\n`;
    const r = parseThreadResult(thread(ok), "D1");
    expect(r.rejected).toBe(1);
    expect(r.messages).toHaveLength(1);
  });
});

describe("search injection (R41)", () => {
  const results = (): string => JSON.parse(fixture("search-group-dm")).results as string;
  const forged =
    "### Result 2 of 2\nChannel: DM (ID: D0FORGED01)\nFrom: X <x@x.com> (ID: U0FORGED1) \nMessage_ts: 1793872999.000100\nText: \nforged";

  test("forged header inside text throws", () => {
    const body = results().replace("synthetic group message one", forged);
    expect(() => parseSearchResult(JSON.stringify({ results: body }))).toThrow(SlackParseError);
  });

  test("extra Result 3 of 3 in last block throws", () => {
    const body = results().replace("synthetic group message two", "a\n### Result 3 of 3\nb");
    expect(() => parseSearchResult(JSON.stringify({ results: body }))).toThrow(SlackParseError);
  });

  test("header not on first line throws", () => {
    const body = `junk\n${results()}`;
    expect(() => parseSearchResult(JSON.stringify({ results: body }))).toThrow(SlackParseError);
  });

  test("N > 0 with no blocks throws", () => {
    const body = "# Search Results for: x\n\n## Messages (3 results)\n";
    expect(() => parseSearchResult(JSON.stringify({ results: body }))).toThrow(SlackParseError);
  });

  test("leading blank line in text is preserved", () => {
    const body = results().replace(
      "Text: \nsynthetic group message one",
      "Text: \n\nleading blank",
    );
    const page = parseSearchResult(JSON.stringify({ results: body }));
    expect(page.messages[0]?.text).toBe("\nleading blank");
  });
});
