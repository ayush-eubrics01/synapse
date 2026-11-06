"use client";

import type { CandidatesResponse } from "@synapse/contracts";
import { useEffect, useState } from "react";
import type { PersonDto, SlackIdentityDto, SlackStatusDto } from "../../../lib/api";
import { backfillAction } from "../../../lib/backfill-action";
import { Avatar } from "../ui/Avatar";
import { Button } from "../ui/Button";
import { Actions, CardFrame, Explainer } from "./CardFrame";

/** Shown while the user has not confirmed who they are in Slack. */
export function IdentitySetupCard({
  identity,
  people,
  onConfirm,
}: {
  identity: SlackIdentityDto;
  /** Known Slack users, for a manual pick when there is no suggestion. */
  people: PersonDto[];
  onConfirm: (slackUserId: string) => void;
}) {
  const [picked, setPicked] = useState("");
  const suggestion = identity.suggestion;
  return (
    <CardFrame tag="IDENTITY · SETUP" tone="neutral" title="Confirm who you are in Slack">
      <Explainer>
        Confirm which Slack user you are, so your own messages are never flagged as urgent. Until
        then, urgent notifications and suggested replies are paused.
      </Explainer>
      {suggestion ? (
        <Actions>
          <span className="syn-ncard-inline">
            Suggested: {identity.suggestionName ?? suggestion} ({suggestion})
          </span>
          <Button variant="primary" onClick={() => onConfirm(suggestion)}>
            Confirm
          </Button>
        </Actions>
      ) : people.length > 0 ? (
        <Actions>
          <select
            className="syn-ncard-input"
            aria-label="Your Slack user"
            value={picked}
            onChange={(e) => setPicked(e.target.value)}
          >
            <option value="">Pick yourself…</option>
            {people.map((p) => (
              <option key={p.slackUserId} value={p.slackUserId}>
                {p.name ? `${p.name} (${p.slackUserId})` : p.slackUserId}
              </option>
            ))}
          </select>
          <Button variant="primary" disabled={picked === ""} onClick={() => onConfirm(picked)}>
            Confirm
          </Button>
        </Actions>
      ) : (
        <Explainer>
          No suggestion yet. Pick yourself once more messages have been collected.
        </Explainer>
      )}
    </CardFrame>
  );
}

const TOP = 3;

/** People the user talks to most who have no profile yet; evaluating queues a draft profile. */
export function PeopleSetupCard({
  candidates,
  onEvaluate,
  onSeeAll,
}: {
  candidates: CandidatesResponse["candidates"];
  onEvaluate: (slackUserId: string) => void;
  onSeeAll: () => void;
}) {
  const n = candidates.length;
  return (
    <CardFrame
      tag="PEOPLE MEMORY · SETUP"
      tone="neutral"
      title={`${n} ${n === 1 ? "person is" : "people are"} ready to evaluate`}
    >
      <Explainer>
        Synapse drafts a profile only for people you choose, and every profile waits for your
        approval.
      </Explainer>
      <ul className="syn-ncard-people">
        {candidates.slice(0, TOP).map((c) => (
          <li key={c.slackUserId} className="syn-ncard-person">
            <Avatar id={c.slackUserId} name={c.name} size={24} />
            <span className="syn-ncard-person-name">{c.name ?? c.slackUserId}</span>
            <span className="syn-ncard-faint">{c.messageCount} msgs</span>
            <Button variant="secondary" size="sm" onClick={() => onEvaluate(c.slackUserId)}>
              Evaluate
            </Button>
          </li>
        ))}
      </ul>
      <Actions
        end={
          <Button variant="link" onClick={onSeeAll}>
            See all in People →
          </Button>
        }
      />
    </CardFrame>
  );
}

type Backfill = SlackStatusDto["backfill"];

function pages(n: number): string {
  return `${n} ${n === 1 ? "page" : "pages"} done`;
}

/** Only backend facts (spec D12): state, pages done and whether it can resume. */
function stateLine(b: Backfill): string {
  if (b.status === "idle") {
    return "Not started. Synapse reads the last 90 days of Slack page by page in the background.";
  }
  if (b.status === "error") {
    const kind = b.lastError ? ` (${b.lastError.kind})` : "";
    return `Stopped with an error${kind} · ${pages(b.pagesDone)}. It resumes from its checkpoint.`;
  }
  if (b.resumable) return `Interrupted · ${pages(b.pagesDone)}. It resumes from its checkpoint.`;
  if (b.status === "paused") return `Paused · ${pages(b.pagesDone)}.`;
  return `Running · ${pages(b.pagesDone)}. Runs in the background.`;
}

export const BACKFILL_CARD_ID = "syn-backfill-card";

export function BackfillSetupCard({
  backfill: b,
  sevenDay,
  onStart,
  confirmSignal = 0,
  initiallyConfirming = false,
}: {
  backfill: Backfill;
  /** Seven-day quota utilization (0–1) from /api/claude/status; null when unknown. */
  sevenDay: number | null;
  onStart: () => void;
  /** Increment to open the confirm step from outside (palette action). */
  confirmSignal?: number;
  /** Tests only: render the confirm step. */
  initiallyConfirming?: boolean;
}) {
  const [confirming, setConfirming] = useState(initiallyConfirming);
  const action = backfillAction(b);
  useEffect(() => {
    if (confirmSignal > 0) setConfirming(true);
  }, [confirmSignal]);
  const resume = b.status !== "idle";
  return (
    <CardFrame
      id={BACKFILL_CARD_ID}
      tag="SLACK · SETUP"
      tone="neutral"
      title="Collect the last 90 days of Slack"
    >
      <Explainer>{stateLine(b)}</Explainer>
      {action.enabled && confirming && (
        <div className="syn-ncard-confirm">
          <p>
            This uses Claude quota.{" "}
            {sevenDay === null
              ? "7-day usage isn't known yet."
              : `7-day usage is at ${Math.round(sevenDay * 100)}%.`}
          </p>
          <Actions>
            <Button
              variant="primary"
              onClick={() => {
                setConfirming(false);
                onStart();
              }}
            >
              {resume ? "Resume now" : "Start now"}
            </Button>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </Actions>
        </div>
      )}
      {action.enabled && !confirming && (
        <Actions>
          <Button variant="primary" onClick={() => setConfirming(true)}>
            {resume ? "Resume backfill…" : "Start backfill…"}
          </Button>
        </Actions>
      )}
    </CardFrame>
  );
}
