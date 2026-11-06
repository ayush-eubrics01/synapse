import { describe, expect, test } from "bun:test";
import {
  type AIExecutionResult,
  type ClaudeJobRequest,
  JIRA_FIELDS,
  JIRA_TOOL_RESOURCES,
  JIRA_TOOL_SEARCH,
  JobError,
  type RawToolResult,
} from "@synapse/contracts";
import { FakeClock } from "@synapse/shared";
import { JiraConnectorSource } from "../../src/integrations/jira/connector-source";

const signal = new AbortController().signal;
const NOW = Date.parse("2026-11-06T10:00:00Z");
const CLOUD = "00000000-0000-4000-8000-000000000000";

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
  const source = new JiraConnectorSource({
    clock: new FakeClock(new Date(NOW)),
    orchestrator: {
      run: async (req) => {
        seen.push(req);
        return result(toolResults);
      },
    },
  });
  return { source, seen };
}

async function failure(p: Promise<unknown>): Promise<JobError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(JobError);
    return e as JobError;
  }
  throw new Error("expected rejection");
}

const node = {
  id: "10001",
  key: "DEMO-1",
  webUrl: "https://example.atlassian.net/browse/DEMO-1",
  fields: {
    summary: "synthetic",
    status: { name: "To Do", statusCategory: { key: "new" } },
    priority: { name: "High" },
    issuetype: { name: "Task" },
    project: { key: "DEMO" },
    labels: [],
    duedate: null,
    created: "2026-09-14T10:49:18.071+0000",
    updated: "2026-09-15T08:00:00.000+0000",
  },
};
const searchContent = (next: string | null = null) =>
  JSON.stringify({
    issues: {
      totalCount: 1,
      nodes: [node],
      pageInfo: { hasNextPage: next !== null, endCursor: next },
    },
  });

const args = { cloudId: CLOUD, jql: "project = DEMO ORDER BY updated ASC", maxResults: 50 };
const sent = (extra: Record<string, unknown> = {}) => ({
  cloudId: args.cloudId,
  jql: args.jql,
  fields: [...JIRA_FIELDS],
  maxResults: args.maxResults,
  ...extra,
});

