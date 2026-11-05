"use client";

import type { SlackIdentityDto } from "../../lib/api";

/** Rendered only while the user has not confirmed who they are in Slack. */
export function IdentitySetup({
  identity,
  onConfirm,
}: {
  identity: SlackIdentityDto | null;
  onConfirm: (slackUserId: string) => void;
}) {
  if (!identity || identity.selfUserId !== null) return null;
  return (
    <section>
      <p>Confirm which Slack user you are, so your own messages are never flagged as urgent.</p>
      {identity.suggestion ? (
        <p>
          Suggested: {identity.suggestionName ?? identity.suggestion} ({identity.suggestion}){" "}
          <button type="button" onClick={() => onConfirm(identity.suggestion as string)}>
            Confirm
          </button>
        </p>
      ) : (
        <p>No suggestion yet. Pick yourself once more messages have been collected.</p>
      )}
    </section>
  );
}
