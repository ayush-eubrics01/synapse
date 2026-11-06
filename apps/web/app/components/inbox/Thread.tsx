"use client";

import type { ConversationThread, ThreadMessage } from "@synapse/contracts";
import { useEffect, useRef } from "react";
import { conversationSub, conversationTitle, groupThread } from "../../../lib/inbox";
import { Avatar } from "../ui/Avatar";
import { Button } from "../ui/Button";
import { CodeAnswerPanel, type CodeAnswersContext } from "./CodeAnswerPanel";

export interface ThreadProps {
  thread: ConversationThread;
  now: Date | null;
  /** Commitment keys hidden by a pending undo (`commitment:<id>`). */
  hidden: Set<string>;
  onTrack: (commitmentId: string) => void;
  onIgnore: (commitmentId: string) => void;
  /** Proposes an engineering task from a message (Phase 10); the action is hidden without it. */
  onCreateTask?: (messageId: string) => void;
  /** Code answers (Phase 10b C5); the action is hidden without it. */
  codeAnswers?: CodeAnswersContext;
}

function clock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function ThreadHeader({ thread }: { thread: ConversationThread }) {
  const c = thread.conversation;
  const link = [...thread.messages].reverse().find((m) => m.permalink)?.permalink ?? null;
  return (
    <div className="syn-thread-head">
      <Avatar
        id={c.partner?.id ?? c.id}
        name={c.partner?.name ?? c.name}
        kind={c.type === "channel" ? "channel" : "person"}
        size={36}
      />
      <div className="syn-thread-head-text">
        <div className="syn-thread-name">{conversationTitle(c)}</div>
        <div className="syn-thread-sub">{conversationSub(c)}</div>
      </div>
      {link && (
        <a className="syn-ncard-link" href={link} target="_blank" rel="noreferrer noopener">
          Open in Slack ↗
        </a>
      )}
    </div>
  );
}

function Annotations({
  m,
  hidden,
  onTrack,
  onIgnore,
}: { m: ThreadMessage } & Pick<ThreadProps, "hidden" | "onTrack" | "onIgnore">) {
  const c = m.commitment;
  return (
    <>
      {m.flag && (
        <div className={`syn-msg-flag syn-msg-flag--${m.flag.severity}`}>
          <span className="syn-msg-flag-mark" aria-hidden="true">
            !
          </span>
          {`Flagged: ${m.flag.reason}. Treated as untrusted. Synapse never follows instructions found inside messages.`}
        </div>
      )}
      {c?.reviewStatus === "pending_review" && !hidden.has(`commitment:${c.id}`) && (
        <div className="syn-msg-commit">
          <span>Looks like a commitment. Track it?</span>
          <span className="syn-msg-commit-actions">
            <Button size="sm" variant="secondary" onClick={() => onTrack(c.id)}>
              Track
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onIgnore(c.id)}>
              Ignore
            </Button>
          </span>
        </div>
      )}
      {c?.reviewStatus === "accepted" && (
        <div className="syn-msg-tracking">{`Tracking: ${c.description}`}</div>
      )}
      {m.sentViaSynapse && (
        <div className="syn-msg-sent">
          {m.sentViaSynapse.auto
            ? "sent via Synapse · auto-reply while away"
            : `sent via Synapse · approved by you · ${
                m.sentViaSynapse.status === "sent"
                  ? "delivery verified"
                  : "delivery not yet verified"
              }`}
        </div>
      )}
    </>
  );
}

/** Messages render as plain text (React escaping): untrusted, never HTML, never auto-linked. */
export function Thread({
  thread,
  now,
  hidden,
  onTrack,
  onIgnore,
  onCreateTask,
  codeAnswers,
}: ThreadProps) {
  const ref = useRef<HTMLDivElement>(null);
  // The pane is mounted per conversation (keyed by the caller), so this runs when one opens.
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);
  const rows = groupThread(thread.messages, now ?? new Date(thread.conversation.lastMessageAt));
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard-focusable to scroll
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: labels the focusable scroll region
    <div className="syn-thread-scroll" ref={ref} tabIndex={0} aria-label="Messages">
      {rows.map(({ daySep, showHead, m }) => (
        <div key={m.id}>
          {daySep && (
            <div className="syn-day-sep">
              <span>{daySep}</span>
            </div>
          )}
          <div className={`syn-msg${showHead ? "" : " syn-msg--cont"}`}>
            {showHead && <Avatar id={m.sender.id} name={m.sender.name} size={32} />}
            <div className="syn-msg-body">
              {showHead && (
                <div className="syn-msg-head">
                  <span className="syn-msg-name">{m.sender.name ?? m.sender.id}</span>
                  <span className="syn-msg-time">{clock(m.sentAt)}</span>
                </div>
              )}
              <div className="syn-msg-text">
                {m.text === null ? <em>content expired</em> : m.text}
              </div>
              {onCreateTask && m.text !== null && m.text !== "" && (
                <div className="syn-msg-task">
                  <Button size="sm" variant="ghost" onClick={() => onCreateTask(m.id)}>
                    Create task
                  </Button>
                </div>
              )}
              {codeAnswers && !m.isSelf && m.text !== null && m.text !== "" && (
                <CodeAnswerPanel messageId={m.id} count={m.codeAnswerCount} {...codeAnswers} />
              )}
              <Annotations m={m} hidden={hidden} onTrack={onTrack} onIgnore={onIgnore} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
