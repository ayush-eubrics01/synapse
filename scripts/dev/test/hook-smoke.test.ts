import { expect, test } from "bun:test";
import type { RawToolResult } from "@synapse/contracts";
import { classifyHookSmoke } from "../hook-smoke";

const TOOL = "mcp__claude_ai_Slack__slack_search_users";
const tr = (over: Partial<RawToolResult>): RawToolResult => ({
  toolUseId: "t1",
  toolName: TOOL,
  input: {},
  isError: false,
  content: "x",
  ...over,
});

test("a non-error result for the guarded tool is NOT blocked, even with a denial listed", () => {
  expect(classifyHookSmoke({ toolResults: [tr({})], permissionDenials: [] })).toBe("not_blocked");
  expect(classifyHookSmoke({ toolResults: [tr({})], permissionDenials: [TOOL] })).toBe(
    "not_blocked",
  );
});

test("no successful result plus a denial for the tool is blocked", () => {
  expect(classifyHookSmoke({ toolResults: [], permissionDenials: [TOOL] })).toBe("blocked");
});

test("an error result mentioning the guard reason is blocked", () => {
  const r = tr({
    isError: true,
    content: "blocked: send arguments differ from the approved message",
  });
  expect(classifyHookSmoke({ toolResults: [r], permissionDenials: [] })).toBe("blocked");
});

test("an error result for another reason, or no evidence at all, is inconclusive", () => {
  expect(
    classifyHookSmoke({
      toolResults: [tr({ isError: true, content: "timeout" })],
      permissionDenials: [],
    }),
  ).toBe("inconclusive");
  expect(classifyHookSmoke({ toolResults: [], permissionDenials: [] })).toBe("inconclusive");
  expect(classifyHookSmoke({ toolResults: [], permissionDenials: ["Bash"] })).toBe("inconclusive");
});

test("a successful result for a different tool does not count as NOT blocked", () => {
  expect(
    classifyHookSmoke({ toolResults: [tr({ toolName: "ToolSearch" })], permissionDenials: [TOOL] }),
  ).toBe("blocked");
});
