"use client";

import type { CandidatesResponse } from "@synapse/contracts";
import { barWidth, type Candidate, QUEUED_NOTE, topUnqueued } from "../../../lib/people-ui";
import { Avatar } from "../ui/Avatar";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";

function note(c: Candidate): string | null {
  const parts = [
    c.hasProfile && "Profiled",
    c.hasPendingRecommendation && "Review pending",
    c.isTemporary && "Temporary contact",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function ReadyToEvaluate({
  data,
  queued,
  onEvaluate,
  onEvaluateTop,
  onOpen,
}: {
  data: CandidatesResponse | null;
  queued: ReadonlySet<string>;
  onEvaluate: (slackUserId: string) => void;
  onEvaluateTop: () => void;
  onOpen: (slackUserId: string) => void;
}) {
  const canTop =
    data !== null && !data.identityRequired && topUnqueued(data.candidates, queued).length > 0;
  return (
    <Card>
      <div className="syn-card-head syn-card-head--top">
        <div>
          <h3>Ready to evaluate</h3>
          <div className="syn-card-sub">Ranked by how much you talk to them</div>
        </div>
        <Button size="sm" disabled={!canTop} onClick={onEvaluateTop}>
          Evaluate top 3
        </Button>
      </div>
      {data === null ? (
        <p className="syn-empty">Loading candidates.</p>
      ) : data.identityRequired ? (
        <p className="syn-empty">
          Confirm your Slack identity in Needs you first: candidates are ranked by your
          conversations with them, so evaluation is unavailable until then.
        </p>
      ) : data.candidates.length === 0 ? (
        <p className="syn-empty">No one to evaluate right now.</p>
      ) : (
        <ul className="syn-prow-list">
          {data.candidates.map((c) => {
            const isQueued = queued.has(c.slackUserId);
            const n = isQueued ? QUEUED_NOTE : note(c);
            return (
              <li key={c.slackUserId} className="syn-cand">
                <Avatar id={c.slackUserId} name={c.name} size={36} />
                <div className="syn-cand-main">
                  <div className="syn-cand-line">
                    <button
                      type="button"
                      className="syn-name-btn"
                      onClick={() => onOpen(c.slackUserId)}
                    >
                      {c.name ?? c.slackUserId}
                    </button>
                    <span className="syn-cand-score">
                      score {c.score} · {c.messageCount} msgs
                    </span>
                  </div>
                  <div className="syn-bar" aria-hidden="true">
                    <div
                      className="syn-bar-fill"
                      data-strong={c.score >= 30 || undefined}
                      style={{ width: `${barWidth(c.score)}%` }}
                    />
                  </div>
                  {n && <div className="syn-cand-note">{n}</div>}
                </div>
                {c.actions.includes("evaluate") && !isQueued && (
                  <Button
                    size="sm"
                    variant={c.score >= 30 ? "primary" : "secondary"}
                    onClick={() => onEvaluate(c.slackUserId)}
                  >
                    Evaluate
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
