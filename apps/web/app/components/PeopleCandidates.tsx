"use client";

import type { CandidatesResponse } from "@synapse/contracts";

export function PeopleCandidates({
  data,
  onEvaluate,
  onOpen,
}: {
  data: CandidatesResponse | null;
  onEvaluate: (slackUserId: string) => void;
  onOpen?: (slackUserId: string) => void;
}) {
  if (!data) return <p>Loading candidates.</p>;
  if (data.identityRequired) {
    return (
      <p>
        Confirm your Slack identity above first: candidates are ranked by your conversations with
        them, so evaluation is unavailable until then.
      </p>
    );
  }
  if (data.candidates.length === 0) return <p>No candidates yet.</p>;
  return (
    <table style={{ borderCollapse: "collapse" }}>
      <tbody>
        {data.candidates.map((c) => (
          <tr key={c.slackUserId}>
            <td style={{ paddingRight: 12 }}>{c.name ?? c.slackUserId}</td>
            <td style={{ paddingRight: 12 }}>score {c.score}</td>
            <td style={{ paddingRight: 12 }}>{c.messageCount} messages</td>
            <td style={{ paddingRight: 12 }}>
              {c.hasProfile && "profiled "}
              {c.hasPendingRecommendation && "review pending "}
              {c.isTemporary && "temporary"}
            </td>
            <td>
              {c.actions.includes("evaluate") && (
                <button type="button" onClick={() => onEvaluate(c.slackUserId)}>
                  Evaluate
                </button>
              )}{" "}
              {onOpen && (
                <button type="button" onClick={() => onOpen(c.slackUserId)}>
                  Open
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
