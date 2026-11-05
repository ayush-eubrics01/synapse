import { describe, expect, test } from "bun:test";
import type { AIExecutionRequest, PromptPart } from "@synapse/contracts";
import { assemblePrompt } from "../../src/core/orchestrator/prompt";
import {
  buildDenylist,
  classifyTool,
  connectorServerOf,
  DEFAULT_KNOWN_SERVERS,
  KNOWN_WRITE_TOOLS,
} from "../../src/core/orchestrator/tool-catalog";
import { validateRequest } from "../../src/core/orchestrator/validator";

const SEARCH = "mcp__claude_ai_Slack__slack_search_public";
const SEND = "mcp__claude_ai_Slack__slack_send_message";
const untrusted: PromptPart = { provenance: "untrusted", source: "slack", content: "hi" };

function make(over: Partial<AIExecutionRequest> & { allowed?: string[] } = {}): AIExecutionRequest {
  const allowedTools = over.allowed ?? [SEARCH, "ToolSearch"];
  const workerProfile = over.workerProfile ?? "collector";
  const promptParts = over.promptParts ?? [untrusted];
  return {
    runId: "r",
    jobId: null,
    workerProfile,
    model: "haiku",
    systemPrompt: "s",
    prompt: assemblePrompt("go", promptParts, "BND"),
    promptParts,
    allowedTools,
    disallowedTools: buildDenylist(allowedTools, DEFAULT_KNOWN_SERVERS, workerProfile),
    maxTurns: 3,
    timeoutMs: 1000,
    workingDirectory: "/tmp",
    ...over,
  };
}
const ASSEMBLY = { instructions: "go", boundary: "BND" };
const v = (r: AIExecutionRequest, a = ASSEMBLY) => validateRequest(r, DEFAULT_KNOWN_SERVERS, a);
const reason = (r: ReturnType<typeof validateRequest>) => (r.ok ? "ok" : r.reason);

describe("validateRequest", () => {
  test("valid collector", () => {
    expect(v(make())).toEqual({ ok: true });
  });
  test("valid engineering without untrusted", () => {
    const r = make({
      workerProfile: "engineering",
      allowed: ["Read", "Edit", "Bash"],
      promptParts: [
        { provenance: "system", content: "x" },
        { provenance: "user_approved", content: "y" },
      ],
    });
    expect(v(r)).toEqual({ ok: true });
  });
  test("valid send run", () => {
    const r = make({
      allowed: [SEND, "ToolSearch"],
      promptParts: [{ provenance: "user_approved", content: "t" }],
    });
    expect(v(r)).toEqual({ ok: true });
  });
  test("rule 0 profile", () => {
    const r = make({ allowed: ["Bash"], promptParts: [] });
    expect(reason(v(r))).toBe("profile collector may not use Bash");
    const i = make({ workerProfile: "intelligence", allowed: ["WebFetch"], promptParts: [] });
    expect(reason(v(i))).toBe("profile intelligence may not use WebFetch");
  });
  test("rule 1 untrusted with write tool", () => {
    const r = make({ workerProfile: "intelligence", allowed: [SEARCH, SEND, "ToolSearch"] });
    expect(reason(v(r))).toBe(`untrusted content with write-capable tool ${SEND}`);
  });
  test("R22 network rejected in every profile, even engineering", () => {
    const r = make({ workerProfile: "engineering", allowed: ["WebFetch"], promptParts: [] });
    expect(reason(v(r))).toBe("profile engineering may not use WebFetch");
    expect(buildDenylist(["WebFetch"], DEFAULT_KNOWN_SERVERS, "engineering")).toContain("WebFetch");
  });
  test("rule 2 engineering untrusted", () => {
    const r = make({ workerProfile: "engineering", allowed: ["Read"] });
    expect(reason(v(r))).toBe("engineering run with untrusted content");
  });
  test("rule 3 ToolSearch", () => {
    const r = make({ allowed: [SEARCH] });
    expect(reason(v(r))).toBe("ToolSearch required for connector tools");
  });
  test("rule 4 denylist", () => {
    const r = make({ disallowedTools: ["Bash"] });
    expect(reason(v(r))).toBe("denylist missing mcp__claude_ai_Atlassian");
  });
  test("R20 engineering may not use connector tools", () => {
    const r = make({
      workerProfile: "engineering",
      allowed: ["Bash", SEARCH, "ToolSearch"],
      promptParts: [],
    });
    expect(reason(v(r))).toBe(`profile engineering may not use connector tool ${SEARCH}`);
  });
  test("R21 write tool only with ToolSearch", () => {
    const r = make({ allowed: [SEARCH, SEND, "ToolSearch"], promptParts: [] });
    expect(reason(v(r))).toBe(`send run may only allow ${SEND} and ToolSearch`);
  });
  test("R23 specifier stripped", () => {
    const r = make({ allowed: ["Bash(curl:*)"], promptParts: [] });
    expect(reason(v(r))).toBe("profile collector may not use Bash");
  });
  test.each(["Monitor", "Task", "MultiEdit"])("R23 collector may not use %s", (t) => {
    const r = make({ allowed: [t], promptParts: [] });
    expect(reason(v(r))).toBe(`profile collector may not use ${t}`);
  });
  test("R23 unknown builtin fails closed", () => {
    const r = make({ workerProfile: "engineering", allowed: ["Foo"], promptParts: [] });
    expect(reason(v(r))).toBe("unknown built-in tool Foo");
  });
  test("R24 prompt must match parts", () => {
    const r = make({ prompt: "tampered" });
    expect(reason(v(r))).toBe("prompt does not match declared parts");
  });
  test("R24 empty boundary", () => {
    expect(v(make(), { instructions: "go", boundary: "  " }).ok).toBe(false);
    expect(v(make(), { instructions: "go", boundary: "" }).ok).toBe(false);
  });
  test("R26 malformed tool names rejected", () => {
    const cases: [string, string[], "collector" | "engineering"][] = [
      [
        "N1",
        [
          SEND,
          "ToolSearch(x),mcp__claude_ai_Slack__slack_read_channel,mcp__claude_ai_Slack__slack_search_public_and_private",
        ],
        "collector",
      ],
      ["N2", ["Read(x),Foo", "Bash"], "engineering"],
      ["N3b", ["Bash(x),mcp__newsrv__read_doc"], "engineering"],
      ["glob", ["mcp__claude_ai_Slack__*", "ToolSearch"], "collector"],
      ["space", ["Bash(git status)"], "engineering"],
    ];
    for (const [, tools, profile] of cases) {
      const r = make({ workerProfile: profile, allowed: tools, promptParts: [] });
      expect(reason(v(r))).toBe(
        `malformed tool name ${tools.find((t) => t.includes(",") || t.includes("*") || t.includes(" ")) ?? ""}`,
      );
    }
  });
  test("R26 Bash(git:*) accepted on engineering", () => {
    const r = make({
      workerProfile: "engineering",
      allowed: ["Read", "Bash(git:*)"],
      promptParts: [],
    });
    expect(v(r)).toEqual({ ok: true });
  });
  test("R26 denylist must cover network and write built-ins", () => {
    const full = buildDenylist([SEARCH, "ToolSearch"], DEFAULT_KNOWN_SERVERS, "collector");
    expect(reason(v(make({ disallowedTools: full.filter((t) => t !== "WebFetch") })))).toBe(
      "denylist missing WebFetch",
    );
    expect(reason(v(make({ disallowedTools: full.filter((t) => t !== "Bash") })))).toBe(
      "denylist missing Bash",
    );
  });
  test("rule 6 boundary collision", () => {
    const parts: PromptPart[] = [{ provenance: "untrusted", source: "s", content: "xx BND yy" }];
    expect(
      reason(v(make({ promptParts: parts, prompt: assemblePrompt("go", parts, "BND") }))),
    ).toBe("boundary collision");
  });
});

