import type { ClaudeActivityView } from "@synapse/contracts";
import { activityHeadline } from "../../../lib/claude-activity";
import { relMinutes } from "../../../lib/format";
import { Card } from "../ui/Card";
import { Chip } from "../ui/Chip";

/**
 * The "Claude Code" card (A12): recent interactive sessions and session PRs per repository.
 * Titles and branch names are user data, rendered as plain text only.
 */
export function ClaudeCodeCard({
  activity,
  now,
}: {
  activity: ClaudeActivityView | null;
  now: Date | null;
}) {
  const live = activity?.active === true;
  return (
    <Card className="syn-claude-code">
      <div className="syn-card-head">
        <h3>Claude Code</h3>
        {activity !== null && !activity.enabled && (
          <span className="syn-card-sub">observation off</span>
        )}
      </div>
      <p className="syn-cc-headline" data-active={live}>
        <span className="syn-cc-dot" data-active={live} aria-hidden="true" />
        {activityHeadline(activity)}
      </p>
      {activity !== null && activity.health.state === "degraded" && activity.health.message && (
        <p className="syn-cc-health">{activity.health.message}</p>
      )}
      {activity?.repositories.map((r) => (
        <div key={r.repositoryId} className="syn-cc-repo">
          <div className="syn-cc-repo-name">{r.name}</div>
          <ul className="syn-cc-list">
            {r.sessions.map((s) => (
              <li key={s.sessionId} className="syn-cc-row">
                <span
                  className="syn-cc-dot"
                  data-active={s.activeNow}
                  title={s.activeNow ? "active now" : undefined}
                  aria-hidden="true"
                />
                <span className="syn-cc-title">{s.title ?? "Untitled session"}</span>
                {s.branch && <span className="syn-mono">{s.branch}</span>}
                <span className="syn-cc-when">
                  {now === null ? "-" : relMinutes(s.lastAt, now)}
                </span>
              </li>
            ))}
            {r.prs.map((p) => (
              <li key={p.url} className="syn-cc-row">
                <span className="syn-cc-title">{`PR #${p.number}`}</span>
                <span className="syn-mono">{p.repository}</span>
                {p.engineeringTaskId && <Chip tone="green">linked task</Chip>}
                <span className="syn-cc-when">
                  {now === null ? "-" : relMinutes(p.firstSeenAt, now)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </Card>
  );
}
