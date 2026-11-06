"use client";

import type { CommitmentFilter } from "@synapse/contracts";
import { useState } from "react";
import type { CommitmentEditsDto, CommitmentStatusDto, CommitmentViewDto } from "../../lib/api";

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

function Sources({ c }: { c: CommitmentViewDto }) {
  if (c.sources.length === 0) return null;
  return (
    <ul>
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

function who(name: string | null, id: string | null): string {
  return name ?? id ?? "unknown";
}

function Header({ c }: { c: CommitmentViewDto }) {
  return (
    <div>
      <strong>{c.description}</strong> [{c.status}]
      <div>
        {who(c.ownerName, c.ownerSlackUserId)} {"→"}{" "}
        {who(c.counterpartyName, c.counterpartySlackUserId)}
        {c.dueAt && <> due {new Date(c.dueAt).toLocaleString()}</>}
        {c.stalledAt && <em> (stalled)</em>}
      </div>
    </div>
  );
}

function ReviewItem({
  c,
  onReview,
}: {
  c: CommitmentViewDto;
  onReview: (id: string, decision: "accept" | "reject", edits?: CommitmentEditsDto) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [description, setDescription] = useState(c.description);
  const [due, setDue] = useState("");
  const accept = () => {
    const edits: CommitmentEditsDto = {};
    if (editing && description.trim() !== c.description) edits.description = description.trim();
    if (editing && due !== "") edits.dueAt = new Date(due).toISOString();
    onReview(c.id, "accept", Object.keys(edits).length > 0 ? edits : undefined);
  };
  return (
    <li style={{ marginBottom: 12 }}>
      <Header c={c} />
      <Sources c={c} />
      {editing && (
        <div>
          <textarea
            aria-label="Commitment description"
            value={description}
            maxLength={500}
            rows={2}
            style={{ width: "100%" }}
            onChange={(e) => setDescription(e.target.value)}
          />
          <input
            aria-label="Due date"
            type="datetime-local"
            value={due}
            onChange={(e) => setDue(e.target.value)}
          />
        </div>
      )}
      {c.actions.includes("accept") && (
        <button type="button" onClick={accept}>
          {editing ? "Accept with edits" : "Accept"}
        </button>
      )}{" "}
      {c.actions.includes("edit") && !editing && (
        <button type="button" onClick={() => setEditing(true)}>
          Edit
        </button>
      )}{" "}
      {c.actions.includes("reject") && (
        <button type="button" onClick={() => onReview(c.id, "reject")}>
          Reject
        </button>
      )}
    </li>
  );
}

export function CommitmentsPanel({
  queue,
  items,
  filter,
  onFilter,
  onReview,
  onStatus,
  onProposal,
  onDraftFollowup,
}: {
  /** Commitments pending review (the `review` filter). */
  queue: CommitmentViewDto[];
  items: CommitmentViewDto[];
  filter: CommitmentFilter;
  onFilter: (f: CommitmentFilter) => void;
  onReview: (id: string, decision: "accept" | "reject", edits?: CommitmentEditsDto) => void;
  onStatus: (id: string, status: CommitmentStatusDto) => void;
  onProposal: (updateId: string, accept: boolean) => void;
  onDraftFollowup: (id: string) => void;
}) {
  const pending = queue.filter((c) => c.actions.includes("accept"));
  return (
    <div>
      {pending.length > 0 && (
        <div>
          <h3>Review queue</h3>
          <ul style={{ listStyle: "none", padding: 0 }}>
            {pending.map((c) => (
              <ReviewItem key={c.id} c={c} onReview={onReview} />
            ))}
          </ul>
        </div>
      )}
      <div role="tablist">
        {FILTER_TABS.map((t) => (
          <button
            key={t.filter}
            type="button"
            role="tab"
            aria-selected={t.filter === filter}
            disabled={t.filter === filter}
            onClick={() => onFilter(t.filter)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {items.length === 0 ? (
        <p>No commitments.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {items.map((c) => (
            <li key={c.id} style={{ marginBottom: 12 }}>
              <Header c={c} />
              <Sources c={c} />
              {c.proposals.length > 0 && c.actions.includes("confirm_proposal") && (
                <div>
                  {c.proposals.map((p) => (
                    <div key={p.updateId}>
                      <em>Completion proposed by Claude</em>{" "}
                      <button type="button" onClick={() => onProposal(p.updateId, true)}>
                        Confirm completed
                      </button>{" "}
                      <button type="button" onClick={() => onProposal(p.updateId, false)}>
                        Reject proposal
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div>
                {c.actions.map((a) => {
                  const s = STATUS_ACTIONS[a];
                  return s ? (
                    <button key={a} type="button" onClick={() => onStatus(c.id, s.status)}>
                      {s.label}
                    </button>
                  ) : null;
                })}
                {c.actions.includes("draft_followup") && (
                  <button type="button" onClick={() => onDraftFollowup(c.id)}>
                    Draft follow-up
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
