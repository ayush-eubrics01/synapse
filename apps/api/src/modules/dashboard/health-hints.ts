/** Plain-language names for health checks, keyed by check name. */
export const HEALTH_LABELS: Record<string, string> = {
  database: "Database",
  jobs: "Background jobs",
  events: "Event delivery",
  heartbeat: "Scheduler heartbeat",
  linger: "Services after logout",
  bun: "Bun version",
  auth: "Claude login",
  claude: "Claude CLI",
  "security-rules": "Security rules",
  "screening-rules": "Screening rules",
  "desktop-notifier": "Desktop notifications",
  claude_activity: "Claude Code activity",
};

/** What to do about a failing check. A check with no entry has no hint. */
export const HEALTH_HINTS: Record<string, string> = {
  jobs: "Wait for the next scheduler tick. If jobs are still pending after 15 minutes, check the API logs.",
  heartbeat: "The scheduler isn't ticking. Restart the API service.",
  auth: "Run `claude` once in a terminal to refresh the login.",
  claude: "Check that `claude` is on the service PATH (bun scripts/setup/check-env.ts).",
  linger: "Run `loginctl enable-linger $USER` so services keep running after logout.",
  events: "An event consumer exhausted its retries. Check the API logs for the event type.",
  "desktop-notifier": "Install `notify-send` (libnotify) for desktop alerts.",
  database: "SQLite isn't in WAL mode. Restart the API, which re-applies the pragmas.",
  "security-rules": "A rule file failed to load. Check the API logs.",
  "screening-rules": "A rule file failed to load. Check the API logs.",
  claude_activity:
    "Observation of your Claude Code sessions is paused. Other features are unaffected; check the projects directory is readable, or that Claude Code was updated.",
  bun: "Upgrade Bun to 1.4.4 or newer.",
};
