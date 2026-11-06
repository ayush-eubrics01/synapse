import type { DashboardOverview, UpcomingMilestone } from "@synapse/contracts";
import type { ClaudeRun, ClaudeStatus } from "../../../lib/api";
import { milestoneLabel } from "../../../lib/brain";
import { relMinutes } from "../../../lib/format";
import { QuotaBars } from "./QuotaBars";

export const seconds = (ms: number | null) => (ms === null ? "-" : `${(ms / 1000).toFixed(1)}s`);

export const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "14d 3h left" from the refresh expiry; "unknown" when missing or not yet measurable. */
function loginLeft(iso: string | null | undefined, now: Date | null): string {
  if (!iso || now === null) return "unknown";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "unknown";
  const hours = Math.floor((t - now.getTime()) / 3_600_000);
  if (hours < 0) return "expired";
  return `${Math.floor(hours / 24)}d ${hours % 24}h left`;
}

function Fact({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="syn-run-fact">
      <div className="syn-run-fact-label">{label}</div>
      <div className="syn-run-fact-value">{value}</div>
      {sub && <div className="syn-run-fact-sub">{sub}</div>}
    </div>
  );
}

/** "How Synapse is running": the pipeline track, quota and three facts. State comes from the API. */
export function Running({
  pipeline,
  status,
  runs,
  now,
  upcoming = [],
  engineeringLock,
  claudeActivity,
}: {
  pipeline: DashboardOverview["pipeline"];
  status: ClaudeStatus | null;
  runs: ClaudeRun[];
  now: Date | null;
  /** The next milestones (Phase 9); the first three are shown. */
  upcoming?: UpcomingMilestone[];
  /** The global engineering lock from the overview (Phase 10); absent until the overview loads. */
  engineeringLock?: DashboardOverview["engineeringLock"];
  /** Claude Code activity from the overview (Phase 10b); while yielding, the pipeline says so. */
  claudeActivity?: DashboardOverview["claudeActivity"];
}) {
  const last = runs[0];
  return (
    <div className="syn-running">
      <div className="syn-running-head">
        <h2>How Synapse is running</h2>
        <span className="syn-running-live">live</span>
      </div>
      <div className="syn-panel">
        {pipeline.length === 0 ? (
          <p className="syn-stages-empty">Waiting for the API.</p>
        ) : (
          <ol className="syn-stages">
            {pipeline.map((s, i) => (
              <li key={s.id} className="syn-stage">
                <div className="syn-stage-rail">
                  <span className="syn-stage-dot" data-state={s.state} />
                  {i < pipeline.length - 1 && (
                    <span className="syn-stage-line" data-state={s.state} aria-hidden="true" />
                  )}
                </div>
                <div className="syn-stage-name">{s.label}</div>
                <div className="syn-stage-what">{s.what}</div>
                <div className="syn-stage-summary">{s.summary}</div>
              </li>
            ))}
          </ol>
        )}
        {claudeActivity?.yielding && <p className="syn-stage-paused">paused while you work</p>}
        <p className="syn-panel-explainer">
          Messages are collected every 10 minutes, screened with cheap rules, and only likely-urgent
          ones go to Claude.
        </p>
        <hr className="syn-panel-divider" />
        <QuotaBars status={status} />
        <hr className="syn-panel-divider" />
        <div className="syn-run-facts">
          <Fact
            label="Claude login"
            value={loginLeft(status?.auth.refreshExpiresAt, now)}
            sub={status?.auth.slides === true ? "sliding" : undefined}
          />
          {last ? (
            <Fact
              label="Last Claude run"
              value={`${capitalise(last.status)} · ${seconds(last.durationMs)}`}
              sub={`${last.workerProfile} · ${last.model ?? "-"}`}
            />
          ) : (
            <Fact label="Last Claude run" value="No Claude runs yet." />
          )}
          {engineeringLock?.held ? (
            <Fact
              label="Engineering task"
              value={engineeringLock.taskTitle ?? "A task"}
              sub={
                engineeringLock.since && now
                  ? `lock held · since ${relMinutes(engineeringLock.since, now)}`
                  : "lock held"
              }
            />
          ) : (
            <Fact label="Engineering task" value="None running" sub="lock free" />
          )}
        </div>
        {upcoming.length > 0 && (
          <>
            <hr className="syn-panel-divider" />
            <div className="syn-run-upcoming">
              <div className="syn-run-fact-label">Upcoming</div>
              <ul className="syn-run-upcoming-list">
                {upcoming.slice(0, 3).map((m) => (
                  <li key={m.id} className="syn-run-upcoming-row">
                    <span>
                      {m.projectName} · {m.name}
                    </span>
                    <span
                      className={
                        m.overdue ? "syn-run-upcoming-due is-overdue" : "syn-run-upcoming-due"
                      }
                    >
                      {milestoneLabel(m, now)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
