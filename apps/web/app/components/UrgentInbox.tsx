"use client";

import { useState } from "react";
import type { ResolveDecisionDto, UrgencyStatusDto, UrgentItemDto } from "../../lib/api";

const MAX_REPLY = 4000;
const REPLY_STATUS: Record<string, string> = {
  pending: "Awaiting approval",
  sending: "Sending",
  sent: "Sent",
  sent_unverified: "Sent (unverified)",
  needs_attention: "Needs attention — check Slack",
};
const RESOLVE_LABEL: Record<ResolveDecisionDto, string> = {
  mark_sent: "Mark sent",
  resend: "Resend",
  discard: "Discard",
};

function ReplyBox({
  item,
  onReply,
  onResolve,
}: {
  item: UrgentItemDto;
  onReply: (messageId: string, text: string) => void;
  onResolve: (outgoingId: string, decision: ResolveDecisionDto) => void;
}) {
  const [text, setText] = useState(item.draft?.text ?? "");
  const reply = item.reply;
  const statusLine = reply?.outgoingStatus != null ? REPLY_STATUS[reply.outgoingStatus] : undefined;
  return (
    <div>
      {statusLine && <div>{statusLine}</div>}
      {reply?.outgoingId != null &&
        reply.actions.map((a) => (
          <button key={a} type="button" onClick={() => onResolve(reply.outgoingId ?? "", a)}>
            {RESOLVE_LABEL[a]}
          </button>
        ))}
      {(reply === null || reply.canRequest) && (
        <div>
          <textarea
            aria-label="Reply draft"
            value={text}
            maxLength={MAX_REPLY}
            rows={3}
            style={{ width: "100%" }}
            onChange={(e) => setText(e.target.value)}
          />
          <button
            type="button"
            disabled={text.trimEnd().length === 0}
            onClick={() => onReply(item.messageId, text)}
          >
            Send for approval
          </button>{" "}
          <small>Requires your approval</small>
        </div>
      )}
    </div>
  );
}

const SNIPPET = 200;
const LABEL: Record<UrgencyStatusDto, string> = {
  new: "New",
  acknowledged: "Acknowledge",
  in_progress: "In progress",
  resolved: "Resolve",
  dismissed: "Dismiss",
};

function snippet(text: string | null): string {
  if (text === null) return "content expired";
  return text.length > SNIPPET ? `${text.slice(0, SNIPPET)}...` : text;
}

export function UrgentInbox({
  items,
  onStatus,
  onCopy = (t) => navigator.clipboard.writeText(t),
  onReply = () => {},
  onResolve = () => {},
}: {
  items: UrgentItemDto[];
  onStatus: (messageId: string, status: UrgencyStatusDto) => void;
  onCopy?: (text: string) => void | Promise<void>;
  onReply?: (messageId: string, text: string) => void;
  onResolve?: (outgoingId: string, decision: ResolveDecisionDto) => void;
}) {
  if (items.length === 0) return <p>Nothing urgent.</p>;
  return (
    <ul style={{ listStyle: "none", padding: 0 }}>
      {items.map((i) => (
        <li key={i.messageId} style={{ marginBottom: 12 }}>
          <strong>[{i.level}]</strong> {i.sender.name ?? i.sender.id} in{" "}
          {i.conversation.name ?? i.conversation.id} at {new Date(i.sentAt).toLocaleString()}{" "}
          {!i.assessed && <em>(not yet assessed)</em>} {i.fallback && <em>(rule-based)</em>}{" "}
          {i.coalesced && <em>(follow-up in thread)</em>} <span>[{i.status}]</span>
          {i.permalink && (
            <>
              {" "}
              <a href={i.permalink} target="_blank" rel="noreferrer noopener">
                open
              </a>
            </>
          )}
          <div>{i.reason}</div>
          <div>{snippet(i.text)}</div>
          {(i.draft || i.reply) && (
            <div>
              {(i.reply === null || i.reply.canRequest) && (
                <>
                  <em>Draft — not sent</em>:{" "}
                </>
              )}
              {i.draft?.text === null ? (
                "content expired"
              ) : (
                <>
                  <button type="button" onClick={() => void onCopy(i.draft?.text ?? "")}>
                    Copy
                  </button>
                  <ReplyBox item={i} onReply={onReply} onResolve={onResolve} />
                </>
              )}
            </div>
          )}
          <div>
            {i.allowedTransitions.map((s) => (
              <button key={s} type="button" onClick={() => onStatus(i.messageId, s)}>
                {LABEL[s]}
              </button>
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
}
