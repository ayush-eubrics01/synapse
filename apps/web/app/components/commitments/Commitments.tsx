"use client";

import type { CommitmentFilter } from "@synapse/contracts";
import type { CommitmentStatusDto, CommitmentViewDto } from "../../../lib/api";
import { Avatar } from "../ui/Avatar";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Chip } from "../ui/Chip";

export const FILTER_TABS: { filter: CommitmentFilter; label: string }[] = [
  { filter: "all", label: "All" },
  { filter: "mine", label: "Mine" },
  { filter: "theirs", label: "Theirs" },
  { filter: "overdue", label: "Overdue" },
  { filter: "due_soon", label: "Due soon" },
  { filter: "blocked", label: "Blocked" },
  { filter: "closed", label: "Closed" },
];
// The server decides which of these appear in `actions`; this only names the target status.
const STATUS_ACTIONS: Record<string, { status: CommitmentStatusDto; label: string }> = {
  start: { status: "in_progress", label: "Start" },
  block: { status: "blocked", label: "Block" },
  unblock: { status: "open", label: "Unblock" },
  complete: { status: "completed", label: "Complete" },
  cancel: { status: "cancelled", label: "Cancel" },
};
const EXPIRED = "original message no longer available locally";

/** Commitments waiting for review are decided in Needs you; this is how many there are. */
export function reviewCount(queue: CommitmentViewDto[]): number {
  return queue.filter((c) => c.actions.includes("accept")).length;
}

function Sources({ c }: { c: CommitmentViewDto }) {
  if (c.sources.length === 0) return null;
  return (
    <ul className="syn-ccard-sources">
      {c.sources.map((s) => (
        <li key={s.sourceExternalRef}>
          {s.messageAvailable ? (
            s.permalink ? (
              <a href={s.permalink} target="_blank" rel="noreferrer noopener">
                source message
              </a>
            ) : (
              "source message"
            )
          ) : (
            <em>{EXPIRED}</em>
          )}
        </li>
      ))}
    </ul>
  );
}

function CommitmentCard({
  c,
  onStatus,
  onProposal,
  onDraftFollowup,
}: {
  c: CommitmentViewDto;
  onStatus: (id: string, status: CommitmentStatusDto) => void;
  onProposal: (updateId: string, accept: boolean) => void;
  onDraftFollowup: (id: string) => void;
}) {
  const mine = c.direction === "mine";
  // The other person: who you owe, or who owes you.
  const otherId = (mine ? c.counterpartySlackUserId : c.ownerSlackUserId) ?? "unknown";
  const otherName = mine ? c.counterpartyName : c.ownerName;
  return (
    <Card>
      <div className="syn-ccard-top">
        <Chip tone={mine ? "amber" : "blue"}>{mine ? "You owe" : "Owed to you"}</Chip>
        <Chip mono>{c.status.replace("_", " ")}</Chip>
        {c.stalledAt && <Chip tone="amber">stalled</Chip>}
      </div>
      <p className="syn-ccard-desc">{c.description}</p>
      <div className="syn-ccard-meta">
        <Avatar id={otherId} name={otherName} size={20} />
        <span>{otherName ?? otherId}</span>
        {c.dueAt && <span>due {new Date(c.dueAt).toLocaleString()}</span>}
      </div>
      <Sources c={c} />
      {c.proposals.length > 0 &&
        c.actions.includes("confirm_proposal") &&
        c.proposals.map((p) => (
          <div key={p.updateId} className="syn-ccard-proposal">
            <em>Completion proposed by Claude</em>
            <Button size="sm" variant="primary" onClick={() => onProposal(p.updateId, true)}>
              Confirm completed
            </Button>
            <Button size="sm" onClick={() => onProposal(p.updateId, false)}>
              Reject proposal
            </Button>
          </div>
        ))}
      <div className="syn-ccard-actions">
        {c.actions.map((a) => {
          const s = STATUS_ACTIONS[a];
          return s ? (
            <Button key={a} size="sm" onClick={() => onStatus(c.id, s.status)}>
              {s.label}
            </Button>
          ) : null;
        })}
        {c.actions.includes("draft_followup") && (
          <Button size="sm" onClick={() => onDraftFollowup(c.id)}>
            Draft follow-up
          </Button>
        )}
      </div>
    </Card>
  );
}

export function Commitments({
  queue,
  items,
  filter,
  onFilter,
  onStatus,
  onProposal,
  onDraftFollowup,
  onGoToReview,
}: {
  /** Commitments pending review (the `review` filter); decided in Needs you, only counted here. */
  queue: CommitmentViewDto[];
  items: CommitmentViewDto[];
  filter: CommitmentFilter;
  onFilter: (f: CommitmentFilter) => void;
  onStatus: (id: string, status: CommitmentStatusDto) => void;
  onProposal: (updateId: string, accept: boolean) => void;
  onDraftFollowup: (id: string) => void;
  onGoToReview: () => void;
}) {
  const waiting = reviewCount(queue);
  return (
    <>
      <div className="syn-sec-head">
        <h2>Commitments</h2>
        <p className="syn-sec-sub">Promises made by you and to you, confirmed by you.</p>
      </div>
      {waiting > 0 && (
        <p className="syn-review-line">
          <Button size="sm" variant="link" onClick={onGoToReview}>
            {waiting} waiting for your review in Needs you
          </Button>
        </p>
      )}
      <div role="tablist" aria-label="Filter commitments" className="syn-ftabs">
        {FILTER_TABS.map((t) => (
          <button
            key={t.filter}
            type="button"
            role="tab"
            className="syn-ftab"
            aria-selected={t.filter === filter}
            onClick={() => onFilter(t.filter)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {items.length === 0 ? (
        <p className="syn-empty">No commitments.</p>
      ) : (
        <ul className="syn-ccard-list">
          {items.map((c) => (
            <li key={c.id}>
              <CommitmentCard
                c={c}
                onStatus={onStatus}
                onProposal={onProposal}
                onDraftFollowup={onDraftFollowup}
              />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
