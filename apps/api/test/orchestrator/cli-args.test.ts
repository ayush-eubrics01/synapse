import { expect, test } from "bun:test";
import type { AIExecutionRequest } from "@synapse/contracts";
import { buildClaudeArgs } from "../../src/core/orchestrator/cli-args";

const req: AIExecutionRequest = {
  runId: "r",
  jobId: null,
  workerProfile: "collector",
  model: "haiku",
  systemPrompt: "sys",
  prompt: "hi",
  promptParts: [],
  allowedTools: ["a", "b"],
  disallowedTools: ["c", "d"],
  maxTurns: 3,
  timeoutMs: 1000,
  workingDirectory: "/tmp",
};

test("exact argv", () => {
  const a = buildClaudeArgs(req);
  expect(a).toEqual([
    "-p",
    "hi",
    "--setting-sources",
    "",
    "--disable-slash-commands",
    "--system-prompt",
    "sys",
    "--allowedTools",
    "a,b",
    "--disallowedTools",
    "c,d",
    "--model",
    "haiku",
    "--max-turns",
    "3",
    "--no-session-persistence",
    "--output-format",
    "stream-json",
    "--verbose",
  ]);
  expect(a).not.toContain("--bare");
  expect(a).not.toContain("--tools");
});
