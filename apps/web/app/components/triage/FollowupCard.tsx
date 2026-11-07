"use client";

import type { FollowupViewDto } from "../../../lib/api";
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
  statusLabel,
} from "./CardFrame";

const ORIGIN: Record<FollowupViewDto["origin"], string> = {
  stalled: "stalled commitment",
  spec_clarity: "spec clarity",
  urgent_reply: "urgent reply",
  manual: "manual",
};

export function FollowupCard({
  f,
  now,
  onSend,
  onDiscard,
}: {
  f: FollowupViewDto;
  now: Date | null;
  /** Requests approval to send the (edited) draft. */
  onSend: (id: string, text: string) => void;
  onDiscard: (id: string) => void;
}) {
  const [text, setText] = useDraft(`followup:${f.id}`, f.draftText ?? "");
  const line = f.outgoing ? SEND_STATUS[f.outgoing.status] : undefined;
  const canSend = f.actions.includes("send");
  const canDiscard = f.actions.includes("discard");
  const who = f.recipient ? (f.recipient.name ?? f.recipient.id) : "unknown";
  return (
    <CardFrame
      tag="FOLLOW-UP DRAFT"
      tone="blue"
      tags={[statusLabel(f.status)]}
      meta={metaLine(f.createdAt, now, ORIGIN[f.origin])}
      metaTitle={absoluteTime(f.createdAt)}
      title={`To ${who} in ${f.conversationLabel ?? "an unknown conversation"}`}
    >
      {f.noThread && <Explainer>Posts as a new message (original expired)</Explainer>}
      {line && <Explainer>{line}</Explainer>}
      {canSend ? (
        <>
          <span className="syn-ncard-draft-label">Draft — not sent</span>
          <textarea
            className="syn-ncard-textarea"
            aria-label="Follow-up draft"
            value={text}
            maxLength={MAX_TEXT}
            rows={3}
            onChange={(e) => setText(e.target.value)}
          />
          <Explainer>Requires your approval. Nothing is sent until you approve.</Explainer>
        </>
      ) : f.draftText !== null ? (
        <Quote>{f.draftText}</Quote>
      ) : (
        <Explainer>content expired</Explainer>
      )}
      {(canSend || canDiscard) && (
        <Actions>
          {canSend && (
            <Button
              variant="primary"
              disabled={text.trimEnd().length === 0}
              onClick={() => onSend(f.id, text)}
            >
              Send for approval
            </Button>
          )}
          {canDiscard && (
            <Button variant="ghost" onClick={() => onDiscard(f.id)}>
              Discard
            </Button>
          )}
        </Actions>
      )}
    </CardFrame>
  );
}
