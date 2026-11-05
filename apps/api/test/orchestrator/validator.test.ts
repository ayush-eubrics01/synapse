import { describe, expect, test } from "bun:test";
import type { AIExecutionRequest, PromptPart } from "@synapse/contracts";
import { assemblePrompt } from "../../src/core/orchestrator/prompt";
import {
  buildDenylist,
  classifyTool,
  connectorServerOf,
  DEFAULT_KNOWN_SERVERS,
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
const reason = (r: ReturnType<typeof validateRequest>) => (r.ok ? "ok" : r.reason);

describe("validateRequest", () => {
  test("valid collector", () => {
    expect(validateRequest(make(), DEFAULT_KNOWN_SERVERS)).toEqual({ ok: true });
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
    expect(validateRequest(r, DEFAULT_KNOWN_SERVERS)).toEqual({ ok: true });
  });
  test("valid send run", () => {
    const r = make({
      allowed: [SEND, "ToolSearch"],
      promptParts: [{ provenance: "user_approved", content: "t" }],
    });
    expect(validateRequest(r, DEFAULT_KNOWN_SERVERS)).toEqual({ ok: true });
  });
  test("rule 0 profile", () => {
    const r = make({ allowed: ["Bash"], promptParts: [] });
    expect(reason(validateRequest(r, DEFAULT_KNOWN_SERVERS))).toBe(
      "profile collector may not use Bash",
    );
    const i = make({ workerProfile: "intelligence", allowed: ["WebFetch"], promptParts: [] });
    expect(reason(validateRequest(i, DEFAULT_KNOWN_SERVERS))).toBe(
      "profile intelligence may not use WebFetch",
    );
  });
  test("rule 1 untrusted with write tool", () => {
    const r = make({ workerProfile: "intelligence", allowed: [SEARCH, SEND, "ToolSearch"] });
    expect(reason(validateRequest(r, DEFAULT_KNOWN_SERVERS))).toBe(
      `untrusted content with write-capable tool ${SEND}`,
    );
  });
  test("rule 1 counts network tools on engineering", () => {
    const r = make({ workerProfile: "engineering", allowed: ["WebFetch"] });
    expect(reason(validateRequest(r, DEFAULT_KNOWN_SERVERS))).toBe(
      "untrusted content with write-capable tool WebFetch",
    );
  });
  test("rule 2 engineering untrusted", () => {
    const r = make({ workerProfile: "engineering", allowed: ["Read"] });
    expect(reason(validateRequest(r, DEFAULT_KNOWN_SERVERS))).toBe(
      "engineering run with untrusted content",
    );
  });
  test("rule 3 ToolSearch", () => {
    const r = make({ allowed: [SEARCH] });
    expect(reason(validateRequest(r, DEFAULT_KNOWN_SERVERS))).toBe(
      "ToolSearch required for connector tools",
    );
  });
  test("rule 4 denylist", () => {
    const r = make({ disallowedTools: ["Bash"] });
    expect(reason(validateRequest(r, DEFAULT_KNOWN_SERVERS))).toBe(
      "denylist missing mcp__claude_ai_Atlassian",
    );
  });
  test("rule 5 send run with untrusted in prompt", () => {
    const r = make({
      allowed: [SEND, "ToolSearch"],
      promptParts: [{ provenance: "user_approved", content: "t" }],
      prompt: assemblePrompt("go", [untrusted], "BND"),
    });
    expect(reason(validateRequest(r, DEFAULT_KNOWN_SERVERS))).toBe(
      "send run with untrusted content",
    );
  });
  test("rule 6 boundary collision", () => {
    const parts: PromptPart[] = [{ provenance: "untrusted", source: "s", content: "xx BND yy" }];
    expect(
      reason(
        validateRequest(
          make({ promptParts: parts, prompt: assemblePrompt("go", parts, "BND") }),
          DEFAULT_KNOWN_SERVERS,
        ),
      ),
    ).toBe("boundary collision");
  });
});

describe("tool catalog", () => {
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
