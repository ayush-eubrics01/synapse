import type { Job } from "@synapse/contracts";
import type { ClaudeRun, SlackStatusDto } from "../../../lib/api";
import { relMinutes } from "../../../lib/format";
import { jobLabel } from "../../../lib/job-labels";
import { Card } from "../ui/Card";
import { Chip, type ChipTone } from "../ui/Chip";
import { seconds } from "./Running";

const STATUS: Partial<Record<Job["status"], { tone: ChipTone; text: string }>> = {
  PENDING: { tone: "amber", text: "PENDING" },
  RETRY: { tone: "amber", text: "RETRY" },
  RUNNING: { tone: "blue", text: "RUNNING" },
  COMPLETED: { tone: "green", text: "DONE" },
  FAILED: { tone: "red", text: "FAILED" },
  NEEDS_ATTENTION: { tone: "red", text: "NEEDS_ATTENTION" },
};

function backfillText(b: SlackStatusDto["backfill"]): string {
  switch (b.status) {
    case "running":
      return `running · ${b.pagesDone} pages`;
    case "complete":
      return "done";
    case "error":
      return "failed";
    case "paused":
      return `paused · ${b.pagesDone} pages`;
    default:
      return b.pagesDone > 0 || b.checkpoint !== null ? `${b.pagesDone} pages` : "not started";
  }
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="syn-kv">
      <span className="syn-kv-label">{label}</span>
      <span className="syn-kv-value">{children}</span>
    </div>
  );
}

/** The System section: background jobs, Slack collection and the Claude runs table. */
export function SystemDetails({
  jobs,
  slack,
  runs,
  onSkip,
  now,
}: {
  jobs: Job[];
  slack: SlackStatusDto | null;
  runs: ClaudeRun[];
  onSkip: () => void;
  now: Date | null;
}) {
  // The real retry limit comes from the jobs themselves (the queue default is 3).
  const maxAttempts = jobs.reduce((m, j) => Math.max(m, j.maxAttempts), 0) || 3;
  return (
    <div className="syn-system">
      <h2>System</h2>
      <div className="syn-system-cards">
        <Card>
          <div className="syn-card-head">
            <h3>Background jobs</h3>
            <span className="syn-card-sub">{`retries up to ${maxAttempts}×`}</span>
          </div>
          {jobs.length === 0 ? (
            <p className="syn-empty">No jobs yet.</p>
          ) : (
            <ul className="syn-jobs">
              {jobs.map((j) => {
                const chip = STATUS[j.status] ?? { tone: "neutral" as ChipTone, text: j.status };
                return (
                  <li key={j.id} className="syn-job">
                    <div className="syn-job-name">
                      <span className="syn-job-label">{jobLabel(j.type)}</span>
                      <span className="syn-job-type">{j.type}</span>
                    </div>
                    <Chip tone={chip.tone} mono>
                      {chip.text}
                    </Chip>
                    <span className="syn-job-meta">
                      {`${j.attempts}/${j.maxAttempts}${now !== null ? ` · ${relMinutes(j.createdAt, now)}` : ""}`}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
        <Card>
          <div className="syn-card-head">
            <h3>Slack collection</h3>
          </div>
          {slack ? (
            <>
              <Row label="Last sync">
                {now === null ? "-" : relMinutes(slack.incremental.lastSuccessAt, now)}
                {slack.incremental.lastError?.kind === "parse_failed" && (
                  <>
                    {" "}
                    <button type="button" className="syn-link-btn" onClick={onSkip}>
                      Skip unreadable page
                    </button>
                  </>
                )}
              </Row>
              <Row label="Searches today">{slack.searchesToday}</Row>
              <Row label="90-day backfill">{backfillText(slack.backfill)}</Row>
              <Row label="Checkpoint">
                <span className="syn-mono">{slack.incremental.checkpoint ?? "none"}</span>
              </Row>
            </>
          ) : (
            <p className="syn-empty">No Slack status yet.</p>
          )}
        </Card>
      </div>
      <h3 className="syn-system-sub">Claude runs</h3>
      {runs.length === 0 ? (
        <p className="syn-empty">No Claude runs yet.</p>
      ) : (
        <table className="syn-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Profile</th>
              <th>Model</th>
              <th>Duration</th>
            </tr>
          </thead>
          <tbody>
            {runs.slice(0, 10).map((r) => (
              <tr key={r.id}>
                <td>{r.status}</td>
                <td>{r.workerProfile}</td>
                <td>{r.model ?? "-"}</td>
                <td>{seconds(r.durationMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
