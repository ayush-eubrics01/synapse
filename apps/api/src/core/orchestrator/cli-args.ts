import type { AIExecutionRequest } from "@synapse/contracts";

export function buildClaudeArgs(r: AIExecutionRequest): string[] {
  return [
    "-p",
    r.prompt,
    "--setting-sources",
    "",
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
