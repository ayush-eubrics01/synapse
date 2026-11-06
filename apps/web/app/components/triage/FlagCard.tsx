"use client";

import type { FlagReviewStatus, GroupedFlagsDto, SecurityFlagDto } from "../../../lib/api";
import { flagKey } from "../../../lib/needs-you";
import { Button } from "../ui/Button";
import { Actions, CardFrame, Explainer, metaLine, Quote, SlackLink } from "./CardFrame";

export const UNTRUSTED_LINE =
  "This text is marked untrusted and never reaches a worker that can send, edit or run anything.";

const REVIEW: {
  status: FlagReviewStatus;
  label: string;
  variant: "primary" | "secondary" | "ghost";
}[] = [
  { status: "acknowledged", label: "Acknowledge", variant: "primary" },
  { status: "contacted", label: "Contacted", variant: "secondary" },
  { status: "dismissed", label: "Dismiss", variant: "ghost" },
];

function ReviewButtons({
  flagId,
  size,
  onReview,
}: {
  flagId: string;
  size?: "sm";
  onReview: (flagId: string, status: FlagReviewStatus) => void;
}) {
  return (
    <>
      {REVIEW.map((r) => (
        <Button
          key={r.status}
          variant={r.variant}
          size={size}
          onClick={() => onReview(flagId, r.status)}
        >
          {r.label}
        </Button>
      ))}
    </>
  );
}

/** One card per person. The page owns the expanded set and refetches histories on every refresh. */
export function FlagCard({
  group: g,
  now,
  open,
  history,
  hidden,
  onToggle,
  onReview,
}: {
  group: GroupedFlagsDto;
  now: Date | null;
  open: boolean;
  history: SecurityFlagDto[] | undefined;
  /** Flags pending a deferred review: left out of the history. */
  hidden: Set<string>;
  onToggle: (slackUserId: string) => void;
  onReview: (flagId: string, status: FlagReviewStatus) => void;
}) {
  const rows = (history ?? []).filter((f) => !hidden.has(flagKey(f.id)));
  return (
    <CardFrame
      tag={`RED FLAG · ${g.maxSeverity.toUpperCase()}`}
      tone="red"
      meta={metaLine(g.latest.createdAt, now, g.latest.detector)}
      title={`${g.name} · ${g.openCount} open ${g.openCount === 1 ? "flag" : "flags"}`}
    >
      <Quote>{g.latest.excerpt}</Quote>
      <Explainer>{UNTRUSTED_LINE}</Explainer>
      <Actions
        end={
          <>
            <SlackLink href={g.latest.permalink} />
            <Button variant="link" aria-expanded={open} onClick={() => onToggle(g.slackUserId)}>
              History ↗
            </Button>
          </>
        }
      >
        {g.latestOpenId && <ReviewButtons flagId={g.latestOpenId} onReview={onReview} />}
      </Actions>
      {open && (
        <ul className="syn-ncard-history">
          {history === undefined && <li className="syn-ncard-explainer">Loading history…</li>}
          {rows.map((f) => (
            <li key={f.id} className="syn-ncard-history-row">
              <span className="syn-ncard-history-meta">
                {f.severity} · {f.status}
              </span>
              <span className="syn-ncard-history-text">{f.excerpt}</span>
              {f.status === "open" && (
                <span className="syn-ncard-history-actions">
                  <ReviewButtons flagId={f.id} size="sm" onReview={onReview} />
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </CardFrame>
  );
}
