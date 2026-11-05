import { expect, test } from "bun:test";
import type {
  ApprovalView,
  CandidatesResponse,
  CommitmentFilter,
  EvidenceView,
  PersonDetail,
  RecommendationView,
} from "@synapse/contracts";
import { renderToString } from "react-dom/server";
import { ApprovalsList } from "../app/components/ApprovalsList";
import { CommitmentsPanel } from "../app/components/CommitmentsPanel";
import { FollowupDrafts } from "../app/components/FollowupDrafts";
import { IdentitySetup } from "../app/components/IdentitySetup";
import { PeopleCandidates } from "../app/components/PeopleCandidates";
import { PersonProfile } from "../app/components/PersonProfile";
import { ProfileRecommendations } from "../app/components/ProfileRecommendations";
import { UrgentInbox } from "../app/components/UrgentInbox";
import type { CommitmentViewDto, FollowupViewDto, UrgentItemDto } from "../lib/api";

const item = (o: Partial<UrgentItemDto> = {}): UrgentItemDto => ({
  messageId: "m1",
  level: "high",
  reason: "r",
  status: "in_progress",
  allowedTransitions: ["resolved", "dismissed"],
  assessed: true,
  fallback: false,
  coalesced: false,
  sender: { id: "U1", name: "Ada" },
  conversation: { id: "C1", name: "ops", type: "channel" },
  sentAt: "2026-01-01T00:00:00.000Z",
  text: "hello",
  permalink: null,
  draft: null,
  reply: null,
  ...o,
});
const render = (items: UrgentItemDto[]) =>
  renderToString(<UrgentInbox items={items} onStatus={() => {}} onCopy={() => {}} />);

test("UrgentInbox tags unassessed and rule-based items", () => {
  expect(render([item({ assessed: false })])).toContain("not yet assessed");
  expect(render([item({ fallback: true })])).toContain("rule-based");
  const plain = render([item()]);
  expect(plain).not.toContain("not yet assessed");
  expect(plain).not.toContain("rule-based");
});

test("UrgentInbox tags coalesced thread follow-ups (R17)", () => {
  expect(render([item({ coalesced: true })])).toContain("follow-up in thread");
  expect(render([item()])).not.toContain("follow-up in thread");
});

test("UrgentInbox shows expired content, the draft label and Copy", () => {
  const html = render([item({ text: null, draft: { text: null, confidence: 0.4 } })]);
  expect(html.match(/content expired/g)?.length).toBe(2);
  expect(html).toContain("Draft — not sent");
  expect(html).not.toContain("Copy");
  const live = render([item({ draft: { text: "thanks", confidence: 0.9 } })]);
  expect(live).toContain("Copy");
});

const reply = (o: Partial<NonNullable<UrgentItemDto["reply"]>> = {}) => ({
  followupId: "f1",
  status: "awaiting_approval",
  approvalId: "a1",
  outgoingId: "o1",
  outgoingStatus: "pending",
  canRequest: false,
  actions: [],
  ...o,
});
const withDraft = (o: Partial<UrgentItemDto> = {}) =>
  item({ draft: { text: "thanks <b>x</b>", confidence: 0.9 }, ...o });

test("UrgentInbox shows an editable draft and the approval button only when no reply is pending", () => {
  const html = render([withDraft()]);
  expect(html).toContain("<textarea");
  expect(html).toContain('maxLength="4000"');
  expect(html).toContain("Send for approval");
  expect(html).toContain("Requires your approval");
  expect(html).toContain("thanks &lt;b&gt;x&lt;/b&gt;"); // text, never markup
  const pending = render([withDraft({ reply: reply() })]);
  expect(pending).toContain("Awaiting approval");
  expect(pending).not.toContain("Send for approval");
  expect(pending).not.toContain("<textarea");
  // After a revoke the draft is editable again.
  const revoked = render([
    withDraft({ reply: reply({ status: "draft", outgoingStatus: "failed", canRequest: true }) }),
  ]);
  expect(revoked).toContain("Send for approval");
});

