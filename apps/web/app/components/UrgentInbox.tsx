"use client";

import type { UrgencyStatusDto, UrgentItemDto } from "../../lib/api";

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
}: {
  items: UrgentItemDto[];
  onStatus: (messageId: string, status: UrgencyStatusDto) => void;
  onCopy?: (text: string) => void | Promise<void>;
}) {
  if (items.length === 0) return <p>Nothing urgent.</p>;
  return (
    <ul style={{ listStyle: "none", padding: 0 }}>
      {items.map((i) => (
        <li key={i.messageId} style={{ marginBottom: 12 }}>
          <strong>[{i.level}]</strong> {i.sender.name ?? i.sender.id} in{" "}
          {i.conversation.name ?? i.conversation.id} at {new Date(i.sentAt).toLocaleString()}{" "}
          {!i.assessed && <em>(not yet assessed)</em>} {i.fallback && <em>(rule-based)</em>}{" "}
          <span>[{i.status}]</span>
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
          {i.draft && (
            <div>
              <em>Draft — not sent</em>:{" "}
              {i.draft.text === null ? (
                "content expired"
              ) : (
                <>
                  {i.draft.text}{" "}
                  <button type="button" onClick={() => void onCopy(i.draft?.text ?? "")}>
                    Copy
                  </button>
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
