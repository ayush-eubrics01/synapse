"use client";

import type {
  EvidenceView,
  ObservationView,
  RecommendationView,
  RemovedObservationView,
} from "@synapse/contracts";
import { useState } from "react";
import { type Decision, decisionFor } from "../../lib/people-decision";

export const EXPIRED_EVIDENCE_TEXT = "original message no longer available locally";

/** Expandable evidence list. Everything is rendered as React text; links only when the server sent one. */
export function Evidence({ items }: { items: EvidenceView[] }) {
  if (items.length === 0) return null;
  return (
    <details>
      <summary>Evidence ({items.length})</summary>
      <ul>
        {items.map((e, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: one message can back an observation twice
          <li key={`${e.observationKey}:${e.sourceExternalRef}:${i}`}>
            {e.confidence}:{" "}
            {e.messageAvailable ? (
              e.permalink ? (
                <a href={e.permalink} target="_blank" rel="noreferrer noopener">
                  {e.sourceExternalRef}
                </a>
              ) : (
                e.sourceExternalRef
              )
            ) : (
              EXPIRED_EVIDENCE_TEXT
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

function Observation({ o, mark }: { o: ObservationView; mark?: string }) {
  return (
    <li>
      {mark} <small>{o.section}</small> {o.text} <small>({o.confidence})</small>
      <Evidence items={o.evidence} />
    </li>
  );
}

function Removed({ o }: { o: RemovedObservationView }) {
  return (
    <li style={{ textDecoration: "line-through" }}>
      - <small>{o.section}</small> {o.text ?? o.key}
      <Evidence items={o.evidence} />
    </li>
  );
}

function Item({
  r,
  onDecide,
  onRetry,
  onEvaluate,
  onDismiss,
  onDiscard,
}: {
  r: RecommendationView;
  onDecide: (d: Decision) => void;
  onRetry: (recommendationId: string) => void;
  onEvaluate: (recommendationId: string) => void;
  onDismiss: (recommendationId: string) => void;
  onDiscard: (recommendationId: string) => void;
}) {
  const [reason, setReason] = useState("");
  const decide = (d: "approve" | "reject", why?: string) => {
    const out = decisionFor(r, d, why);
    if (out) onDecide(out);
  };
  const can = (a: RecommendationView["actions"][number]) => r.actions.includes(a);
  return (
    <li style={{ marginBottom: 16 }}>
      <strong>{r.person.name ?? r.person.slackUserId}</strong>{" "}
      {r.kind === "initial" && "initial profile"}
      {r.kind === "update" && `update to version ${r.baseVersion}`}
      {r.kind === "suggest_evaluation" && "suggested evaluation"}
      {r.kind === "suggest_evaluation" && r.reason && <p>{r.reason}</p>}
      {r.proposed && (
        <ul>
          {r.proposed.map((o) => (
            <Observation key={`${o.section}.${o.key}`} o={o} />
          ))}
        </ul>
      )}
      {r.diff && (
        <ul>
          {r.diff.added.map((o) => (
            <Observation key={`+${o.section}.${o.key}`} o={o} mark="+" />
          ))}
          {r.diff.removed.map((o) => (
            <Removed key={`-${o.section}.${o.key}`} o={o} />
          ))}
        </ul>
      )}
      <div>
        {r.approvalId && can("approve") && (
          <button type="button" onClick={() => decide("approve")}>
            Approve
          </button>
        )}{" "}
        {r.approvalId && can("reject") && (
          <>
            <input
              type="text"
              maxLength={500}
              placeholder="Reason (optional)"
              aria-label="Reject reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />{" "}
            <button type="button" onClick={() => decide("reject", reason)}>
              Reject
            </button>
          </>
        )}
        {can("retry") && (
          <button type="button" onClick={() => onRetry(r.id)}>
            Apply failed — Retry
          </button>
        )}
        {can("evaluate") && (
          <button type="button" onClick={() => onEvaluate(r.id)}>
            Evaluate
          </button>
        )}{" "}
        {can("dismiss") && (
          <button type="button" onClick={() => onDismiss(r.id)}>
            Dismiss
          </button>
        )}{" "}
        {can("discard") && (
          <button type="button" onClick={() => onDiscard(r.id)}>
            Discard
          </button>
        )}
      </div>
    </li>
  );
}

export function ProfileRecommendations({
  items,
  onDecide,
  onRetry,
  onEvaluate,
  onDismiss,
  onDiscard,
}: {
  items: RecommendationView[];
  onDecide: (d: Decision) => void;
  onRetry: (recommendationId: string) => void;
  onEvaluate: (recommendationId: string) => void;
  onDismiss: (recommendationId: string) => void;
  onDiscard: (recommendationId: string) => void;
}) {
  if (items.length === 0) return <p>No profile recommendations to review.</p>;
  return (
    <ul style={{ paddingLeft: "1rem", listStyle: "none" }}>
      {items.map((r) => (
        <Item
          key={r.id}
          r={r}
          onDecide={onDecide}
          onRetry={onRetry}
          onEvaluate={onEvaluate}
          onDismiss={onDismiss}
          onDiscard={onDiscard}
        />
      ))}
    </ul>
  );
}
