import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AIExecutionResult,
  type ClaudeJobRequest,
  JobError,
  type RawToolResult,
} from "@synapse/contracts";
import { FakeClock } from "@synapse/shared";
import {
  SEARCH,
  SlackConnectorSource,
  THREAD,
} from "../../src/integrations/slack/connector-source";

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, "../fixtures/slack", `${name}.json`), "utf8");

const NOW = 1793873000; // just after the fixture timestamps
const AFTER = "1793872800.000000";
const CURSOR1 = "U1lOVEhFVElDQ1VSU09SMQ==";
const signal = new AbortController().signal;

const baseArgs = {
  query: "after:2026-11-05",
  after: "1793872800",
  sort: "timestamp",
  sort_dir: "asc",
  limit: 20,
  include_bots: false,
  include_context: false,
  response_format: "detailed",
};

let n = 0;
const tr = (toolName: string, input: unknown, content: string, isError = false): RawToolResult => ({
  toolUseId: `t${n++}`,
  toolName,
  input,
  isError,
  content,
});

const result = (toolResults: RawToolResult[]): AIExecutionResult => ({
  status: "succeeded",
  toolResults,
  finalText: "DONE",
  numTurns: 1,
  durationMs: 1,
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    costUsdEquivalent: 0,
  },
  permissionDenials: [],
  connectors: [],
  availableTools: [],
  exitCode: 0,
});

function setup(toolResults: RawToolResult[]) {
  const seen: ClaudeJobRequest[] = [];
  const source = new SlackConnectorSource({
    orchestrator: {
      run: async (req) => {
        seen.push(req);
        return result(toolResults);
      },
    },
    clock: new FakeClock(new Date(NOW * 1000)),
  });
  return { source, seen };
}

const collectReq = { afterTs: AFTER, maxPages: 5 };

async function failure(p: Promise<unknown>): Promise<JobError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(JobError);
    return e as JobError;
  }
  throw new Error("expected rejection");
}

const searchJson = (messages: { ts: string; id?: string }[], cursor?: string): string => {
  const blocks = messages
    .map(
      (m, i) =>
        `### Result ${i + 1} of ${messages.length}\nChannel: DM (ID: D0SYNTHDM01)\nFrom: P <p@example.com> (ID: U0SYNTH0001) \nTime: 2026-11-05 15:31:24 IST\nMessage_ts: ${m.ts}\nPermalink: [link](https://e.slack.com/archives/D0SYNTHDM01/p1)\nText: \nhello\n\n---\n`,
    )
    .join("\n");
  return JSON.stringify({
    results: `# Search Results for: q\n\n## Messages (${messages.length} results)\n${blocks}`,
    pagination_info: cursor
      ? `For the next page of results use cursor \`${cursor}\`\n`
      : "End of results - No more pages available.\n",
  });
};

