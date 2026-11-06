import type { ConversationSummary } from "@synapse/contracts";
import { relMinutes } from "../../../lib/format";
import { conversationChip, conversationTitle } from "../../../lib/inbox";
import { Avatar } from "../ui/Avatar";
import { Chip } from "../ui/Chip";

export interface ConversationListProps {
  conversations: ConversationSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  now: Date | null;
}

export function ConversationList({
  conversations,
  selectedId,
  onSelect,
  now,
}: ConversationListProps) {
  if (conversations.length === 0) return <p className="syn-inbox-empty">Nothing in this view.</p>;
  return (
    <ul className="syn-inbox-list">
      {conversations.map((c) => {
        const chip = conversationChip(c);
        const title = conversationTitle(c);
        const selected = c.id === selectedId;
        const preview = c.preview === null ? "content expired" : c.preview;
        return (
          <li key={c.id}>
            <button
              type="button"
              className="syn-inbox-row"
              aria-current={selected ? "true" : undefined}
              onClick={() => onSelect(c.id)}
            >
              <Avatar
                id={c.partner?.id ?? c.id}
                name={c.partner?.name ?? c.name}
                kind={c.type === "channel" ? "channel" : "person"}
                size={36}
              />
              <span className="syn-inbox-row-body">
                <span className="syn-inbox-row-top">
                  <span className="syn-inbox-row-title">{title}</span>
                  <span className="syn-inbox-row-time">
                    {now ? relMinutes(c.lastMessageAt, now) : ""}
                  </span>
                </span>
                <span className="syn-inbox-row-preview">
                  {`${c.lastSender.isSelf ? "You: " : ""}${preview}`}
                </span>
                <span className="syn-inbox-row-meta">
                  <Chip tone={chip.tone}>{chip.label}</Chip>
                  <span className="syn-inbox-row-count">{`${c.messageCount} msgs`}</span>
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
