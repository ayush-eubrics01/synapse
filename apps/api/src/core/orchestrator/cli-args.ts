import type { AIExecutionRequest } from "@synapse/contracts";

/**
 * `settingsOverride` is the `--settings` JSON that disables the user's plugins and hooks (R34):
 * on CLI 2.1.318 `--setting-sources ""` no longer loads claude.ai connectors, `user` does.
 */
export function buildClaudeArgs(r: AIExecutionRequest, settingsOverride: string): string[] {
  return [
    "-p",
    r.prompt,
    "--setting-sources",
    "user",
    "--settings",
    settingsOverride,
    "--disable-slash-commands",
    "--system-prompt",
    r.systemPrompt,
    "--allowedTools",
    r.allowedTools.join(","),
    "--disallowedTools",
    r.disallowedTools.join(","),
    "--model",
    r.model,
    "--max-turns",
    String(r.maxTurns),
    "--no-session-persistence",
    "--output-format",
    "stream-json",
    "--verbose",
  ];
}
