"use client";

import { useState } from "react";
import type { CommitmentEditsDto, CommitmentViewDto } from "../../../lib/api";
import { Button } from "../ui/Button";
import { Actions, CardFrame, Explainer, metaLine } from "./CardFrame";

export const EXPIRED_SOURCE = "original message no longer available locally";

function who(name: string | null, id: string | null): string {
  return name ?? id ?? "unknown";
}

/** A commitment Claude found: the user tracks it (optionally edited) or says it isn't one. */
export function CommitmentReviewCard({
  c,
  now,
  onTrack,
  onReject,
  initiallyEditing = false,
}: {
  c: CommitmentViewDto;
  now: Date | null;
  onTrack: (id: string, edits?: CommitmentEditsDto) => void;
  onReject: (id: string) => void;
  /** Tests only: render with the edit fields open. */
  initiallyEditing?: boolean;
}) {
  const [editing, setEditing] = useState(initiallyEditing);
  const [description, setDescription] = useState(c.description);
  const [due, setDue] = useState("");
  const track = () => {
    const edits: CommitmentEditsDto = {};
    if (editing && description.trim() !== c.description) edits.description = description.trim();
    if (editing && due !== "") edits.dueAt = new Date(due).toISOString();
    onTrack(c.id, Object.keys(edits).length > 0 ? edits : undefined);
  };
  return (
    <CardFrame
      tag="POSSIBLE COMMITMENT"
      tone="amber"
      meta={metaLine(c.createdAt, now, c.direction === "mine" ? "you owe" : "owed to you")}
      title={c.description}
    >
      <Explainer>
        {who(c.ownerName, c.ownerSlackUserId)} →{" "}
        {who(c.counterpartyName, c.counterpartySlackUserId)}
        {c.dueAt && ` · due ${new Date(c.dueAt).toLocaleString()}`}
      </Explainer>
      {c.sources.length > 0 && (
        <ul className="syn-ncard-sources">
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
                <em>{EXPIRED_SOURCE}</em>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <div className="syn-ncard-edit">
          <textarea
            className="syn-ncard-textarea"
            aria-label="Commitment description"
            value={description}
            maxLength={500}
            rows={2}
            onChange={(e) => setDescription(e.target.value)}
          />
          <input
            className="syn-ncard-input"
            aria-label="Due date"
            type="datetime-local"
            value={due}
            onChange={(e) => setDue(e.target.value)}
          />
        </div>
      )}
      <Actions>
        {c.actions.includes("accept") && (
          <Button variant="primary" onClick={track}>
            {editing ? "Track it with edits" : "Track it"}
          </Button>
        )}
        {c.actions.includes("edit") && !editing && (
          <Button variant="secondary" onClick={() => setEditing(true)}>
            Edit
          </Button>
        )}
        {c.actions.includes("reject") && (
          <Button variant="ghost" onClick={() => onReject(c.id)}>
            Not a commitment
          </Button>
        )}
      </Actions>
    </CardFrame>
  );
}
