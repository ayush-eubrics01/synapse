import type { AIExecutionRequest } from "@synapse/contracts";

/**
 * `settingsOverride` is the `--settings` JSON that disables the user's plugins and hooks (R34):
 * on CLI 2.1.318 `--setting-sources ""` no longer loads claude.ai connectors, `user` does.
 * `user` also keeps the project and local sources out, so the working directory's CLAUDE.md,
 * `.claude/settings.json` and `.mcp.json` are never loaded (M1, final review).
 * `--permission-mode default` is pinned: the flag beats a user-settings `defaultMode` such as
 * `auto`, `acceptEdits` or `bypassPermissions` (final review).
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
    "--permission-mode",
    "default",
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
