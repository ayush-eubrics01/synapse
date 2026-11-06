/**
 * Fake `claude` for the Jira e2e. It reads the requested search arguments from the prompt (the one
 * JSON-object line that carries `jql`), then replays a `searchJiraIssuesUsingJql` call with exactly
 * those arguments and a synthetic DEMO page, or with an altered JQL when FAKE_JIRA_MODE=altered_jql.
 */
const args = process.argv.slice(2);
const out = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);
const TOOL = "mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql";

if (args.includes("--version")) {
  process.stdout.write("2.1.318 (Claude Code)\n");
} else {
  const prompt = args[args.indexOf("-p") + 1] as string;
  const wanted = prompt
    .split("\n")
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .find((o) => o && typeof o.jql === "string") as Record<string, unknown>;
  const input =
    process.env.FAKE_JIRA_MODE === "altered_jql"
      ? { ...wanted, jql: `${wanted.jql} OR project = OTHER` }
      : wanted;

  const node = (n: number, over: Record<string, unknown> = {}) => ({
    id: `${10000 + n}`,
    key: `DEMO-${n}`,
    webUrl: `https://example.invalid/browse/DEMO-${n}`,
    fields: {
      summary: `Synthetic issue ${n}`,
      status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
      priority: { name: "High" },
      issuetype: { name: "Task" },
      project: { key: "DEMO" },
      labels: [],
      duedate: null,
      created: "2026-11-01T00:00:00.000+0000",
      updated: "2026-11-06T10:00:00.000+0000",
      ...over,
    },
  });
  const page = {
    issues: {
      nodes: [
        node(1, { duedate: "2026-11-01" }),
        node(2, { updated: "2026-11-06T10:30:00.000+0000" }),
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  };

  out({
    type: "system",
    subtype: "init",
    tools: ["ToolSearch"],
    mcp_servers: [{ name: "claude.ai Atlassian", status: "connected" }],
  });
  out({
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id: "t1", name: "ToolSearch", input: { query: `select:${TOOL}` } },
      ],
    },
  });
  out({
    type: "user",
    message: {
      content: [{ type: "tool_result", tool_use_id: "t1", content: "loaded", is_error: false }],
    },
  });
  out({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "t2", name: TOOL, input }] },
  });
  out({
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "t2",
          content: [{ type: "text", text: JSON.stringify(page) }],
          is_error: false,
        },
      ],
    },
  });
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 3,
    duration_ms: 4000,
    total_cost_usd: 0.004,
    usage: {
      input_tokens: 8,
      output_tokens: 6,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    permission_denials: [],
    result: "DONE",
  });
}
