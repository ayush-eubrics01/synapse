import type {
  ApprovalView,
  AwayDigest,
  CandidatesResponse,
  EngineeringTaskView,
  JiraIssueView,
  ProjectFactView,
  RecommendationView,
  RepositoryView,
} from "@synapse/contracts";
import type {
  CommitmentViewDto,
  FollowupViewDto,
  GroupedFlagsDto,
  JiraStatusDto,
  PersonDto,
  ResolveDecisionDto,
  SlackIdentityDto,
  SlackStatusDto,
  UrgentItemDto,
} from "./api";
import { backfillAction } from "./backfill-action";
import { brainFactKey } from "./brain";
import { isEngineeringApproval } from "./engineering";
import { conversationLabel } from "./format";

/** A send whose delivery Synapse could not confirm: the user decides (mark sent, resend, discard). */
export interface OutgoingAttention {
  outgoingId: string;
  status: string;
  actions: ResolveDecisionDto[];
  origin: "urgent" | "followup";
  recipient: string;
  conversation: string;
  /** The requested text for a follow-up; null for an urgent reply (not part of the item). */
  text: string | null;
  at: string;
}

/** A fact waiting for review, with the project it belongs to. */
export interface BrainReviewFact {
  fact: ProjectFactView;
  projectName: string;
}

type Candidate = CandidatesResponse["candidates"][number];

interface CardBase {
  key: string;
  rank: number;
}

export type NeedsCard = CardBase &
  (
    | { kind: "away-digest"; data: AwayDigest }
    | { kind: "urgent"; data: UrgentItemDto }
    | { kind: "outgoing"; data: OutgoingAttention }
    | { kind: "approval"; data: ApprovalView }
    | { kind: "engineering-approval"; data: ApprovalView }
    | { kind: "engineering-plan"; data: EngineeringTaskView }
    | { kind: "engineering-attention"; data: EngineeringTaskView }
    | { kind: "flag"; data: GroupedFlagsDto }
    | { kind: "followup"; data: FollowupViewDto }
    | { kind: "commitment"; data: CommitmentViewDto }
    | { kind: "jira-attention"; data: { issues: JiraIssueView[] } }
    | { kind: "brain-review"; data: { facts: BrainReviewFact[] } }
    | { kind: "recommendation"; data: RecommendationView }
    | { kind: "setup-identity"; data: { identity: SlackIdentityDto; people: PersonDto[] } }
    | { kind: "setup-people"; data: { candidates: Candidate[] } }
    | { kind: "setup-backfill"; data: { backfill: SlackStatusDto["backfill"] } }
    | { kind: "setup-jira"; data: { scopeJql: string; excludedProjects: string[] } }
    | { kind: "setup-brain"; data: Record<string, never> }
  );

export type NeedsKind = NeedsCard["kind"];

export interface NeedsYouInput {
  urgent: UrgentItemDto[];
  approvals: ApprovalView[];
  flags: GroupedFlagsDto[];
  followups: FollowupViewDto[];
  reviewQueue: CommitmentViewDto[];
  recommendations: RecommendationView[];
  identity: SlackIdentityDto | null;
  /** Known Slack users, for the manual identity pick. */
  people: PersonDto[];
  candidates: CandidatesResponse | null;
  slackStatus: SlackStatusDto | null;
  /** The return digest of the last away session, until dismissed (spec A17). */
  awayDigest?: AwayDigest | null;
  /** Jira tracking status (null until loaded); absent in older callers. */
  jiraStatus?: JiraStatusDto | null;
  /** `GET /api/jira/issues?view=attention`: already filtered and in the backend's severity order. */
  jiraAttention?: JiraIssueView[];
  /** Facts needing review across projects (Phase 9); absent in older callers. */
  brainReview?: BrainReviewFact[];
  /** Registered repositories; null until loaded, so a slow load never shows the setup card. */
  repositories?: RepositoryView[] | null;
  /** Engineering tasks (Phase 10); absent in older callers. */
  engineeringTasks?: EngineeringTaskView[];
  /** Keys of items pending a deferred commit (spec D8): never shown, whatever the data says. */
  hidden: Set<string>;
}