test("UrgentInbox status line and resolve buttons come from the server", () => {
  const status = (outgoingStatus: string, actions: ("mark_sent" | "resend" | "discard")[] = []) =>
    render([withDraft({ reply: reply({ outgoingStatus, actions }) })]);
  expect(status("sending")).toContain("Sending");
  expect(status("sent")).toContain("Sent");
  expect(status("sent_unverified")).toContain("Sent (unverified)");
  const na = status("needs_attention", ["mark_sent", "resend", "discard"]);
  expect(na).toContain("Needs attention — check Slack");
  for (const l of ["Mark sent", "Resend", "Discard"]) expect(na).toContain(l);
  const exhausted = status("sent_unverified", ["mark_sent", "discard"]);
  expect(exhausted).not.toContain("Resend");
  expect(status("sent")).not.toContain("Mark sent");
});

test("ApprovalsList shows the exact text, recipient and conversation of a send (H4)", () => {
  const a = {
    id: "a1",
    action: "slack.send",
    targetIntegration: "slack",
    targetRef: "C1",
    payload: {},
    riskLevel: "medium",
    status: "pending",
    requestedByModule: "inbox",
    requestedByWorker: null,
    expiresAt: null,
    decidedAt: null,
    executionResult: null,
    idempotencyKey: "k",
    createdAt: "2026-01-01T00:00:00.000Z",
    outgoing: {
      text: "ship <i>it</i>",
      recipientName: "Ada",
      conversationLabel: "a DM",
      threadReply: true,
    },
  } as unknown as ApprovalView;
  const html = renderToString(<ApprovalsList approvals={[a]} onDecide={() => {}} />);
  expect(html).toContain("ship &lt;i&gt;it&lt;/i&gt;");
  expect(html).toContain("Ada");
  expect(html).toContain("a DM");
  expect(html).toContain("thread reply");
});

test("UrgentInbox status buttons match allowedTransitions only", () => {
  const html = render([item()]);
  expect(html).toContain("Resolve");
  expect(html).toContain("Dismiss");
  expect(html).not.toContain("Acknowledge");
  expect(render([item({ allowedTransitions: [] })])).not.toContain("<button");
});

test("UrgentInbox renders the link only when a permalink is present", () => {
  expect(render([item()])).not.toContain("<a ");
  expect(render([item({ permalink: "https://x.slack.com/p1" })])).toContain(
    "https://x.slack.com/p1",
  );
});

test("IdentitySetup renders nothing once selfUserId is set", () => {
  const base = { suggestion: "U1", suggestionName: "Ada" };
  expect(
    renderToString(
      <IdentitySetup identity={{ ...base, selfUserId: "U1" }} people={[]} onConfirm={() => {}} />,
    ),
  ).toBe("");
  expect(
    renderToString(
      <IdentitySetup identity={{ ...base, selfUserId: null }} people={[]} onConfirm={() => {}} />,
    ),
  ).toContain("Confirm");
});

test("IdentitySetup offers a manual pick from people when there is no suggestion (R18)", () => {
  const people = [
    {
      slackUserId: "U1",
      name: "Ada",
      rationale: null,
      priority: "normal" as const,
      extraAttention: false,
    },
    {
      slackUserId: "U2",
      name: null,
      rationale: null,
      priority: "normal" as const,
      extraAttention: false,
    },
  ];
  const html = renderToString(
    <IdentitySetup
      identity={{ selfUserId: null, suggestion: null, suggestionName: null }}
      people={people}
      onConfirm={() => {}}
    />,
  );
  expect(html).toContain("<select");
  expect(html).toContain("Ada (U1)");
  expect(html).toContain("U2");
  expect(html).toContain("Confirm");
  // The banner says why urgent alerts are paused.
  expect(html).toContain("notifications and suggested replies are paused");
  const none = renderToString(
    <IdentitySetup
      identity={{ selfUserId: null, suggestion: null, suggestionName: null }}
      people={[]}
      onConfirm={() => {}}
    />,
  );
  expect(none).not.toContain("<select");
});

