import { expect, test } from "bun:test";
import type {
  CandidatesResponse,
  CommitmentFilter,
  EvidenceView,
  PersonDetail,
} from "@synapse/contracts";
import { renderToString } from "react-dom/server";
import { CommitmentsPanel } from "../app/components/CommitmentsPanel";
import { PeopleCandidates } from "../app/components/PeopleCandidates";
import { PersonProfile } from "../app/components/PersonProfile";
import { SlackStatus } from "../app/components/SlackStatus";
import type { CommitmentViewDto, SlackStatusDto } from "../lib/api";

const ev = (o: Partial<EvidenceView> = {}): EvidenceView => ({
  observationKey: "communication.brief",
  sourceExternalRef: "C1:1.0",
  messageAvailable: true,
  confidence: "high",
  permalink: null,
  ...o,
});
test("PeopleCandidates shows the identity notice instead of a list", () => {
  const html = renderToString(
    <PeopleCandidates data={{ identityRequired: true, candidates: [] }} onEvaluate={() => {}} />,
  );
  expect(html).toContain("Confirm your Slack identity");
  expect(html).not.toContain("<button");
});

test("PeopleCandidates lists candidates and the Evaluate button only when allowed", () => {
  const base = {
    name: "Grace",
    score: 9,
    messageCount: 4,
    hasProfile: false,
    hasPendingRecommendation: false,
    isTemporary: false,
  };
  const data: CandidatesResponse = {
    identityRequired: false,
    candidates: [
      { ...base, slackUserId: "U1", actions: ["evaluate"] },
      { ...base, slackUserId: "U2", name: "Linus", hasProfile: true, actions: [] },
    ],
  };
  const html = renderToString(<PeopleCandidates data={data} onEvaluate={() => {}} />);
  expect(html).toContain("Grace");
  expect(html).toContain("Linus");
  expect(html.match(/Evaluate/g)?.length).toBe(1);
});

test("PersonProfile shows version, versions list, evidence and priority controls", () => {
  const person: PersonDetail = {
    slackUserId: "U1",
    name: "Grace",
    title: null,
    team: null,
    email: null,
    rationale: null,
    priority: "high",
    extraAttention: false,
    hasProfile: true,
    profileVersion: 2,
    hasPendingRecommendation: false,
    profile: {
      version: 2,
      updatedAt: "2026-01-02T00:00:00.000Z",
      content: {
        professionalContext: [],
        communication: [
          { key: "brief", text: "Prefers short messages", evidence: ["m"], confidence: "high" },
        ],
        responseGuidelines: [],
      },
      evidence: [ev({ observationKey: "communication.brief", messageAvailable: false })],
    },
    versions: [
      { version: 1, createdAt: "2026-01-01T00:00:00.000Z", approvalId: "a1" },
      { version: 2, createdAt: "2026-01-02T00:00:00.000Z", approvalId: "a2" },
    ],
    temporaryContact: null,
    flagCount: 1,
    actions: [],
  };
  // React inserts comment markers between adjacent text nodes; drop them to match on text.
  const raw = renderToString(
    <PersonProfile
      person={person}
      onClose={() => {}}
      onEvaluate={() => {}}
      onPriority={() => {}}
    />,
  );
  const html = raw.replace(/<!-- -->/g, "");
  expect(html).toContain("Current version 2");
  expect(html).toContain("v1");
  expect(html).toContain("v2");
  expect(html).toContain("Prefers short messages");
  expect(html).toContain("original message no longer available locally");
  expect(html).toContain("Priority for Grace");
  expect(html).toContain("1 red flag");
  expect(html).not.toContain("Evaluate");
  expect(
    renderToString(
      <PersonProfile
        person={null}
        onClose={() => {}}
        onEvaluate={() => {}}
        onPriority={() => {}}
      />,
    ),
  ).toBe("");
});