// Spec D7. Gaps leave room; only the relative order matters.
const URGENT_RANK: Record<UrgentItemDto["level"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};
const FLAG_RANK: Record<GroupedFlagsDto["maxSeverity"], number> = {
  high: 30,
  warning: 31,
  info: 32,
};
/** Above every urgent level (0): the user just came back, and this is what happened meanwhile. */
const AWAY_DIGEST_RANK = -1;
const RANK = {
  outgoing: 10,
  /** After urgent items and sends, before every other approval. */
  engineering: 15,
  approval: 20,
  followup: 40,
  commitment: 50,
  jira: 55,
  brain: 56,
  recommendation: 60,
  identity: 70,
  people: 71,
  backfill: 72,
  jiraSetup: 73,
  brainSetup: 74,
} as const;

/** The key a flag card (and a deferred flag review) uses. */
export function flagKey(flagId: string): string {
  return `flag:${flagId}`;
}

function urgentOutgoing(i: UrgentItemDto): OutgoingAttention | null {
  const r = i.reply;
  if (!r || r.outgoingId === null) return null;
  if (r.actions.length === 0 && r.status !== "needs_attention") return null;
  return {
    outgoingId: r.outgoingId,
    status: r.outgoingStatus ?? r.status,
    actions: r.actions,
    origin: "urgent",
    recipient: i.sender.name ?? i.sender.id,
    conversation: conversationLabel(i.conversation),
    text: null,
    at: i.sentAt,
  };
}

function followupOutgoing(f: FollowupViewDto): OutgoingAttention | null {
  if (!f.outgoing) return null;
  if (f.resolveActions.length === 0 && f.status !== "needs_attention") return null;
  return {
    outgoingId: f.outgoing.id,
    status: f.outgoing.status,
    actions: f.resolveActions,
    origin: "followup",
    recipient: f.recipient ? (f.recipient.name ?? f.recipient.id) : "unknown recipient",
    conversation: f.conversationLabel ?? "an unknown conversation",
    text: f.draftText,
    at: f.updatedAt,
  };
}