const ev = (o: Partial<EvidenceView> = {}): EvidenceView => ({
  observationKey: "communication.brief",
  sourceExternalRef: "C1:1.0",
  messageAvailable: true,
  confidence: "high",
  permalink: null,
  ...o,
});
const rec = (o: Partial<RecommendationView> = {}): RecommendationView => ({
  id: "r1",
  kind: "initial",
  status: "pending",
  person: { slackUserId: "U1", name: "Grace" },
  baseVersion: null,
  proposed: [
    {
      section: "communication",
      key: "brief",
      text: "Prefers short messages",
      confidence: "high",
      evidence: [ev()],
    },
  ],
  diff: null,
  approvalId: "a1",
  approvalStatus: "pending",
  actions: ["approve", "reject"],
  reason: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...o,
});
const renderRecs = (items: RecommendationView[]) =>
  renderToString(
    <ProfileRecommendations
      items={items}
      onDecide={() => {}}
      onRetry={() => {}}
      onEvaluate={() => {}}
      onDismiss={() => {}}
      onDiscard={() => {}}
    />,
  );

test("ProfileRecommendations renders an update diff with added and removed observations", () => {
  const html = renderRecs([
    rec({
      kind: "update",
      baseVersion: 2,
      proposed: null,
      diff: {
        added: [
          {
            section: "communication",
            key: "async",
            text: "Likes async updates",
            confidence: "medium",
            evidence: [],
          },
        ],
        removed: [
          { section: "communication", key: "brief", text: "Prefers short messages", evidence: [] },
        ],
      },
    }),
  ]);
  expect(html).toContain("update to version 2");
  expect(html).toContain("Likes async updates");
  expect(html).toContain("Prefers short messages");
  expect(html).toContain("line-through");
});

test("ProfileRecommendations shows expired evidence text, and a link only for an available permalink", () => {
  const expired = renderRecs([
    rec({
      proposed: [
        {
          section: "communication",
          key: "brief",
          text: "t",
          confidence: "low",
          evidence: [ev({ messageAvailable: false })],
        },
      ],
    }),
  ]);
  expect(expired).toContain("original message no longer available locally");
  expect(expired).not.toContain("<a ");
  const live = renderRecs([
    rec({
      proposed: [
        {
          section: "communication",
          key: "brief",
          text: "t",
          confidence: "low",
          evidence: [ev({ permalink: "https://x.slack.com/p1" })],
        },
      ],
    }),
  ]);
  expect(live).toContain('href="https://x.slack.com/p1"');
  expect(live).not.toContain("no longer available");
});

test("ProfileRecommendations renders text as text, never as HTML", () => {
  const html = renderRecs([
    rec({
      proposed: [
        {
          section: "communication",
          key: "k",
          text: "<img src=x onerror=alert(1)>",
          confidence: "low",
          evidence: [],
        },
      ],
    }),
  ]);
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;img");
});

test("ProfileRecommendations buttons follow the server's actions", () => {
  const both = renderRecs([rec()]);
  expect(both).toContain("Approve");
  expect(both).toContain("Reject");
  expect(both).toContain("Reject reason");
  expect(both).not.toContain("Retry");
  const none = renderRecs([rec({ actions: [] })]);
  expect(none).not.toContain("<button");
  const noApproval = renderRecs([rec({ approvalId: null })]);
  expect(noApproval).not.toContain("Approve");
});

