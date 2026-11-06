import type { ClaudeActivityView } from "@synapse/contracts";

/** A12: the card headline. Presentation only; `yielding` and `active` are computed by the API. */
export function activityHeadline(v: ClaudeActivityView | null): string {
  if (v?.yielding) return "You're active in Claude Code: background analysis paused";
  if (v?.active) return "You're active in Claude Code";
  return "Idle";
}