// Task 9: commitments
const commitment = (o: Partial<CommitmentViewDto> = {}): CommitmentViewDto => ({
  id: "c1",
  description: "ship <b>report</b>",
  ownerSlackUserId: "U1",
  ownerName: "Ada",
  counterpartySlackUserId: "U2",
  counterpartyName: null,
  direction: "theirs",
  status: "open",
  reviewStatus: "accepted",
  dueAt: null,
  nextAction: null,
  completionEvidence: null,
  stalledAt: null,
  lastFollowupAt: null,
  closedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  sources: [],
  proposals: [],
  followups: [],
  actions: ["start", "block", "complete", "cancel", "draft_followup"],
  ...o,
});
const renderCommitments = (
  items: CommitmentViewDto[],
  queue: CommitmentViewDto[] = [],
  filter: CommitmentFilter = "all",
) =>
  renderToString(
    <CommitmentsPanel
      queue={queue}
      items={items}
      filter={filter}
      onFilter={() => {}}
      onReview={() => {}}
      onStatus={() => {}}
      onProposal={() => {}}
      onDraftFollowup={() => {}}
    />,
  );

test("CommitmentsPanel shows filter tabs, status buttons from the server's actions, and text as text", () => {
  const html = renderCommitments([commitment()]);
  for (const l of ["All", "Mine", "Theirs", "Overdue", "Due soon", "Blocked", "Closed"]) {
    expect(html).toContain(l);
  }
  for (const l of ["Start", "Block", "Complete", "Cancel", "Draft follow-up"]) {
    expect(html).toContain(l);
  }
  expect(html).not.toContain("Unblock");
  expect(html).toContain("ship &lt;b&gt;report&lt;/b&gt;");
  expect(html).not.toContain("Accept");
  const closed = renderCommitments([commitment({ status: "completed", actions: [] })]);
  expect(closed).not.toContain("Start");
  expect(closed).not.toContain("Draft follow-up");
});

test("CommitmentsPanel review queue offers Accept, Edit and Reject; expired sources say so", () => {
  const queued = commitment({
    reviewStatus: "pending_review",
    actions: ["accept", "reject", "edit"],
    sources: [
      { sourceExternalRef: "C1:1", messageAvailable: false, permalink: null },
      { sourceExternalRef: "C1:2", messageAvailable: true, permalink: "https://x.slack.com/a" },
    ],
  });
  const html = renderCommitments([], [queued]);
  expect(html).toContain("Review queue");
  for (const l of ["Accept", "Edit", "Reject"]) expect(html).toContain(l);
  expect(html).toContain("original message no longer available locally");
  expect(html).toContain('href="https://x.slack.com/a"');
  // The server computed no review actions: nothing to review.
  expect(renderCommitments([], [commitment()])).not.toContain("Review queue");
});

test("CommitmentsPanel shows proposal confirm and reject only with confirm_proposal", () => {
  const p = { updateId: "u1", sourceExternalRef: "C1:1", proposedAt: "2026-01-01T00:00:00.000Z" };
  const html = renderCommitments([
    commitment({ proposals: [p], actions: ["start", "confirm_proposal"] }),
  ]);
  expect(html).toContain("Confirm completed");
  expect(html).toContain("Reject proposal");
  expect(renderCommitments([commitment({ proposals: [p], actions: ["start"] })])).not.toContain(
    "Confirm completed",
  );
});

// Moves to the System section with Task 6.
const sync = {
  stream: "slack.messages",
  checkpoint: null,
  upperBound: null,
  status: "idle" as const,
  pagesDone: 0,
  lastSuccessAt: null,
  lastError: null,
  nextRunAfter: null,
};
const slackStatus = (o: Partial<SlackStatusDto["incremental"]> = {}): SlackStatusDto => ({
  incremental: { ...sync, ...o },
  backfill: { ...sync, stream: "slack.backfill", resumable: false },
  searchesToday: 3,
});

test("SlackStatus offers Skip unreadable page only for a stalled parse, and no backfill button", () => {
  const stalled = renderToString(
    <SlackStatus
      status={slackStatus({ status: "error", lastError: { kind: "parse_failed", message: "m" } })}
      onSkip={() => {}}
    />,
  );
  expect(stalled).toContain("Skip unreadable page");
  const fine = renderToString(<SlackStatus status={slackStatus()} onSkip={() => {}} />);
  expect(fine).not.toContain("Skip unreadable page");
  // The backfill is started from the Needs-you setup card now.
  expect(fine).not.toContain("<button");
});
