import { expect, test } from "bun:test";
import type { AIExecutionResult } from "@synapse/contracts";
import { denyVerdict, parseArgs, summarize } from "../claude-smoke";

test("parseArgs", () => {
  expect(parseArgs([])).toEqual({ mode: "no-tools" });
  expect(parseArgs(["--no-tools"])).toEqual({ mode: "no-tools" });
  expect(parseArgs(["--deny-check"])).toEqual({ mode: "deny-check" });
  expect(parseArgs(["--help"])).toEqual({ mode: "help" });
  expect(() => parseArgs(["--bogus"])).toThrow();
  expect(() => parseArgs(["--no-tools", "--deny-check"])).toThrow();
});

const result: AIExecutionResult = {
  status: "succeeded",
  toolResults: [
    { toolUseId: "t1", toolName: "X", input: {}, isError: false, content: "SECRET-TOOL-CONTENT" },
  ],
  finalText: "SECRET-FINAL-TEXT",
  numTurns: 2,
  durationMs: 1234,
  usage: {
    inputTokens: 10,
    outputTokens: 5,
    cacheCreationInputTokens: 1,
    cacheReadInputTokens: 2,
    costUsdEquivalent: 0.01,
  },
  quota: {
    observedAt: "2026-11-05T00:00:00.000Z",
    fiveHour: { utilization: 0.01, status: "allowed", resetsAt: "2026-11-05T05:00:00.000Z" },
    sevenDay: { utilization: 0.06, status: "allowed", resetsAt: "2026-11-10T00:00:00.000Z" },
  },
  permissionDenials: [],
  connectors: [{ name: "claude.ai Slack", status: "connected" }],
  availableTools: ["ToolSearch"],
  exitCode: 0,
};

test("summarize prints fields but never finalText or tool content", () => {
  const out = summarize(result, "run1").join("\n");
  expect(out).toContain("status: succeeded");
  expect(out).toContain("turns: 2");
  expect(out).toContain("toolResults: 1");
  expect(out).toContain("claude.ai Slack = connected");
  expect(out).toContain("runId: run1");
  expect(out).not.toContain("SECRET-FINAL-TEXT");
  expect(out).not.toContain("SECRET-TOOL-CONTENT");
});

test("denyVerdict", () => {
  const slack = "mcp__claude_ai_Slack__slack_search_users";
  expect(denyVerdict(["ToolSearch", slack])).toBe("PASS");
  expect(denyVerdict(["ToolSearch"])).toBe("INCONCLUSIVE");
  expect(denyVerdict([slack, "mcp__claude_ai_Gmail__send_message"])).toBe("FAIL");
});
