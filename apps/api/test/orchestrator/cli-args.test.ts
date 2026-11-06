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

// `--setting-sources user` is the control that keeps the inspected repository's own CLAUDE.md,
// .claude/settings.json and .mcp.json out of a run: the project and local sources are never
// loaded (checked in the CLI bundle in the Phase 9 final review). `--permission-mode default` is
// pinned because a CLI flag beats a user-settings `defaultMode` (auto, acceptEdits, bypass...).
test("exact argv", () => {
  const override = '{"enabledPlugins":{"p@m":false},"hooks":{}}';
  const a = buildClaudeArgs(req, override);
  expect(a).toEqual([
    "-p",
    "hi",
    "--setting-sources",
    "user",
    "--settings",
    override,
    "--disable-slash-commands",
    "--permission-mode",
    "default",
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
  expect(a).not.toContain("--dangerously-skip-permissions");
  expect(a[a.indexOf("--permission-mode") + 1]).toBe("default");
});

test("a Bash prefix grant with a space stays one comma-joined --allowedTools entry", () => {
  const args = buildClaudeArgs(
    { ...req, allowedTools: ["Edit(//tmp/x/**)", "Bash(bun test:*)"] },
    "{}",
  );
  expect(args[args.indexOf("--allowedTools") + 1]).toBe("Edit(//tmp/x/**),Bash(bun test:*)");
});
