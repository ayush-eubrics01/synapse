/** Port: whether the user is active in an interactive Claude Code session (ADR-036, A6). */
export interface UserActivitySignal {
  isUserActive(now: Date): { active: boolean; until: string | null };
}

export const CLAUDE_ACTIVITY_FORMAT_MESSAGE =
  "Claude Code session format not recognised; observation paused";

export type ClaudeActivityHealth = {
  state: "ok" | "disabled" | "degraded";
  message: string | null;
};

export interface ClaudeActivitySessionView {
  sessionId: string;
  title: string | null;
  branch: string | null;
  firstAt: string;
  lastAt: string;
  activeNow: boolean;
  entrypoint: string | null;
}

export interface ClaudeActivityPrView {
  url: string;
  number: number;
  repository: string;
  branch: string | null;
  firstSeenAt: string;
  engineeringTaskId?: string;
}

export interface ClaudeActivityRepositoryView {
  repositoryId: string;
  name: string;
  sessions: ClaudeActivitySessionView[];
  prs: ClaudeActivityPrView[];
}

/** A11: the `GET /api/claude/activity` body. */
export interface ClaudeActivityView {
  enabled: boolean;
  active: boolean;
  lastActiveAt: string | null;
  yielding: boolean;
  health: ClaudeActivityHealth;
  repositories: ClaudeActivityRepositoryView[];
}
