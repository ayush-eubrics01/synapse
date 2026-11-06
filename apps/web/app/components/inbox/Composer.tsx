"use client";

import { useState } from "react";
import type { ComposerState } from "../../../lib/inbox";
import { Button } from "../ui/Button";

const MAX_TEXT = 4000;

export interface ComposerProps {
  state: ComposerState;
  /** Requests approval for the reply; nothing is sent until the user approves. */
  onReply: (urgentId: string, text: string) => void;
  /** Requests approval for a code answer's (edited) text; `useAnyway` is the user's injection acknowledgement. */
  onSendCodeAnswer?: (codeAnswerId: string, text: string, useAnyway: boolean) => void;
  /** The user acknowledged a suspected injection in the answer before filling the composer. */
  useAnyway?: boolean;
  /** Drops the code-answer draft and returns to the normal composer. */
  onDiscardCodeAnswer?: () => void;
}

export function Composer({
  state,
  onReply,
  onSendCodeAnswer,
  useAnyway = false,
  onDiscardCodeAnswer,
}: ComposerProps) {
  if (state.mode === "code_answer") {
    return (
      <CodeAnswerComposer
        key={state.codeAnswerId}
        codeAnswerId={state.codeAnswerId}
        draft={state.draft}
        useAnyway={useAnyway}
        onSend={onSendCodeAnswer}
        onDiscard={onDiscardCodeAnswer}
      />
    );
  }
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

function CodeAnswerComposer({
  codeAnswerId,
  draft,
  useAnyway,
  onSend,
  onDiscard,
}: {
  codeAnswerId: string;
  draft: string;
  useAnyway: boolean;
  onSend: ComposerProps["onSendCodeAnswer"];
  onDiscard: ComposerProps["onDiscardCodeAnswer"];
}) {
  const [text, setText] = useState(draft);
  return (
    <div className="syn-composer">
      <div className="syn-composer-head">
        <span className="syn-composer-label">Draft · answer from code</span>
        <span className="syn-composer-hint">
          Edit freely. It goes in the message's thread only after you approve it.
        </span>
      </div>
      <textarea
        className="syn-composer-text"
        aria-label="Reply draft"
        value={text}
        maxLength={MAX_TEXT}
        rows={4}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="syn-composer-actions">
        <Button variant="ghost" onClick={() => onDiscard?.()}>
          Discard draft
        </Button>
        <Button
          variant="primary"
          disabled={text.trim().length === 0 || !onSend}
          onClick={() => onSend?.(codeAnswerId, text, useAnyway)}
        >
          Request approval to send
        </Button>
      </div>
    </div>
  );
}
