"use client";

import { useState } from "react";
import type { PersonDto, SlackIdentityDto } from "../../lib/api";

/** Rendered only while the user has not confirmed who they are in Slack. */
export function IdentitySetup({
  identity,
  people,
  onConfirm,
}: {
  identity: SlackIdentityDto | null;
  /** Known Slack users, for a manual pick when there is no suggestion. */
  people: PersonDto[];
  onConfirm: (slackUserId: string) => void;
}) {
  const [picked, setPicked] = useState("");
  if (!identity || identity.selfUserId !== null) return null;
  return (
    <section>
      <p>
        Confirm which Slack user you are, so your own messages are never flagged as urgent. Until
        then, urgent notifications and suggested replies are paused.
      </p>
      {identity.suggestion ? (
        <p>
          Suggested: {identity.suggestionName ?? identity.suggestion} ({identity.suggestion}){" "}
          <button type="button" onClick={() => onConfirm(identity.suggestion as string)}>
            Confirm
          </button>
        </p>
      ) : people.length > 0 ? (
        <p>
          <select
            aria-label="Your Slack user"
            value={picked}
            onChange={(e) => setPicked(e.target.value)}
          >
            <option value="">Pick yourself…</option>
            {people.map((p) => (
              <option key={p.slackUserId} value={p.slackUserId}>
                {p.name ? `${p.name} (${p.slackUserId})` : p.slackUserId}
              </option>
            ))}
          </select>{" "}
          <button type="button" disabled={picked === ""} onClick={() => onConfirm(picked)}>
            Confirm
          </button>
        </p>
      ) : (
        <p>No suggestion yet. Pick yourself once more messages have been collected.</p>
      )}
    </section>
  );
}
