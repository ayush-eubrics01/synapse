"use client";

import type { InboxMessageDto } from "../../lib/api";

const cell = { textAlign: "left", padding: "2px 12px 2px 0", verticalAlign: "top" } as const;
const SNIPPET = 120;

function snippet(text: string | null): string {
  if (text === null) return "content expired";
  return text.length > SNIPPET ? `${text.slice(0, SNIPPET)}...` : text;
}

export function InboxPanel({ messages }: { messages: InboxMessageDto[] }) {
  if (messages.length === 0) return <p>No Slack messages yet.</p>;
  return (
    <table style={{ borderCollapse: "collapse" }}>
      <thead>
        <tr>
          <th style={cell}>Conversation</th>
          <th style={cell}>Sender</th>
          <th style={cell}>Time</th>
          <th style={cell}>Message</th>
          <th style={cell} />
        </tr>
      </thead>
      <tbody>
        {messages.slice(0, 50).map((m) => (
          <tr key={m.id}>
            <td style={cell}>{m.conversation.name ?? m.conversation.id}</td>
            <td style={cell}>{m.sender.name ?? m.sender.id}</td>
            <td style={cell}>{new Date(m.sentAt).toLocaleString()}</td>
            <td style={cell}>{snippet(m.text)}</td>
            <td style={cell}>
              {m.permalink && (
                <a href={m.permalink} target="_blank" rel="noreferrer noopener">
                  open
                </a>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
