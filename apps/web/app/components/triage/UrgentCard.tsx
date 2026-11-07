"use client";

import type { UrgencyStatusDto, UrgentItemDto } from "../../../lib/api";
import { conversationLabel } from "../../../lib/format";
import { Button } from "../ui/Button";
import { useDraft } from "../ui/useDraft";
import {
  Actions,
  absoluteTime,
  CardFrame,
  Explainer,
  MAX_TEXT,
  metaLine,
  Quote,
  SEND_STATUS,
  SlackLink,
  statusLabel,
} from "./CardFrame";

const SNIPPET = 200;
const LABEL: Record<UrgencyStatusDto, string> = {
  new: "New",
  acknowledged: "Acknowledge",
  in_progress: "In progress",
  resolved: "Resolve",
  dismissed: "Dismiss",
};

function snippet(t: string | null): string {
  if (t === null) return "content expired";
  return t.length > SNIPPET ? `${t.slice(0, SNIPPET)}...` : t;
}

export interface UrgentCardProps {
  item: UrgentItemDto;
  now: Date | null;
  onStatus: (messageId: string, status: UrgencyStatusDto) => void;
  /** Requests approval for the reply; nothing is sent until the user approves. */
  onReply: (messageId: string, text: string) => void;
  onCopy: (text: string) => void | Promise<void>;
}

export function UrgentCard({ item: i, now, onStatus, onReply, onCopy }: UrgentCardProps) {
  const [text, setText] = useDraft(`reply:${i.messageId}`, i.draft?.text ?? "");
  const reply = i.reply;
  const canRequest = reply === null || reply.canRequest;
  const statusLine = reply?.outgoingStatus != null ? SEND_STATUS[reply.outgoingStatus] : undefined;
  const live = i.draft !== null && i.draft.text !== null;
  // A reply can be written when no send is live, unless the draft text has expired.
  const editable = canRequest && (i.draft !== null || reply !== null) && i.draft?.text !== null;
  const tags = [
    statusLabel(i.status),
    ...(i.assessed ? [] : ["not yet assessed"]),
    ...(i.fallback ? ["rule-based"] : []),
    ...(i.coalesced ? ["follow-up in thread"] : []),
  ];
  const sender = i.sender.name ?? i.sender.id;
  const where = conversationLabel(i.conversation);
  return (
    <CardFrame
      tag={`URGENT · ${i.level.toUpperCase()}`}
      tone="red"
      tags={tags}
      meta={metaLine(i.sentAt, now, where)}
      metaTitle={absoluteTime(i.sentAt)}
      title={`${sender}: ${i.reason}`}
    >
      <Quote>{snippet(i.text)}</Quote>
      {statusLine && <Explainer>{statusLine}</Explainer>}
      {(i.draft || reply) && (
        <div className="syn-ncard-draft">
          {canRequest && <span className="syn-ncard-draft-label">Draft — not sent</span>}
          {i.draft?.text === null && <Explainer>content expired</Explainer>}
          {editable && (
            <>
              <textarea
                className="syn-ncard-textarea"
                aria-label="Reply draft"
                value={text}
                maxLength={MAX_TEXT}
                rows={3}
                onChange={(e) => setText(e.target.value)}
              />
              <Explainer>Requires your approval. Nothing is sent until you approve.</Explainer>
            </>
          )}
        </div>
      )}
      <Actions end={i.permalink ? <SlackLink href={i.permalink} /> : undefined}>
        {editable && (
          <Button
            variant="primary"
            disabled={text.trimEnd().length === 0}
            onClick={() => onReply(i.messageId, text)}
          >
            Send for approval
          </Button>
        )}
        {live && (
          <Button variant="secondary" onClick={() => void onCopy(i.draft?.text ?? "")}>
            Copy
          </Button>
        )}
        {i.allowedTransitions.map((s) => (
          <Button key={s} variant="ghost" onClick={() => onStatus(i.messageId, s)}>
            {LABEL[s]}
          </Button>
        ))}
      </Actions>
    </CardFrame>
  );
}
