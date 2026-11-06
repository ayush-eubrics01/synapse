"use client";

import type {
  EvidenceView,
  ObservationView,
  RecommendationView,
  RemovedObservationView,
} from "@synapse/contracts";
import { useState } from "react";
import { type Decision, decisionFor } from "../../../lib/people-decision";
import { Button } from "../ui/Button";
import { Actions, CardFrame, Explainer, metaLine } from "./CardFrame";

export const EXPIRED_EVIDENCE_TEXT = "original message no longer available locally";

/** Expandable evidence list. Everything is rendered as React text; links only when the server sent one. */
export function Evidence({ items }: { items: EvidenceView[] }) {
  if (items.length === 0) return null;
  return (
    <details className="syn-ncard-evidence">
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
      {mark} <span className="syn-ncard-section">{o.section}</span> {o.text}{" "}
      <span className="syn-ncard-faint">({o.confidence})</span>
      <Evidence items={o.evidence} />
    </li>
  );
}

function Removed({ o }: { o: RemovedObservationView }) {
  return (
    <li style={{ textDecoration: "line-through" }}>
      - <span className="syn-ncard-section">{o.section}</span> {o.text ?? o.key}
      <Evidence items={o.evidence} />
    </li>
  );
}

const KIND: Record<RecommendationView["kind"], string> = {
  initial: "DRAFT PROFILE",
  update: "PROFILE UPDATE",
  suggest_evaluation: "SUGGESTION",
};

function subtitle(r: RecommendationView): string {
  if (r.kind === "initial") return "initial profile";
  if (r.kind === "update") return `update to version ${r.baseVersion}`;
  return "suggested evaluation";
}

export function RecommendationCard({
  r,
  now,
  onDecide,
  onRetry,
  onEvaluate,
  onDismiss,
  onDiscard,
}: {
  r: RecommendationView;
  now: Date | null;
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
  const name = r.person.name ?? r.person.slackUserId;
  return (
    <CardFrame
      tag={`PEOPLE MEMORY · ${KIND[r.kind]}`}
      tone="blue"
      meta={metaLine(r.createdAt, now, "people memory")}
      title={`${name} · ${subtitle(r)}`}
    >
      {r.kind === "suggest_evaluation" && r.reason && <Explainer>{r.reason}</Explainer>}
      {r.proposed && (
        <ul className="syn-ncard-observations">
          {r.proposed.map((o) => (
            <Observation key={`${o.section}.${o.key}`} o={o} />
          ))}
        </ul>
      )}
      {r.diff && (
        <ul className="syn-ncard-observations">
          {r.diff.added.map((o) => (
            <Observation key={`+${o.section}.${o.key}`} o={o} mark="+" />
          ))}
          {r.diff.removed.map((o) => (
            <Removed key={`-${o.section}.${o.key}`} o={o} />
          ))}
        </ul>
      )}
      {r.actions.length > 0 && (
        <Actions>
          {r.approvalId && can("approve") && (
            <Button variant="primary" onClick={() => decide("approve")}>
              Approve
            </Button>
          )}
          {can("evaluate") && (
            <Button variant="primary" onClick={() => onEvaluate(r.id)}>
              Evaluate
            </Button>
          )}
          {can("retry") && (
            <Button variant="primary" onClick={() => onRetry(r.id)}>
              Apply failed — Retry
            </Button>
          )}
          {r.approvalId && can("reject") && (
            <>
              <input
                className="syn-ncard-input"
                type="text"
                maxLength={500}
                placeholder="Reason (optional)"
                aria-label="Reject reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <Button variant="secondary" onClick={() => decide("reject", reason)}>
                Reject
              </Button>
            </>
          )}
          {can("dismiss") && (
            <Button variant="ghost" onClick={() => onDismiss(r.id)}>
              Dismiss
            </Button>
          )}
          {can("discard") && (
            <Button variant="ghost" onClick={() => onDiscard(r.id)}>
              Discard
            </Button>
          )}
        </Actions>
      )}
    </CardFrame>
  );
}