test("ProfileRecommendations shows Retry for a failed apply, and Evaluate for a suggestion", () => {
  const failed = renderRecs([rec({ approvalStatus: "failed", actions: ["retry"] })]);
  expect(failed).toContain("Apply failed — Retry");
  expect(failed).not.toContain("Approve");
  const suggestion = renderRecs([
    rec({
      kind: "suggest_evaluation",
      proposed: null,
      approvalId: null,
      approvalStatus: null,
      actions: ["evaluate"],
      reason: "talks to you often",
    }),
  ]);
  expect(suggestion).toContain("Evaluate");
  expect(suggestion).toContain("talks to you often");
  expect(renderRecs([])).toContain("No profile recommendations");
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

test("ProfileRecommendations renders Dismiss only when the actions include dismiss", () => {
  const sug = rec({
    kind: "suggest_evaluation",
    proposed: null,
    approvalId: null,
    approvalStatus: null,
    reason: "r",
  });
  expect(renderRecs([{ ...sug, actions: ["evaluate", "dismiss"] }])).toContain("Dismiss");
  expect(renderRecs([{ ...sug, actions: ["evaluate"] }])).not.toContain("Dismiss");
});

test("ProfileRecommendations renders Discard only when the actions include discard", () => {
  const stuck = rec({ approvalStatus: "revoked", actions: ["discard"] });
  const html = renderRecs([stuck]);
  expect(html).toContain("Discard");
  expect(html).not.toContain("Approve");
  expect(renderRecs([rec({ approvalStatus: "failed", actions: ["retry", "discard"] })])).toContain(
    "Discard",
  );
  expect(renderRecs([rec({ approvalStatus: "failed", actions: ["retry"] })])).not.toContain(
    "Discard",
  );
});

// Task 9: commitments and follow-up drafts
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

const followup = (o: Partial<FollowupViewDto> = {}): FollowupViewDto => ({
  id: "f1",
  commitmentId: "c1",
  origin: "stalled",
  recipient: { id: "U1", name: "Ada" },
  conversationLabel: "#ops",
  threadReply: true,
  noThread: false,
  draftText: "any update <i>please</i>?",
  confidence: 0.8,
  status: "draft",
  outgoing: null,
  approvalId: null,
  actions: ["send", "discard"],
  resolveActions: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...o,
});
const renderDrafts = (items: FollowupViewDto[]) =>
  renderToString(
    <FollowupDrafts items={items} onSend={() => {}} onDiscard={() => {}} onResolve={() => {}} />,
  );

test("FollowupDrafts shows an editable draft with recipient, conversation and the approval label", () => {
  const html = renderDrafts([followup()]);
  expect(html).toContain("<textarea");
  expect(html).toContain('maxLength="4000"');
  expect(html).toContain("Ada");
  expect(html).toContain("#ops");
  expect(html).toContain("Send for approval");
  expect(html).toContain("Requires your approval");
  expect(html).toContain("Discard");
  expect(html).toContain("any update &lt;i&gt;please&lt;/i&gt;?");
  expect(html).not.toContain("Posts as a new message");
  expect(renderDrafts([followup({ noThread: true })])).toContain(
    "Posts as a new message (original expired)",
  );
});

test("FollowupDrafts hides send controls without the send action and shows server status and resolve actions", () => {
  const waiting = renderDrafts([
    followup({
      status: "awaiting_approval",
      actions: [],
      outgoing: { id: "o1", status: "pending", failure: null },
    }),
  ]);
  expect(waiting).toContain("Awaiting approval");
  expect(waiting).not.toContain("Send for approval");
  expect(waiting).not.toContain("<textarea");
  const na = renderDrafts([
    followup({
      status: "needs_attention",
      actions: [],
      outgoing: { id: "o1", status: "needs_attention", failure: "uncertain_outcome" },
      resolveActions: ["mark_sent", "resend", "discard"],
    }),
  ]);
  expect(na).toContain("Needs attention — check Slack");
  for (const l of ["Mark sent", "Resend", "Discard send"]) expect(na).toContain(l);
  const exhausted = renderDrafts([
    followup({
      actions: [],
      outgoing: { id: "o1", status: "sent_unverified", failure: "unverified" },
      resolveActions: ["mark_sent", "discard"],
    }),
  ]);
  expect(exhausted).not.toContain("Resend");
  expect(renderDrafts([])).toContain("No follow-up drafts");
});
