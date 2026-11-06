"use client";

import type { CodeAnswerView, RepositoryView } from "@synapse/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { dismissCodeAnswer, getCodeAnswers, requestCodeAnswer } from "../../../lib/api";
import {
  canUseAsReply,
  codeAnswerErrorText,
  codeAnswerStatusText,
  formatEvidence,
  preselectRepository,
} from "../../../lib/code-answers";
import { Button } from "../ui/Button";
import { useToast } from "../ui/Toasts";

/** What the thread needs to offer code answers; absent, the action is hidden. */
export interface CodeAnswersContext {
  repositories: RepositoryView[];
  /** Bumped on every `code_answer.status_changed` event; `messageId` is null when the event names none. */
  tick: { n: number; messageId: string | null };
  /** Fills the composer with the answer; `useAnyway` is the user's acknowledgement of an injection flag. */
  onUseAsReply: (v: CodeAnswerView, useAnyway: boolean) => void;
  /** Called after an answer is dismissed, so a draft made from it can be dropped. */
  onDismissed?: (codeAnswerId: string) => void;
}

export interface CodeAnswerPanelViewProps {
  views: CodeAnswerView[];
  repositories: RepositoryView[];
  repositoryId: string;
  onRepository: (id: string) => void;
  onAsk: () => void;
  busy: boolean;
  acknowledged: ReadonlySet<string>;
  onAcknowledge: (id: string) => void;
  onUseAsReply: (v: CodeAnswerView, useAnyway: boolean) => void;
  onDismiss: (id: string) => void;
}

function Answer({
  v,
  acknowledged,
  onAcknowledge,
  onUseAsReply,
  onDismiss,
}: { v: CodeAnswerView } & Pick<
  CodeAnswerPanelViewProps,
  "acknowledged" | "onAcknowledge" | "onUseAsReply" | "onDismiss"
>) {
  const useAnyway = acknowledged.has(v.id);
  const injected = v.suspectedInjection?.detected === true;
  const showsAnswer = (v.status === "ready" || v.status === "held") && v.answer !== null;
  const dismissable = ["ready", "held", "not_answerable", "unverified", "failed"].includes(
    v.status,
  );
  return (
    <div className="syn-codeanswer">
      <div className="syn-codeanswer-status">
        {v.repositoryName ? `${v.repositoryName} · ` : ""}
        {codeAnswerStatusText(v)}
      </div>
      {injected && v.suspectedInjection && (
        <div
          className={`syn-msg-flag syn-msg-flag--${v.suspectedInjection.severity === "high" ? "high" : "warning"}`}
        >
          <span className="syn-msg-flag-mark" aria-hidden="true">
            !
          </span>
          {`Suspected injection: ${v.suspectedInjection.reason}. Treated as untrusted. Check the answer before you use it.`}
        </div>
      )}
      {/* Answer text and evidence paths come from a model run: React text only, never HTML or links. */}
      {showsAnswer && <div className="syn-codeanswer-text">{v.answer}</div>}
      {showsAnswer && v.confidence !== null && (
        <div className="syn-codeanswer-meta">{`confidence ${v.confidence.toFixed(2)}`}</div>
      )}
      {showsAnswer && v.evidence.length > 0 && (
        <ul className="syn-codeanswer-evidence" aria-label="Evidence">
          {v.evidence.map((e, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the same path:line can repeat
            <li key={`${i}:${formatEvidence(e)}`}>{formatEvidence(e)}</li>
          ))}
        </ul>
      )}
      {(showsAnswer || dismissable) && (
        <div className="syn-codeanswer-actions">
          {showsAnswer && injected && !useAnyway && (
            <Button size="sm" variant="secondary" onClick={() => onAcknowledge(v.id)}>
              Use anyway
            </Button>
          )}
          {showsAnswer && (
            <Button
              size="sm"
              variant="primary"
              disabled={!canUseAsReply(v, useAnyway)}
              onClick={() => onUseAsReply(v, useAnyway)}
            >
              Use as reply
            </Button>
          )}
          {dismissable && (
            <Button size="sm" variant="ghost" onClick={() => onDismiss(v.id)}>
              Dismiss
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export function CodeAnswerPanelView(p: CodeAnswerPanelViewProps) {
  const live = p.views.filter((v) => v.status !== "dismissed");
  return (
    <div className="syn-codeanswers">
      <div className="syn-codeanswer-ask">
        <select
          className="syn-codeanswer-select"
          aria-label="Repository to answer from"
          value={p.repositoryId}
          onChange={(e) => p.onRepository(e.target.value)}
        >
          <option value="">Choose repository</option>
          {p.repositories.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          variant="ghost"
          disabled={p.repositoryId === "" || p.busy}
          onClick={p.onAsk}
        >
          Answer from code…
        </Button>
      </div>
      {live.map((v) => (
        <Answer
          key={v.id}
          v={v}
          acknowledged={p.acknowledged}
          onAcknowledge={p.onAcknowledge}
          onUseAsReply={p.onUseAsReply}
          onDismiss={p.onDismiss}
        />
      ))}
    </div>
  );
}

export interface CodeAnswerPanelProps extends CodeAnswersContext {
  messageId: string;
  /** Non-dismissed answers the thread already knows of; answers are loaded lazily when above zero. */
  count: number;
  /** Test seams: the first render's rows and acknowledged ids. */
  initialViews?: CodeAnswerView[];
  initialAcknowledged?: string[];
}

/** Hidden without a registered repository: there is nothing to answer from. */
export function CodeAnswerPanel(p: CodeAnswerPanelProps) {
  const toast = useToast();
  const [views, setViews] = useState<CodeAnswerView[]>(p.initialViews ?? []);
  const [repositoryId, setRepositoryId] = useState(preselectRepository(p.repositories) ?? "");
  const [asked, setAsked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [acknowledged, setAcknowledged] = useState<ReadonlySet<string>>(
    new Set(p.initialAcknowledged ?? []),
  );
  const wanted = p.count > 0 || asked;
  const { messageId } = p;
  // Only an event for this message (or one naming none) re-runs the fetch.
  const seen = useRef(0);
  if (p.tick.messageId === null || p.tick.messageId === messageId) seen.current = p.tick.n;
  const relevantTick = seen.current;

  const load = useCallback(async () => {
    try {
      setViews(await getCodeAnswers(messageId));
    } catch {
      // The panel keeps what it has; the next event or action reloads.
    }
  }, [messageId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `relevantTick` re-runs the fetch on each status event for this message
  useEffect(() => {
    if (wanted) void load();
  }, [wanted, load, relevantTick]);

  if (p.repositories.length === 0) return null;
  return (
    <CodeAnswerPanelView
      views={views}
      repositories={p.repositories}
      repositoryId={repositoryId}
      onRepository={setRepositoryId}
      busy={busy}
      acknowledged={acknowledged}
      onAcknowledge={(id) => setAcknowledged((s) => new Set(s).add(id))}
      onUseAsReply={p.onUseAsReply}
      onAsk={() => {
        setBusy(true);
        requestCodeAnswer(messageId, repositoryId)
          .then(() => {
            toast.show("Answer requested · runs in the background");
            setAsked(true);
            return load();
          })
          .catch((e: unknown) => toast.show(codeAnswerErrorText(e)))
          .finally(() => setBusy(false));
      }}
      onDismiss={(id) => {
        dismissCodeAnswer(id)
          .then(() => {
            p.onDismissed?.(id);
            return load();
          })
          .catch(() => toast.show("Could not dismiss that answer"));
      }}
    />
  );
}
