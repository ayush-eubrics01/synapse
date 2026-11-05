"use client";

import { useState } from "react";
import type { FollowupViewDto, ResolveDecisionDto } from "../../lib/api";

const MAX_TEXT = 4000;
const STATUS_LINE: Record<string, string> = {
  pending: "Awaiting approval",
  sending: "Sending",
  sent: "Sent",
  sent_unverified: "Sent (unverified)",
  needs_attention: "Needs attention — check Slack",
  failed: "Not sent",
};
const RESOLVE_LABEL: Record<ResolveDecisionDto, string> = {
  mark_sent: "Mark sent",
  resend: "Resend",
  discard: "Discard send",
};

function Draft({
  f,
  onSend,
  onDiscard,
  onResolve,
}: {
  f: FollowupViewDto;
  onSend: (id: string, text: string) => void;
  onDiscard: (id: string) => void;
  onResolve: (outgoingId: string, decision: ResolveDecisionDto) => void;
}) {
  const [text, setText] = useState(f.draftText ?? "");
  const line = f.outgoing ? STATUS_LINE[f.outgoing.status] : undefined;
  return (
    <li style={{ marginBottom: 12 }}>
      <div>
        To {f.recipient ? (f.recipient.name ?? f.recipient.id) : "unknown"} in{" "}
        {f.conversationLabel ?? "an unknown conversation"} [{f.origin}] [{f.status}]
      </div>
      {f.noThread && <div>Posts as a new message (original expired)</div>}
      {line && <div>{line}</div>}
      {f.outgoing &&
        f.resolveActions.map((a) => (
          <span key={a}>
            <button type="button" onClick={() => f.outgoing && onResolve(f.outgoing.id, a)}>
              {RESOLVE_LABEL[a]}
            </button>{" "}
            {a === "resend" && <small>Requires your approval</small>}{" "}
          </span>
        ))}
      {f.actions.includes("send") ? (
        <div>
          <textarea
            aria-label="Follow-up draft"
            value={text}
            maxLength={MAX_TEXT}
            rows={3}
            style={{ width: "100%" }}
            onChange={(e) => setText(e.target.value)}
          />
          <button
            type="button"
            disabled={text.trimEnd().length === 0}
            onClick={() => onSend(f.id, text)}
          >
            Send for approval
          </button>{" "}
          <small>Requires your approval</small>{" "}
          {f.actions.includes("discard") && (
            <button type="button" onClick={() => onDiscard(f.id)}>
              Discard
            </button>
          )}
        </div>
      ) : (
        <>
          {f.draftText !== null && <div>{f.draftText}</div>}
          {f.actions.includes("discard") && (
            <button type="button" onClick={() => onDiscard(f.id)}>
              Discard
            </button>
          )}
        </>
      )}
    </li>
  );
}

export function FollowupDrafts({
  items,
  onSend,
  onDiscard,
  onResolve,
}: {
  items: FollowupViewDto[];
  onSend: (id: string, text: string) => void;
  onDiscard: (id: string) => void;
  onResolve: (outgoingId: string, decision: ResolveDecisionDto) => void;
}) {
  if (items.length === 0) return <p>No follow-up drafts.</p>;
  return (
    <ul style={{ listStyle: "none", padding: 0 }}>
      {items.map((f) => (
        <Draft key={f.id} f={f} onSend={onSend} onDiscard={onDiscard} onResolve={onResolve} />
      ))}
    </ul>
  );
}
