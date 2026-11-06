"use client";

import type {
  CodeAnswerView,
  ConversationSummary,
  ConversationThread,
  RepositoryView,
} from "@synapse/contracts";
import type { UrgentItemDto } from "../../../lib/api";
import {
  composerState,
  filterConversations,
  INBOX_FILTERS,
  type InboxFilter,
  inboxSummary,
} from "../../../lib/inbox";
import type { NeedsYouHandlers } from "../../../lib/needs-you-actions";
import { Composer } from "./Composer";
import { ConversationList } from "./ConversationList";
import { Thread, ThreadHeader } from "./Thread";

export interface InboxProps {
  conversations: ConversationSummary[];
  filter: InboxFilter;
  onFilter: (f: InboxFilter) => void;
  /** The conversation shown in the thread pane (already resolved against the filter). */
  selectedId: string | null;
  onSelect: (id: string) => void;
  thread: ConversationThread | null;
  urgentById: ReadonlyMap<string, UrgentItemDto>;
  now: Date | null;
  hidden: Set<string>;
  /** Code answers (Phase 10b C5): hidden when absent. */
  codeAnswers?: {
    repositories: RepositoryView[];
    tick: { n: number; messageId: string | null };
    /** The answer the user chose to reply with; it replaces the composer until sent or discarded. */
    draft: { codeAnswerId: string; draft: string; useAnyway: boolean } | null;
    onUseAsReply: (v: CodeAnswerView, useAnyway: boolean) => void;
    onSend: (codeAnswerId: string, text: string, useAnyway: boolean) => void;
    onDiscard: () => void;
    /** An answer was dismissed: a draft made from it is dropped. */
    onDismissed: (codeAnswerId: string) => void;
  };
  handlers: Pick<NeedsYouHandlers, "trackCommitment" | "rejectCommitment" | "urgentReply"> &
    Partial<Pick<NeedsYouHandlers, "createTaskFromSlack">>;
}

export function Inbox(p: InboxProps) {
  const visible = filterConversations(p.conversations, p.filter);
  const loaded = p.thread && p.thread.conversation.id === p.selectedId ? p.thread : null;
  return (
    <>
      <div className="syn-inbox-head">
        <h2>Inbox</h2>
        <span className="syn-inbox-summary">{inboxSummary(p.conversations)}</span>
        {/* biome-ignore lint/a11y/useSemanticElements: toggle-button group styled as tabs; a fieldset would break the layout */}
        <div className="syn-inbox-tabs" role="group" aria-label="Filter conversations">
          {INBOX_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              className="syn-inbox-tab"
              aria-pressed={p.filter === f.value}
              onClick={() => p.onFilter(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>
      {p.conversations.length === 0 ? (
        <p>No messages collected yet.</p>
      ) : (
        <div className="syn-inbox-card">
          <ConversationList
            conversations={visible}
            selectedId={p.selectedId}
            onSelect={p.onSelect}
            now={p.now}
          />
          <div className="syn-thread">
            {loaded ? (
              <>
                <ThreadHeader thread={loaded} />
                <Thread
                  key={loaded.conversation.id}
                  thread={loaded}
                  now={p.now}
                  hidden={p.hidden}
                  onTrack={p.handlers.trackCommitment}
                  onIgnore={p.handlers.rejectCommitment}
                  onCreateTask={p.handlers.createTaskFromSlack}
                  codeAnswers={
                    p.codeAnswers && {
                      repositories: p.codeAnswers.repositories,
                      tick: p.codeAnswers.tick,
                      onUseAsReply: p.codeAnswers.onUseAsReply,
                      onDismissed: p.codeAnswers.onDismissed,
                    }
                  }
                />
                <Composer
                  state={
                    p.codeAnswers?.draft
                      ? {
                          mode: "code_answer",
                          codeAnswerId: p.codeAnswers.draft.codeAnswerId,
                          draft: p.codeAnswers.draft.draft,
                        }
                      : composerState(loaded.conversation, p.urgentById)
                  }
                  onReply={p.handlers.urgentReply}
                  onSendCodeAnswer={p.codeAnswers?.onSend}
                  useAnyway={p.codeAnswers?.draft?.useAnyway}
                  onDiscardCodeAnswer={p.codeAnswers?.onDiscard}
                />
              </>
            ) : (
              <p className="syn-inbox-empty">
                {p.selectedId ? "Loading…" : "Select a conversation."}
              </p>
            )}
          </div>
        </div>
      )}
    </>
  );
}