/** Every decision waiting on the user, in the fixed D7 order, minus hidden (pending-undo) keys. */
export function buildNeedsYou(input: NeedsYouInput): NeedsCard[] {
  const cards: NeedsCard[] = [];
  const outgoing = new Set<string>();
  const addOutgoing = (o: OutgoingAttention | null) => {
    if (!o || outgoing.has(o.outgoingId)) return;
    outgoing.add(o.outgoingId);
    cards.push({ key: `outgoing:${o.outgoingId}`, kind: "outgoing", rank: RANK.outgoing, data: o });
  };

  if (input.awayDigest) {
    cards.push({
      key: `away-digest:${input.awayDigest.session.id}`,
      kind: "away-digest",
      rank: AWAY_DIGEST_RANK,
      data: input.awayDigest,
    });
  }

  for (const u of input.urgent) {
    cards.push({
      key: `urgent:${u.messageId}`,
      kind: "urgent",
      rank: URGENT_RANK[u.level],
      data: u,
    });
    addOutgoing(urgentOutgoing(u));
  }

  for (const f of input.followups) {
    const o = followupOutgoing(f);
    if (o) addOutgoing(o);
    else if (f.actions.length > 0) {
      cards.push({ key: `followup:${f.id}`, kind: "followup", rank: RANK.followup, data: f });
    }
  }

  // A profile approval is decided on its recommendation card.
  const onRecommendation = new Set(
    input.recommendations.map((r) => r.approvalId).filter((id): id is string => id !== null),
  );
  for (const a of input.approvals) {
    if (onRecommendation.has(a.id)) continue;
    if (isEngineeringApproval(a)) {
      cards.push({
        key: `approval:${a.id}`,
        kind: "engineering-approval",
        rank: RANK.engineering,
        data: a,
      });
      continue;
    }
    cards.push({ key: `approval:${a.id}`, kind: "approval", rank: RANK.approval, data: a });
  }

  for (const t of input.engineeringTasks ?? []) {
    if (t.status === "needs_attention") {
      cards.push({
        key: `eng-attention:${t.id}`,
        kind: "engineering-attention",
        rank: RANK.engineering,
        data: t,
      });
    } else if (t.status === "planned") {
      cards.push({
        key: `eng-plan:${t.id}`,
        kind: "engineering-plan",
        rank: RANK.engineering,
        data: t,
      });
    }
  }

  for (const g of input.flags) {
    const key = g.latestOpenId ? flagKey(g.latestOpenId) : `flag:person:${g.slackUserId}`;
    cards.push({ key, kind: "flag", rank: FLAG_RANK[g.maxSeverity], data: g });
  }

  for (const c of input.reviewQueue) {
    if (!c.actions.includes("accept")) continue;
    cards.push({ key: `commitment:${c.id}`, kind: "commitment", rank: RANK.commitment, data: c });
  }

  // One card for all issues that need attention, as the backend lists them (it owns the rules
  // and the order); the card shows the first few.
  const jiraAttention = input.jiraStatus?.enabled ? (input.jiraAttention ?? []) : [];
  if (jiraAttention.length > 0) {
    cards.push({
      key: "jira-attention",
      kind: "jira-attention",
      rank: RANK.jira,
      data: { issues: jiraAttention },
    });
  }

  // One card for the facts waiting on review; a fact pending a deferred reject is left out.
  const reviewFacts = (input.brainReview ?? []).filter(
    (r) => !input.hidden.has(brainFactKey(r.fact.id)),
  );
  if (reviewFacts.length > 0) {
    cards.push({
      key: "brain-review",
      kind: "brain-review",
      rank: RANK.brain,
      data: { facts: reviewFacts },
    });
  }

  for (const r of input.recommendations) {
    cards.push({
      key: `recommendation:${r.id}`,
      kind: "recommendation",
      rank: RANK.recommendation,
      data: r,
    });
  }

  const id = input.identity;
  // Always shown while unset, like the briefing's count; with nothing to pick it says so.
  if (id && id.selfUserId === null) {
    cards.push({
      key: "setup:identity",
      kind: "setup-identity",
      rank: RANK.identity,
      data: { identity: id, people: input.people },
    });
  }

  const c = input.candidates;
  const evaluable =
    c && !c.identityRequired ? c.candidates.filter((x) => x.actions.includes("evaluate")) : [];
  if (evaluable.length > 0) {
    cards.push({
      key: "setup:people",
      kind: "setup-people",
      rank: RANK.people,
      data: { candidates: evaluable },
    });
  }

  const s = input.slackStatus;
  if (s && s.backfill.status !== "complete") {
    cards.push({
      key: "setup:backfill",
      kind: "setup-backfill",
      rank: RANK.backfill,
      data: { backfill: s.backfill },
    });
  }

  const js = input.jiraStatus;
  if (js && !js.enabled) {
    cards.push({
      key: "setup:jira",
      kind: "setup-jira",
      rank: RANK.jiraSetup,
      data: { scopeJql: js.scopeJql, excludedProjects: js.excludedProjects },
    });
  }

  if (Array.isArray(input.repositories) && input.repositories.length === 0) {
    cards.push({ key: "setup:brain", kind: "setup-brain", rank: RANK.brainSetup, data: {} });
  }

  // Array.prototype.sort is stable: equal ranks keep the API's order.
  return cards.filter((card) => !input.hidden.has(card.key)).sort((a, b) => a.rank - b.rank);
}

/**
 * False for a status-only card: a backfill that is running (or paused) with nothing to start or
 * resume. It is still shown, but it isn't a decision, so it isn't counted or offered in the palette.
 */
export function isActionable(card: NeedsCard): boolean {
  if (card.kind === "setup-backfill") return backfillAction(card.data.backfill).enabled;
  return true;
}

/** The Needs-you badge and header count: cards that need a decision. */
export function needsYouCount(cards: NeedsCard[]): number {
  return cards.filter(isActionable).length;
}

const CLEAR: Array<{ kind: NeedsKind; label: string; value: string }> = [
  { kind: "urgent", label: "Urgent inbox", value: "nothing urgent" },
  { kind: "approval", label: "Pending approvals", value: "none waiting" },
  { kind: "recommendation", label: "Profile suggestions", value: "none to review" },
  { kind: "flag", label: "Red flags", value: "none open" },
];

/** One "✓" row for each of these categories that has no card. */
export function allClearRows(input: NeedsYouInput): Array<{ label: string; value: string }> {
  const kinds = new Set<NeedsKind>(
    buildNeedsYou(input).map((c) => (c.kind === "engineering-approval" ? "approval" : c.kind)),
  );
  return CLEAR.filter((r) => !kinds.has(r.kind)).map(({ label, value }) => ({ label, value }));
}
