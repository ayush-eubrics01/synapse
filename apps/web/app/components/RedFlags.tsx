"use client";

import type { FlagReviewStatus, GroupedFlagsDto, SecurityFlagDto } from "../../lib/api";

const ACTIONS: { status: FlagReviewStatus; label: string }[] = [
  { status: "acknowledged", label: "Acknowledge" },
  { status: "contacted", label: "Contacted" },
  { status: "dismissed", label: "Dismiss" },
];

function Actions({
  flagId,
  onReview,
}: {
  flagId: string;
  onReview: (flagId: string, status: FlagReviewStatus) => void;
}) {
  return (
    <>
      {ACTIONS.map((a) => (
        <button key={a.status} type="button" onClick={() => onReview(flagId, a.status)}>
          {a.label}
        </button>
      ))}
    </>
  );
}

/** Controlled: the page owns the expanded set and refetches histories on every refresh. */
export function RedFlags({
  groups,
  expanded,
  history,
  onToggle,
  onReview,
}: {
  groups: GroupedFlagsDto[];
  expanded: string[];
  history: Record<string, SecurityFlagDto[]>;
  onToggle: (slackUserId: string) => void;
  onReview: (flagId: string, status: FlagReviewStatus) => void;
}) {
  if (groups.length === 0) return <p>No red flags.</p>;
  return (
    <ul style={{ listStyle: "none", padding: 0 }}>
      {groups.map((g) => {
        const open = expanded.includes(g.slackUserId);
        return (
          <li key={g.slackUserId} style={{ marginBottom: 12 }}>
            <strong>{g.name}</strong> [{g.maxSeverity}] {g.openCount} open, latest{" "}
            {new Date(g.latest.createdAt).toLocaleString()} ({g.latest.detector})
            {g.latest.permalink && (
              <>
                {" "}
                <a href={g.latest.permalink} target="_blank" rel="noreferrer noopener">
                  open
                </a>
              </>
            )}
            <div>{g.latest.excerpt}</div>
            {g.latestOpenId && <Actions flagId={g.latestOpenId} onReview={onReview} />}
            <button type="button" onClick={() => onToggle(g.slackUserId)}>
              {open ? "Hide history" : "History"}
            </button>
            {open &&
              history[g.slackUserId]?.map((f) => (
                <div key={f.id} style={{ marginLeft: 16 }}>
                  [{f.severity}] {f.status} - {f.excerpt}{" "}
                  {f.status === "open" && <Actions flagId={f.id} onReview={onReview} />}
                </div>
              ))}
          </li>
        );
      })}
    </ul>
  );
}
