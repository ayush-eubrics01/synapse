"use client";

import { useState } from "react";
import type { ComposerState } from "../../../lib/inbox";
import { Button } from "../ui/Button";

const MAX_TEXT = 4000;

export interface ComposerProps {
  state: ComposerState;
  /** Requests approval for the reply; nothing is sent until the user approves. */
  onReply: (urgentId: string, text: string) => void;
}

export function Composer({ state, onReply }: ComposerProps) {
  if (state.mode === "note") {
    return (
      <div className="syn-composer syn-composer--note">
        <span className="syn-composer-check" aria-hidden="true">
          ✓
        </span>
        {state.text}
      </div>
    );
  }
  return (
    <ReplyComposer
      key={state.urgentId}
      urgentId={state.urgentId}
      draft={state.draft}
      onReply={onReply}
    />
  );
}

function ReplyComposer({
  urgentId,
  draft,
  onReply,
}: {
  urgentId: string;
  draft: string | null;
  onReply: ComposerProps["onReply"];
}) {
  const [text, setText] = useState(draft ?? "");
  return (
    <div className="syn-composer">
      <div className="syn-composer-head">
        <span className="syn-composer-label">Draft · reply to urgent message</span>
        <span className="syn-composer-hint">Edit freely. Sending needs your approval.</span>
      </div>
      <textarea
        className="syn-composer-text"
        aria-label="Reply draft"
        value={text}
        maxLength={MAX_TEXT}
        rows={3}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="syn-composer-actions">
        <Button variant="ghost" onClick={() => setText(draft ?? "")}>
          Reset to draft
        </Button>
        <Button
          variant="primary"
          disabled={text.trim().length === 0}
          onClick={() => onReply(urgentId, text)}
        >
          Request approval to send
        </Button>
      </div>
    </div>
  );
}
