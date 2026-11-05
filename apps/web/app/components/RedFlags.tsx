"use client";

import { useState } from "react";
import {
  type FlagReviewStatus,
  type GroupedFlagsDto,
  getPersonFlags,
  type SecurityFlagDto,
} from "../../lib/api";

const ACTIONS: { status: FlagReviewStatus; label: string }[] = [
  { status: "acknowledged", label: "Acknowledge" },
  { status: "contacted", label: "Contacted" },
  { status: "dismissed", label: "Dismiss" },
];

export function RedFlags({
  groups,
  onReview,
}: {
  groups: GroupedFlagsDto[];
  onReview: (flagId: string, status: FlagReviewStatus) => void;
}) {
  const [history, setHistory] = useState<Record<string, SecurityFlagDto[]>>({});
  const [error, setError] = useState<string | null>(null);
  if (groups.length === 0) return <p>No red flags.</p>;

  const toggle = async (slackUserId: string) => {
    if (history[slackUserId]) {
      const { [slackUserId]: _drop, ...rest } = history;
      setHistory(rest);
      return;
    }
    try {
      setError(null);
      const flags = await getPersonFlags(slackUserId);
      setHistory({ ...history, [slackUserId]: flags });
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div>
      {error && <p style={{ color: "#c33" }}>{error}</p>}
      <ul style={{ listStyle: "none", padding: 0 }}>
        {groups.map((g) => (
          <li key={g.slackUserId} style={{ marginBottom: 12 }}>
            <strong>{g.name}</strong> [{g.maxSeverity}] {g.openCount} open, latest{" "}
            {new Date(g.latest.createdAt).toLocaleString()} ({g.latest.detector})
            <div>{g.latest.excerpt}</div>
            <button type="button" onClick={() => void toggle(g.slackUserId)}>
              {history[g.slackUserId] ? "Hide history" : "History"}
            </button>
            {history[g.slackUserId]?.map((f) => (
              <div key={f.id} style={{ marginLeft: 16 }}>
                [{f.severity}] {f.status} - {f.excerpt}{" "}
                {f.status === "open" &&
                  ACTIONS.map((a) => (
                    <button key={a.status} type="button" onClick={() => onReview(f.id, a.status)}>
                      {a.label}
                    </button>
                  ))}
              </div>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}