describe("SlackConnectorSource.collect", () => {
  test("2-page chain accepted and complete", async () => {
    const { source } = setup([
      tr(SEARCH, baseArgs, fixture("search-group-dm")),
      tr(SEARCH, { ...baseArgs, cursor: CURSOR1 }, fixture("search-channel")),
    ]);
    const r = await source.collect(collectReq, signal);
    expect(r.pages).toHaveLength(2);
    expect(r.complete).toBe(true);
    expect(r.searches).toBe(2);
    expect(r.pages[0]?.messages).toHaveLength(2);
  });

  test("normalises primitive forms and key order (R35)", async () => {
    const input = {
      response_format: "detailed",
      include_context: "false",
      include_bots: "false",
      limit: "20",
      sort_dir: "asc",
      sort: "timestamp",
      after: 1793872800,
      query: "after:2026-11-05",
    };
    const { source } = setup([tr(SEARCH, input, fixture("search-channel"))]);
    const r = await source.collect(collectReq, signal);
    expect(r.pages).toHaveLength(1);
  });

  test("extra key is a mismatch", async () => {
    const { source } = setup([tr(SEARCH, { ...baseArgs, extra: 1 }, fixture("search-channel"))]);
    expect((await failure(source.collect(collectReq, signal))).classified.kind).toBe(
      "incomplete_ai_output",
    );
  });

  test("wrong cursor on page 2 ends the chain", async () => {
    const { source } = setup([
      tr(SEARCH, baseArgs, fixture("search-group-dm")),
      tr(SEARCH, { ...baseArgs, cursor: "FORGED" }, fixture("search-channel")),
    ]);
    const r = await source.collect(collectReq, signal);
    expect(r.pages).toHaveLength(1);
    expect(r.complete).toBe(false);
    expect(r.searches).toBe(2);
  });

  test("page 1 with include_bots true is incomplete_ai_output", async () => {
    const { source } = setup([
      tr(SEARCH, { ...baseArgs, include_bots: true }, fixture("search-channel")),
    ]);
    expect((await failure(source.collect(collectReq, signal))).classified.kind).toBe(
      "incomplete_ai_output",
    );
  });

  test("parse error on page 2 throws parse_failed with no content", async () => {
    const { source } = setup([
      tr(SEARCH, baseArgs, fixture("search-group-dm")),
      tr(SEARCH, { ...baseArgs, cursor: CURSOR1 }, fixture("search-format-drift")),
    ]);
    const e = await failure(source.collect(collectReq, signal));
    expect(e.classified.kind).toBe("parse_failed");
    expect(e.classified.message).toBe("slack output format not recognised");
  });

  test("rate limit with Retry-After", async () => {
    const { source } = setup([tr(SEARCH, baseArgs, "Error: rate limited. Retry-After: 30", true)]);
    const e = await failure(source.collect(collectReq, signal));
    expect(e.classified.kind).toBe("rate_limited");
    expect(e.classified.retryAfter).toBe(new Date((NOW + 30) * 1000).toISOString());
  });

  test("rate limit without Retry-After defaults to 60 s", async () => {
    const { source } = setup([tr(SEARCH, baseArgs, "HTTP 429", true)]);
    const e = await failure(source.collect(collectReq, signal));
    expect(e.classified.retryAfter).toBe(new Date((NOW + 60) * 1000).toISOString());
  });

  test("daily limit waits for next UTC midnight", async () => {
    const { source } = setup([tr(SEARCH, baseArgs, "ratelimited: daily limit reached", true)]);
    const e = await failure(source.collect(collectReq, signal));
    expect(e.classified.retryAfter).toBe("2026-11-06T00:00:00.000Z");
  });

  test("request shape: incremental", async () => {
    const { source, seen } = setup([tr(SEARCH, baseArgs, fixture("search-channel"))]);
    await source.collect(collectReq, signal);
    const req = seen[0];
    expect(req?.priorityClass).toBe("collection");
    expect(req?.workerProfile).toBe("collector");
    expect(req?.allowedTools).toEqual([SEARCH]);
    expect(req?.expectedToolNames).toEqual([SEARCH]);
    expect(req?.maxTurns).toBe(8);
    expect(req?.instructions).toContain(SEARCH);
    expect(req?.instructions).toContain(JSON.stringify(baseArgs));
    expect(req?.instructions).not.toContain('"before"');
  });

  test("request shape: backfill includes before", async () => {
    const beforeTs = "1793873500.000000";
    const { query, after, ...rest } = baseArgs;
    const args = { query: `${query} before:2026-11-05`, after, before: "1793873500", ...rest };
    const { source, seen } = setup([tr(SEARCH, args, fixture("search-channel"))]);
    const r = await source.collect({ afterTs: AFTER, beforeTs, maxPages: 2 }, signal);
    expect(r.pages).toHaveLength(1);
    expect(seen[0]?.priorityClass).toBe("backfill");
    expect(seen[0]?.maxTurns).toBe(5);
    expect(seen[0]?.instructions).toContain(JSON.stringify(args));
  });

  test("R42: message older than afterTs is rejected and counted", async () => {
    const body = searchJson([{ ts: "1793872900.000100" }, { ts: "1793872000.000100" }]);
    const { source } = setup([tr(SEARCH, baseArgs, body)]);
    const r = await source.collect(collectReq, signal);
    expect(r.pages[0]?.messages).toHaveLength(1);
    expect(r.pages[0]?.rejected).toBe(1);
  });

  test("R42: far-future message is rejected", async () => {
    const body = searchJson([{ ts: "1793872900.000100" }, { ts: "2286111111.000100" }]);
    const { source } = setup([tr(SEARCH, baseArgs, body)]);
    const r = await source.collect(collectReq, signal);
    expect(r.pages[0]?.messages).toHaveLength(1);
    expect(r.pages[0]?.rejected).toBe(1);
  });
});

describe("SlackConnectorSource.fetchThreads", () => {
  const threadArgs = (id: string, ts: string) => ({
    channel_id: id,
    message_ts: ts,
    limit: 100,
  });
  const PARENT = "1793872920.000500";

  test("2 requested, 1 answered, unrequested ignored", async () => {
    const { source, seen } = setup([
      tr(THREAD, threadArgs("D0SYNTHDM01", PARENT), fixture("read-thread")),
      tr(THREAD, threadArgs("D0OTHER", "1793872921.000000"), fixture("read-thread")),
    ]);
    const out = await source.fetchThreads(
      [
        { conversationId: "D0SYNTHDM01", parentTs: PARENT },
        { conversationId: "D0SYNTHDM02", parentTs: "1793872930.000000" },
      ],
      signal,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.conversationId).toBe("D0SYNTHDM01");
    expect(out[0]?.messages).toHaveLength(3);
    expect(seen[0]?.allowedTools).toEqual([THREAD]);
    expect(seen[0]?.maxTurns).toBe(5);
    expect(seen[0]?.instructions).toContain(JSON.stringify(threadArgs("D0SYNTHDM01", PARENT)));
  });

  test("R42: parent ts differing from the requested one drops the result", async () => {
    const { source } = setup([
      tr(THREAD, threadArgs("D0SYNTHDM01", "1793872919.000000"), fixture("read-thread")),
    ]);
    const out = await source.fetchThreads(
      [{ conversationId: "D0SYNTHDM01", parentTs: "1793872919.000000" }],
      signal,
    );
    expect(out).toHaveLength(0);
  });

  test("R42: future-dated replies are dropped, parent kept", async () => {
    const run = async () =>
      result([tr(THREAD, threadArgs("D0SYNTHDM01", PARENT), fixture("read-thread"))]);
    // now + 5 min = 1793872855, before every reply ts (parent 920, replies 950/960)
    const source = new SlackConnectorSource({
      orchestrator: { run },
      clock: new FakeClock(new Date((1793872555 + 0) * 1000)),
    });
    const out = await source.fetchThreads(
      [{ conversationId: "D0SYNTHDM01", parentTs: PARENT }],
      signal,
    );
    expect(out[0]?.messages).toHaveLength(1);
  });
});
