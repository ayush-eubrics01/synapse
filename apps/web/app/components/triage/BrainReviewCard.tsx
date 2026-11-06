"use client";

import { factKindLabel } from "../../../lib/brain";
import type { BrainReviewFact } from "../../../lib/needs-you";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { Actions, CardFrame } from "./CardFrame";

const SHOWN = 5;

/** Facts the inspection proposed: approve or reject each here, or open the project to edit. */
export function BrainReviewCard({
  facts,
  onAccept,
  onReject,
  onSeeAll,
}: {
  facts: BrainReviewFact[];
  onAccept: (factId: string) => void;
  onReject: (factId: string) => void;
  onSeeAll: () => void;
}) {
  const n = facts.length;
  const more = n - SHOWN;
  return (
    <CardFrame
      tag="PROJECTS · REVIEW"
      tone="amber"
      title={`${n} ${n === 1 ? "fact needs" : "facts need"} review`}
    >
      <ul className="syn-brain-facts">
        {facts.slice(0, SHOWN).map((r) => (
          <li key={r.fact.id} className="syn-brain-fact is-pending">
            <Chip mono>{factKindLabel(r.fact.kind)}</Chip>
            <span className="syn-brain-fact-text">
              {r.fact.content} <span className="syn-ncard-faint">{r.projectName}</span>
            </span>
            <span className="syn-brain-fact-actions">
              <Button variant="primary" size="sm" onClick={() => onAccept(r.fact.id)}>
                Accept
              </Button>
              <Button variant="ghost" size="sm" onClick={() => onReject(r.fact.id)}>
                Reject
              </Button>
            </span>
          </li>
        ))}
      </ul>
      {more > 0 && <p className="syn-ncard-faint">+{more} more</p>}
      <Actions>
        <Button variant="link" onClick={onSeeAll}>
          Review and edit in Projects →
        </Button>
      </Actions>
    </CardFrame>
  );
}