describe("JiraConnectorSource.searchPage", () => {
  test("happy path: request shape and parsed page", async () => {
    const { source, seen } = setup([tr(JIRA_TOOL_SEARCH, sent(), searchContent("c2"))]);
    const page = await source.searchPage(args, signal);
    expect(page.issues.map((i) => i.key)).toEqual(["DEMO-1"]);
    expect(page.nextPageToken).toBe("c2");
    expect(page.total).toBe(1);
    const req = seen[0];
    expect(req?.workerProfile).toBe("collector");
    expect(req?.priorityClass).toBe("collection");
    expect(req?.model).toBe("haiku");
    expect(req?.maxTurns).toBe(4);
    expect(req?.allowedTools).toEqual([JIRA_TOOL_SEARCH, "ToolSearch"]);
    expect(req?.instructions).toContain(JIRA_TOOL_SEARCH);
    expect(req?.instructions).toContain(JSON.stringify(sent()));
  });

  test("nextPageToken is requested and matched; fields compare as a set; tolerated extras", async () => {
    const { source, seen } = setup([
      tr(
        JIRA_TOOL_SEARCH,
        {
          ...sent({ nextPageToken: "c2" }),
          fields: [...JIRA_FIELDS].reverse(),
          responseContentFormat: "markdown",
          actionSource: "model_tool_call",
          searchResultMode: "issues",
        },
        searchContent(),
      ),
    ]);
    const page = await source.searchPage({ ...args, nextPageToken: "c2" }, signal);
    expect(page.nextPageToken).toBeNull();
    expect(seen[0]?.instructions).toContain('"nextPageToken":"c2"');
  });

  const bad: [string, unknown][] = [
    ["different jql", sent({ jql: "project = OTHER" })],
    ["missing token", sent()],
    ["unknown extra argument", sent({ extra: 1 })],
    ["extra with wrong value", sent({ responseContentFormat: "adf" })],
    ["different maxResults", sent({ maxResults: 51 })],
    ["fields subset", { ...sent(), fields: ["summary"] }],
    ["fields with extra member", { ...sent(), fields: [...JIRA_FIELDS, "description"] }],
    ["non-object input", "x"],
  ];
  for (const [name, input] of bad) {
    test(`mismatch: ${name}`, async () => {
      const { source } = setup([tr(JIRA_TOOL_SEARCH, input, searchContent())]);
      const e = await failure(source.searchPage({ ...args, nextPageToken: "c2" }, signal));
      expect(e.classified.kind).toBe("incomplete_ai_output");
    });
  }

  test("unrequested nextPageToken is a mismatch", async () => {
    const { source } = setup([
      tr(JIRA_TOOL_SEARCH, sent({ nextPageToken: "zz" }), searchContent()),
    ]);
    const e = await failure(source.searchPage(args, signal));
    expect(e.classified.kind).toBe("incomplete_ai_output");
  });

  test("two results, no result, error result", async () => {
    const one = tr(JIRA_TOOL_SEARCH, sent(), searchContent());
    for (const rs of [
      [one, { ...one, toolUseId: "x" }],
      [],
      [tr(JIRA_TOOL_SEARCH, sent(), "boom", true)],
    ]) {
      const { source } = setup(rs);
      const e = await failure(source.searchPage(args, signal));
      expect(e.classified.kind).toBe("incomplete_ai_output");
    }
  });

  test("results of other tools are ignored", async () => {
    const { source } = setup([
      tr("ToolSearch", {}, "x"),
      tr(JIRA_TOOL_SEARCH, sent(), searchContent()),
    ]);
    expect((await source.searchPage(args, signal)).issues).toHaveLength(1);
  });

  const oversized: [string, string, boolean][] = [
    [
      "token-limit notice",
      "Error: result (119,482 characters) exceeds maximum allowed tokens. Output has been saved to /tmp/x.txt SYNTH-TEXT",
      false,
    ],
    [
      "token-limit notice flagged as an error",
      "Error: result (119,482 characters) exceeds maximum allowed tokens. SYNTH-TEXT",
      true,
    ],
    [
      "persisted-output notice",
      "<persisted-output>saved to /tmp/x SYNTH-TEXT</persisted-output>",
      false,
    ],
    [
      "notice in MCP text blocks",
      JSON.stringify([{ type: "text", text: "<persisted-output>SYNTH-TEXT" }]),
      false,
    ],
  ];
  for (const [name, content, isError] of oversized) {
    test(`CLI oversized-output notice is output_too_large: ${name}`, async () => {
      const { source } = setup([tr(JIRA_TOOL_SEARCH, sent(), content, isError)]);
      const e = await failure(source.searchPage(args, signal));
      expect(e.classified.kind).toBe("output_too_large");
      expect(e.message).toBe("jira tool output too large");
      expect(JSON.stringify(e.classified)).not.toContain("SYNTH-TEXT");
    });
  }

  test("an Error: result notice without the token-limit phrase stays parse_failed", async () => {
    const { source } = setup([tr(JIRA_TOOL_SEARCH, sent(), "Error: result (1 characters) odd")]);
    const e = await failure(source.searchPage(args, signal));
    expect(e.classified.kind).toBe("parse_failed");
  });

  test("an oversized notice for mismatched arguments is still incomplete_ai_output", async () => {
    const { source } = setup([
      tr(JIRA_TOOL_SEARCH, sent({ maxResults: 100 }), "<persisted-output>x"),
    ]);
    const e = await failure(source.searchPage(args, signal));
    expect(e.classified.kind).toBe("incomplete_ai_output");
  });

  test("parse failure becomes parse_failed without content", async () => {
    const { source } = setup([tr(JIRA_TOOL_SEARCH, sent(), '{"secret":"SYNTH-TEXT"}')]);
    const e = await failure(source.searchPage(args, signal));
    expect(e.classified.kind).toBe("parse_failed");
    expect(e.message).not.toContain("SYNTH-TEXT");
  });
});

