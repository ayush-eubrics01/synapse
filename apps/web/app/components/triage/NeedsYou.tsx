"use client";

import type {
  CommitmentEditsDto,
  FlagReviewStatus,
  ResolveDecisionDto,
  SecurityFlagDto,
  UrgencyStatusDto,
} from "../../../lib/api";
import type { NeedsCard } from "../../../lib/needs-you";
import type { Decision } from "../../../lib/people-decision";
import { Chip } from "../ui/Chip";
import { AllClear } from "./AllClear";
import { ApprovalCard } from "./ApprovalCard";
import { CommitmentReviewCard } from "./CommitmentReviewCard";
import { FlagCard } from "./FlagCard";
import { FollowupCard } from "./FollowupCard";
import { OutgoingAttentionCard } from "./OutgoingAttentionCard";
import { RecommendationCard } from "./RecommendationCard";
import { BackfillSetupCard, IdentitySetupCard, PeopleSetupCard } from "./SetupCards";
import { UrgentCard } from "./UrgentCard";

/** What the cards can do. The page decides which run at once and which are deferred (spec D8). */
export interface NeedsYouHandlers {
  urgentStatus: (messageId: string, status: UrgencyStatusDto) => void;
  urgentReply: (messageId: string, text: string) => void;
  resolve: (outgoingId: string, decision: ResolveDecisionDto) => void;
  decide: (approvalId: string, decision: "approve" | "reject") => void;
  reviewFlag: (flagId: string, status: FlagReviewStatus) => void;
  toggleHistory: (slackUserId: string) => void;
  sendFollowup: (id: string, text: string) => void;
  discardFollowup: (id: string) => void;
  trackCommitment: (id: string, edits?: CommitmentEditsDto) => void;
  rejectCommitment: (id: string) => void;
  recDecide: (d: Decision) => void;
  recDismiss: (id: string) => void;
  recDiscard: (id: string) => void;
  recRetry: (id: string) => void;
  recEvaluate: (id: string) => void;
  confirmIdentity: (slackUserId: string) => void;
  evaluatePerson: (slackUserId: string) => void;
  seeAllPeople: () => void;
  startBackfill: () => void;
}

export interface NeedsYouProps {
  cards: NeedsCard[];
  allClear: Array<{ label: string; value: string }>;
  now: Date | null;
  handlers: NeedsYouHandlers;
  /** Slack ids whose red-flag history is open. */
  expanded: string[];
  history: Record<string, SecurityFlagDto[]>;
  hidden: Set<string>;
  /** Seven-day quota utilization (0–1) for the backfill confirm step. */
  sevenDay: number | null;
  onCopy: (text: string) => void | Promise<void>;
  backfillConfirmSignal?: number;
}

function Card({ card, p }: { card: NeedsCard; p: NeedsYouProps }) {
  const h = p.handlers;
  switch (card.kind) {
    case "urgent":
      return (
        <UrgentCard
          item={card.data}
          now={p.now}
          onStatus={h.urgentStatus}
          onReply={h.urgentReply}
          onCopy={p.onCopy}
        />
      );
    case "outgoing":
      return <OutgoingAttentionCard out={card.data} now={p.now} onResolve={h.resolve} />;
    case "approval":
      return <ApprovalCard approval={card.data} now={p.now} onDecide={h.decide} />;
    case "flag":
      return (
        <FlagCard
          group={card.data}
          now={p.now}
          open={p.expanded.includes(card.data.slackUserId)}
          history={p.history[card.data.slackUserId]}
          hidden={p.hidden}
          onToggle={h.toggleHistory}
          onReview={h.reviewFlag}
        />
      );
    case "followup":
      return (
        <FollowupCard
          f={card.data}
          now={p.now}
          onSend={h.sendFollowup}
          onDiscard={h.discardFollowup}
        />
      );
    case "commitment":
      return (
        <CommitmentReviewCard
          c={card.data}
          now={p.now}
          onTrack={h.trackCommitment}
          onReject={h.rejectCommitment}
        />
      );
    case "recommendation":
      return (
        <RecommendationCard
          r={card.data}
          now={p.now}
          onDecide={h.recDecide}
          onRetry={h.recRetry}
          onEvaluate={h.recEvaluate}
          onDismiss={h.recDismiss}
          onDiscard={h.recDiscard}
        />
      );
    case "setup-identity":
      return (
        <IdentitySetupCard
          identity={card.data.identity}
          people={card.data.people}
          onConfirm={h.confirmIdentity}
        />
      );
    case "setup-people":
      return (
        <PeopleSetupCard
          candidates={card.data.candidates}
          onEvaluate={h.evaluatePerson}
          onSeeAll={h.seeAllPeople}
        />
      );
    case "setup-backfill":
      return (
        <BackfillSetupCard
          backfill={card.data.backfill}
          sevenDay={p.sevenDay}
          onStart={h.startBackfill}
          confirmSignal={p.backfillConfirmSignal}
        />
      );
  }
}

/** The decision feed (spec D7): cards in impact order, then the all-clear checklist. */
export function NeedsYou(props: NeedsYouProps) {
  const n = props.cards.length;
  return (
    <div className="syn-needs">
      <div className="syn-needs-head">
        <h2 className="syn-needs-title">
          Needs you <Chip tone={n > 0 ? "red" : "neutral"}>{n}</Chip>
        </h2>
        <p className="syn-needs-sub">Decisions only you can make. Ordered by impact.</p>
      </div>
      {n > 0 && (
        <div className="syn-needs-list">
          {props.cards.map((card) => (
            <Card key={card.key} card={card} p={props} />
          ))}
        </div>
      )}
      <AllClear rows={props.allClear} />
    </div>
  );
}