describe("tool catalog", () => {
  test("R25 new servers denied", () => {
    const d = buildDenylist([SEARCH, "ToolSearch"], DEFAULT_KNOWN_SERVERS, "collector");
    for (const s of [
      "mcp__claude_ai_Apollo_io",
      "mcp__claude_ai_Exa",
      "mcp__claude_ai_n8n",
      "mcp__rea",
      "mcp__plugin_postman_postman",
      "mcp__claude_ai_monday_com",
    ]) {
      expect(d).toContain(s);
    }
  });
  test("R25 listJiraIssueComments is read", () => {
    expect(classifyTool("mcp__claude_ai_Atlassian_MCP__listJiraIssueComments")).toBe("read");
  });
  test("every KNOWN_WRITE_TOOLS entry classifies as write", () => {
    for (const [server, tools] of Object.entries(KNOWN_WRITE_TOOLS)) {
      for (const t of tools) expect(classifyTool(`${server}__${t}`)).toBe("write");
    }
  });
  test("classify", () => {
    expect(classifyTool(SEARCH)).toBe("read");
    expect(classifyTool(SEND)).toBe("write");
    expect(classifyTool("mcp__claude_ai_Atlassian__getJiraIssue")).toBe("read");
    expect(classifyTool("mcp__claude_ai_Atlassian_MCP__executeRead")).toBe("read");
    expect(classifyTool("mcp__claude_ai_Atlassian_MCP__executeWrite")).toBe("write");
    expect(classifyTool("mcp__claude_ai_Atlassian__createJiraIssue")).toBe("write");
    expect(classifyTool("mcp__claude_ai_Gmail__get_message")).toBe("write");
    expect(classifyTool("Bash")).toBe("builtin_write");
    expect(classifyTool("Read")).toBe("builtin_read");
    expect(classifyTool("WebFetch")).toBe("write");
    expect(classifyTool("Mystery")).toBe("write");
  });
  test("connectorServerOf", () => {
    expect(connectorServerOf(SEND)).toBe("mcp__claude_ai_Slack");
    expect(connectorServerOf("Bash")).toBeNull();
  });
  test("denylist for slack search collector", () => {
    const d = buildDenylist([SEARCH, "ToolSearch"], DEFAULT_KNOWN_SERVERS, "collector");
    expect(d).toContain("mcp__claude_ai_Gmail");
    expect(d).toContain("mcp__claude_ai_Atlassian");
    expect(d).toContain(SEND);
    expect(d).toContain("Bash");
    expect(d).not.toContain("mcp__claude_ai_Slack");
    expect(d).not.toContain(SEARCH);
    expect(d).toEqual([...d].sort());
    expect(new Set(d).size).toBe(d.length);
  });
  test("engineering denylist leaves builtin write", () => {
    const d = buildDenylist(["Edit"], DEFAULT_KNOWN_SERVERS, "engineering");
    expect(d).not.toContain("Edit");
    expect(d).toContain("WebFetch");
  });
  test("denylist never contains allowed", () => {
    const d = buildDenylist([SEND, "ToolSearch"], DEFAULT_KNOWN_SERVERS, "collector");
    expect(d).not.toContain(SEND);
  });
});