describe("JiraConnectorSource.resolveCloudId", () => {
  const res = JSON.stringify([{ id: CLOUD, url: "https://example.atlassian.net", name: "Demo" }]);

  test("happy path", async () => {
    const { source, seen } = setup([tr(JIRA_TOOL_RESOURCES, {}, res)]);
    expect(await source.resolveCloudId(signal)).toEqual([
      { id: CLOUD, url: "https://example.atlassian.net", name: "Demo" },
    ]);
    const req = seen[0];
    expect(req?.workerProfile).toBe("collector");
    expect(req?.priorityClass).toBe("collection");
    expect(req?.model).toBe("haiku");
    expect(req?.maxTurns).toBe(4);
    expect(req?.allowedTools).toEqual([JIRA_TOOL_RESOURCES, "ToolSearch"]);
    expect(req?.instructions).toContain(JIRA_TOOL_RESOURCES);
  });

  test("tolerated extras only", async () => {
    const { source } = setup([tr(JIRA_TOOL_RESOURCES, { actionSource: "model_tool_call" }, res)]);
    expect(await source.resolveCloudId(signal)).toHaveLength(1);
  });

  for (const input of [
    { cloudId: CLOUD },
    { actionSource: "x" },
    { searchResultMode: "issues" },
    null,
  ]) {
    test(`mismatch ${JSON.stringify(input)}`, async () => {
      const { source } = setup([tr(JIRA_TOOL_RESOURCES, input, res)]);
      const e = await failure(source.resolveCloudId(signal));
      expect(e.classified.kind).toBe("incomplete_ai_output");
    });
  }

  test("no result, two results, error result", async () => {
    const one = tr(JIRA_TOOL_RESOURCES, {}, res);
    for (const rs of [
      [],
      [one, { ...one, toolUseId: "y" }],
      [tr(JIRA_TOOL_RESOURCES, {}, "e", true)],
    ]) {
      const { source } = setup(rs);
      const e = await failure(source.resolveCloudId(signal));
      expect(e.classified.kind).toBe("incomplete_ai_output");
    }
  });

  test("parse failure becomes parse_failed", async () => {
    const { source } = setup([tr(JIRA_TOOL_RESOURCES, {}, "not json")]);
    const e = await failure(source.resolveCloudId(signal));
    expect(e.classified.kind).toBe("parse_failed");
  });
});

describe("rate limits", () => {
  const cases: [string, string, string][] = [
    ["429 no retry-after", "HTTP 429 Too Many Requests", "2026-11-06T10:01:00.000Z"],
    [
      "rate limit with retry-after",
      "Rate limit exceeded. Retry-After: 120",
      "2026-11-06T10:02:00.000Z",
    ],
    ["retry-after capped at a day", "rate limited retry-after: 999999", "2026-11-07T10:00:00.000Z"],
    ["daily limit", "daily rate limit reached", "2026-11-07T00:00:00.000Z"],
  ];
  for (const [name, content, retryAfter] of cases) {
    test(`search: ${name}`, async () => {
      const { source } = setup([tr(JIRA_TOOL_SEARCH, sent(), content, true)]);
      const e = await failure(source.searchPage(args, signal));
      expect(e.classified.kind).toBe("rate_limited");
      expect(e.classified.retryAfter).toBe(retryAfter);
      expect(e.message).toBe("jira rate limited");
    });
  }
  test("resolve: rate limited", async () => {
    const { source } = setup([tr(JIRA_TOOL_RESOURCES, {}, "429", true)]);
    const e = await failure(source.resolveCloudId(signal));
    expect(e.classified.kind).toBe("rate_limited");
  });
  test("a non-rate error stays incomplete_ai_output", async () => {
    const { source } = setup([tr(JIRA_TOOL_SEARCH, sent(), "boom", true)]);
    const e = await failure(source.searchPage(args, signal));
    expect(e.classified.kind).toBe("incomplete_ai_output");
  });
});
