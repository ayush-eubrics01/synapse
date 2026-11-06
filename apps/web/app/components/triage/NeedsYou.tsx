"use client";

import type { EngineeringTaskDetail, EngineeringTaskView } from "@synapse/contracts";
import type { SecurityFlagDto } from "../../../lib/api";
import { type NeedsCard, needsYouCount } from "../../../lib/needs-you";
import type { NeedsYouHandlers } from "../../../lib/needs-you-actions";
import { Chip } from "../ui/Chip";
import { AllClear } from "./AllClear";
import { ApprovalCard } from "./ApprovalCard";
import { AwayDigestCard } from "./AwayDigestCard";
import { BrainReviewCard } from "./BrainReviewCard";
import { BrainSetupCard } from "./BrainSetupCard";
import { CommitmentReviewCard } from "./CommitmentReviewCard";
import {
  EngineeringApprovalCard,
  EngineeringAttentionCard,
  EngineeringPlanCard,
} from "./EngineeringCards";
import { FlagCard } from "./FlagCard";
import { FollowupCard } from "./FollowupCard";
import { JiraAttentionCard } from "./JiraAttentionCard";
import { JiraSetupCard } from "./JiraSetupCard";
import { OutgoingAttentionCard } from "./OutgoingAttentionCard";
import { RecommendationCard } from "./RecommendationCard";
import { BackfillSetupCard, IdentitySetupCard, PeopleSetupCard } from "./SetupCards";
import { UrgentCard } from "./UrgentCard";

export type { NeedsYouHandlers };

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
  /** Evaluations requested this session, shared with the People section. */
  queuedEvaluations?: ReadonlySet<string>;
  /** Engineering tasks and their details (diff, plan), for the engineering cards. */
  engineering?: {
    tasks: EngineeringTaskView[];
    details: Record<string, EngineeringTaskDetail>;
  };
}

function Card({ card, p }: { card: NeedsCard; p: NeedsYouProps }) {
  const h = p.handlers;
  switch (card.kind) {
    case "away-digest":
      return <AwayDigestCard digest={card.data} now={p.now} onDismiss={h.dismissAwayDigest} />;
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
    case "engineering-approval": {
      const taskId = (card.data.payload as { taskId?: unknown } | null)?.taskId;
      const id = typeof taskId === "string" ? taskId : null;
      return (
        <EngineeringApprovalCard
          approval={card.data}
          taskTitle={p.engineering?.tasks.find((t) => t.id === id)?.title ?? null}
          detail={id ? (p.engineering?.details[id] ?? null) : null}
          now={p.now}
          onDecide={h.decide}
        />
      );
    }
    case "engineering-plan":
      return (
        <EngineeringPlanCard
          task={card.data}
          detail={p.engineering?.details[card.data.id] ?? null}
          now={p.now}
          onOpen={h.seeAllEngineering}
        />
      );
    case "engineering-attention":
      return (
        <EngineeringAttentionCard
          task={card.data}
          now={p.now}
          onCancel={h.cancelEngineeringTask}
          onOpen={h.seeAllEngineering}
        />
      );
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
    case "jira-attention":
      return <JiraAttentionCard issues={card.data.issues} now={p.now} onSeeAll={h.seeAllJira} />;
    case "brain-review":
      return (
        <BrainReviewCard
          facts={card.data.facts}
          onAccept={(id) => h.acceptBrainFact(id)}
          onReject={h.rejectBrainFact}
          onSeeAll={h.seeAllProjects}
        />
      );
    case "setup-brain":
      return <BrainSetupCard onRegister={h.registerRepository} />;
    case "setup-jira":
      return (
        <JiraSetupCard
          scopeJql={card.data.scopeJql}
          excludedProjects={card.data.excludedProjects}
          onEnable={h.enableJira}
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
          queued={p.queuedEvaluations}
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
  // Status-only cards (a running backfill) are shown but not counted, matching the badge.
  const n = needsYouCount(props.cards);
  return (
    <div className="syn-needs">
      <div className="syn-needs-head">
        <h2 className="syn-needs-title">
          Needs you <Chip tone={n > 0 ? "red" : "neutral"}>{n}</Chip>
        </h2>
        <p className="syn-needs-sub">Decisions only you can make. Ordered by impact.</p>
      </div>
      {props.cards.length > 0 && (
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
