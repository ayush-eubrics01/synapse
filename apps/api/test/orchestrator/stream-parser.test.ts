import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { StreamParser } from "../../src/core/orchestrator/stream-parser";

const NOW = new Date("2026-11-05T00:00:00.000Z");
const fixture = (n: string) =>
  readFileSync(new URL(`../fixtures/streams/${n}.jsonl`, import.meta.url), "utf8");
function parse(n: string) {
  const p = new StreamParser();
  p.push(fixture(n));
  return p.end(NOW);
}

test("success: connectors, tool results, quota, result", () => {
  const r = parse("success");
  expect(r.connectors).toEqual([{ name: "claude.ai Slack", status: "pending" }]);
  expect(r.toolResults.map((t) => [t.toolUseId, t.toolName, t.content])).toEqual([
    ["toolu_1", "ToolSearch", "result-1"],
    ["toolu_2", "mcp__claude_ai_Slack__slack_search_public", "result-2aresult-2b"],
  ]);
  expect(r.toolResults[1]?.input).toEqual({ query: "query-2" });
  expect(r.finalText).toBe("text-1");
  expect(r.quota?.observedAt).toBe(NOW.toISOString());
  expect(r.quota?.fiveHour).toEqual({
    utilization: 0.01,
    status: "allowed",
    resetsAt: new Date(1793893800 * 1000).toISOString(),
  });
  expect(r.quota?.sevenDay.utilization).toBe(0.06);
  expect(r.result?.usage).toEqual({
    inputTokens: 8,
    outputTokens: 636,
    cacheCreationInputTokens: 36312,
    cacheReadInputTokens: 66869,
    costUsdEquivalent: 0.0082,
  });
  expect(r.result?.numTurns).toBe(3);
  expect(r.result?.text).toBe("DONE");
});

test("fabricated tool calls in text are not tool results", () => {
  const r = parse("fabricated");
  expect(r.toolResults).toHaveLength(0);
  expect(r.toolUses.size).toBe(0);
  expect(r.finalText).toContain('<invoke name="mcp__');
  expect(r.result?.usage.cacheReadInputTokens).toBe(0);
});

test("noise lines are ignored", () => {
  const r = parse("noisy");
  expect(r.toolResults).toHaveLength(1);
  expect(r.result?.subtype).toBe("success");
});

test("one line split across chunks parses once; final line without newline", () => {
  const line = fixture("success").split("\n")[2] as string;
  const p = new StreamParser();
  p.push(line.slice(0, 20));
  p.push(line.slice(20, 60));
  p.push(line.slice(60));
  expect(p.end(NOW).toolResults).toHaveLength(1);
});

test("truncated stream has no result", () => {
  const r = parse("truncated");
  expect(r.result).toBeUndefined();
  expect(r.quota).toBeUndefined();
  expect(r.toolResults).toHaveLength(1);
});

test("permission denials map to tool names", () => {
  expect(parse("denials").result?.permissionDenials).toEqual([
    "mcp__claude_ai_Slack__slack_send_message",
  ]);
});

test("unmatched tool_use_id recorded as unknown; last rate_limit_event wins", () => {
  const p = new StreamParser();
  p.push(
    `${JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "x", content: "c", is_error: true }] } })}\n`,
  );
  const rl = (u: number) =>
    `${JSON.stringify({ type: "rate_limit_event", rate_limit_info: { unifiedWindows: { five_hour: { utilization: u, resetsAt: 1, status: "allowed" }, seven_day: { utilization: 0, resetsAt: 2, status: "allowed" } } } })}\n`;
  p.push(rl(0.1) + rl(0.5));
  const r = p.end(NOW);
  expect(r.toolResults[0]).toMatchObject({ toolName: "unknown", isError: true });
  expect(r.quota?.fiveHour.utilization).toBe(0.5);
});

test("rate_rejected and auth_error fixtures", () => {
  const a = parse("rate_rejected");
  expect(a.quota?.fiveHour.status).toBe("rejected");
  expect(a.result?.isError).toBe(true);
  const b = parse("auth_error");
  expect(b.result?.isError).toBe(true);
  expect(b.result?.text).toBe("OAuth token has expired. Please run /login");
});

test("missing numeric fields default to 0", () => {
  const p = new StreamParser();
  p.push('{"type":"result","subtype":"success"}');
  expect(p.end(NOW).result?.usage.costUsdEquivalent).toBe(0);
});

test("init tool names are captured; absent tools default to []", () => {
  expect(parse("success").availableTools).toEqual(["ToolSearch"]);
  const p = new StreamParser();
  p.push('{"type":"system","subtype":"init","tools":["A",3,{"name":"B"}]}\n');
  expect(p.end(NOW).availableTools).toEqual(["A"]);
  expect(new StreamParser().end(NOW).availableTools).toEqual([]);
});
