import { expect, test } from "bun:test";
import type { ApprovalView, EvidenceView, RecommendationView } from "@synapse/contracts";
import { renderToString } from "react-dom/server";
import { AllClear } from "../app/components/triage/AllClear";
import { ApprovalCard } from "../app/components/triage/ApprovalCard";
import { CommitmentReviewCard } from "../app/components/triage/CommitmentReviewCard";
import { FlagCard } from "../app/components/triage/FlagCard";
import { FollowupCard } from "../app/components/triage/FollowupCard";
import { NeedsYou, type NeedsYouHandlers } from "../app/components/triage/NeedsYou";
import { OutgoingAttentionCard } from "../app/components/triage/OutgoingAttentionCard";
import { RecommendationCard } from "../app/components/triage/RecommendationCard";
import {
  BackfillSetupCard,
  IdentitySetupCard,
  PeopleSetupCard,
} from "../app/components/triage/SetupCards";
import { UrgentCard } from "../app/components/triage/UrgentCard";
import type {
  CommitmentViewDto,
  FollowupViewDto,
  GroupedFlagsDto,
  PersonDto,
  SlackStatusDto,
  UrgentItemDto,
} from "../lib/api";
import { allClearRows, buildNeedsYou, type NeedsYouInput } from "../lib/needs-you";

const T = "2026-01-01T00:00:00.000Z";
const NOW = new Date("2026-01-01T00:05:00.000Z");
// React inserts comment markers between adjacent text nodes; drop them to match on text.
const text = (html: string) => html.replace(/<!-- -->/g, "");

// ---------------------------------------------------------------- urgent

const item = (o: Partial<UrgentItemDto> = {}): UrgentItemDto => ({
  messageId: "m1",
  level: "high",
  reason: "r",
  status: "in_progress",
  allowedTransitions: ["resolved", "dismissed"],
  assessed: true,
  fallback: false,
  coalesced: false,
  sender: { id: "U0ADA0001", name: "Ada" },
  conversation: { id: "C0OPS0001", name: "ops", type: "channel" },
  sentAt: T,
  text: "hello",
  permalink: null,
  draft: null,
  reply: null,
  ...o,
});
const render = (i: UrgentItemDto) =>
  text(
    renderToString(
      <UrgentCard item={i} now={NOW} onStatus={() => {}} onReply={() => {}} onCopy={() => {}} />,
    ),
  );

test("UrgentCard has the URGENT kind tag with the level and the time and conversation", () => {
  const html = render(item({ level: "critical" }));
  expect(html).toContain("URGENT · CRITICAL");
  expect(html).toContain("5 min ago · #ops");
  expect(html).toContain("Ada");
});

test("UrgentCard shows its status as a chip and the absolute sent time as the meta tooltip", () => {
  const html = render(item());
  expect(html).toMatch(/syn-chip syn-chip--neutral[^"]*"[^>]*>in progress</);
  expect(html).toContain(`title="${new Date(T).toLocaleString()}"`);
  expect(render(item({ status: "new" }))).toMatch(/syn-chip--neutral[^"]*"[^>]*>new</);
});

test("UrgentCard tags unassessed and rule-based items", () => {
  expect(render(item({ assessed: false }))).toContain("not yet assessed");
  expect(render(item({ fallback: true }))).toContain("rule-based");
  const plain = render(item());
  expect(plain).not.toContain("not yet assessed");
  expect(plain).not.toContain("rule-based");
});

test("UrgentCard tags coalesced thread follow-ups (R17)", () => {
  expect(render(item({ coalesced: true }))).toContain("follow-up in thread");
  expect(render(item())).not.toContain("follow-up in thread");
});

test("UrgentCard shows expired content, the draft label and Copy only for live text", () => {
  const html = render(item({ text: null, draft: { text: null, confidence: 0.4 } }));
  expect(html.match(/content expired/g)?.length).toBe(2);
  expect(html).toContain("Draft — not sent");
  expect(html).not.toContain("Copy");
  const live = render(item({ draft: { text: "thanks", confidence: 0.9 } }));
  expect(live).toContain("Copy");
});

const reply = (o: Partial<NonNullable<UrgentItemDto["reply"]>> = {}) => ({
  followupId: "f1",
  status: "awaiting_approval",
  approvalId: "a1",
  outgoingId: "o1",
  outgoingStatus: "pending",
  canRequest: false,
  actions: [] as ("mark_sent" | "resend" | "discard")[],
  ...o,
});
const withDraft = (o: Partial<UrgentItemDto> = {}) =>
  item({ draft: { text: "thanks <b>x</b>", confidence: 0.9 }, ...o });

test("UrgentCard shows an editable draft and the approval button only when no reply is pending", () => {
  const html = render(withDraft());
  expect(html).toContain("<textarea");
  expect(html).toContain('maxLength="4000"');
  expect(html).toContain("Send for approval");
  expect(html).toContain("Requires your approval");
  expect(html).toContain("thanks &lt;b&gt;x&lt;/b&gt;"); // text, never markup
  const pending = render(withDraft({ reply: reply() }));
  expect(pending).toContain("Awaiting approval");
  expect(pending).not.toContain("Send for approval");
  expect(pending).not.toContain("<textarea");
  // After a revoke the draft is editable again.
  const revoked = render(
    withDraft({ reply: reply({ status: "draft", outgoingStatus: "failed", canRequest: true }) }),
  );
  expect(revoked).toContain("Send for approval");
});

const outgoingCard = (i: UrgentItemDto) => {
  const card = buildNeedsYou({ ...emptyInput(), urgent: [i] }).find((c) => c.kind === "outgoing");
  if (card?.kind !== "outgoing") return null;
  return text(
    renderToString(<OutgoingAttentionCard out={card.data} now={NOW} onResolve={() => {}} />),
  );
};

test("urgent reply status lines and resolve choices come from the server", () => {
  const status = (outgoingStatus: string, actions: ("mark_sent" | "resend" | "discard")[] = []) =>
    withDraft({ reply: reply({ outgoingStatus, actions }) });
  expect(render(status("sending"))).toContain("Sending");
  expect(render(status("sent"))).toContain("Sent");
  expect(render(status("sent_unverified"))).toContain("Sent (unverified)");
  const naItem = status("needs_attention", ["mark_sent", "resend", "discard"]);
  expect(render(naItem)).toContain("Needs attention — check Slack");
  const na = outgoingCard(naItem) ?? "";
  expect(na).toContain("Needs attention — check Slack");
  for (const l of ["Mark sent", "Resend", "Discard"]) expect(na).toContain(l);
  // R15: a resend needs a new approval, and the button says so.
  expect(na).toContain("Requires your approval");
  expect(outgoingCard(status("needs_attention", ["mark_sent", "discard"]))).not.toContain(
    "Requires your approval",
  );
  const exhausted = outgoingCard(status("sent_unverified", ["mark_sent", "discard"])) ?? "";
  expect(exhausted).toContain("Mark sent");
  expect(exhausted).not.toContain("Resend");
  // A send with no resolve choices gets no outgoing card, and the urgent card has no resolve buttons.
  expect(outgoingCard(status("sent"))).toBeNull();
  expect(render(status("sent"))).not.toContain("Mark sent");
});

test("UrgentCard status buttons match allowedTransitions only", () => {
  const html = render(item());
  expect(html).toContain("Resolve");
  expect(html).toContain("Dismiss");
  expect(html).not.toContain("Acknowledge");
  expect(render(item({ allowedTransitions: [] }))).not.toContain("<button");
});

test("UrgentCard renders the link only when a permalink is present", () => {
  expect(render(item())).not.toContain("<a ");
  expect(render(item({ permalink: "https://x.slack.com/p1" }))).toContain("https://x.slack.com/p1");
});

// ---------------------------------------------------------------- approvals

const sendApproval = {
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
  createdAt: T,
  outgoing: {
    text: "ship <i>it</i>",
    recipientName: "Ada",
    conversationLabel: "a DM",
    threadReply: true,
  },
} as unknown as ApprovalView;

test("ApprovalCard shows the exact text, recipient and conversation of a send (H4)", () => {
  const html = text(
    renderToString(<ApprovalCard approval={sendApproval} now={NOW} onDecide={() => {}} />),
  );
  expect(html).toContain("APPROVAL · SLACK SEND");
  expect(html).toContain("ship &lt;i&gt;it&lt;/i&gt;");
  expect(html).toContain("<blockquote");
  expect(html).toContain("Ada");
  expect(html).toContain("a DM");
  expect(html).toContain("thread reply");
  expect(html).toContain("Approve");
  expect(html).toContain("Reject");
});

test("ApprovalCard names a non-send approval by its action and target", () => {
  const other = {
    ...sendApproval,
    action: "jira.write",
    targetIntegration: "jira",
    targetRef: "OPS-1",
    outgoing: undefined,
  } as unknown as ApprovalView;
  const html = text(
    renderToString(<ApprovalCard approval={other} now={NOW} onDecide={() => {}} />),
  );
  expect(html).toContain("APPROVAL · JIRA WRITE");
  expect(html).toContain("jira/OPS-1");
});

// ---------------------------------------------------------------- red flags

const group = (o: Partial<GroupedFlagsDto> = {}): GroupedFlagsDto => ({
  slackUserId: "U0LIN0001",
  name: "Linus",
  openCount: 2,
  maxSeverity: "warning",
  latest: {
    id: "fl1",
    excerpt: "please paste the <b>token</b>",
    detector: "credential_request",
    createdAt: T,
    permalink: null,
  },
  latestOpenId: "fl1",
  ...o,
});
const renderFlag = (
  g: GroupedFlagsDto,
  open = false,
  history: Record<string, import("../lib/api").SecurityFlagDto[]> = {},
  hidden = new Set<string>(),
) =>
  text(
    renderToString(
      <FlagCard
        group={g}
        now={NOW}
        open={open}
        history={history[g.slackUserId]}
        hidden={hidden}
        onToggle={() => {}}
        onReview={() => {}}
      />,
    ),
  );

test("FlagCard quotes the excerpt as untrusted text and offers the review choices", () => {
  const html = renderFlag(group());
  expect(html).toContain("RED FLAG · WARNING");
  expect(html).toMatch(/<blockquote[^>]*>please paste the &lt;b&gt;token&lt;\/b&gt;<\/blockquote>/);
  expect(html).toContain(
    "This text is marked untrusted and never reaches a worker that can send, edit or run anything.",
  );
  for (const l of ["Acknowledge", "Contacted", "Dismiss", "History ↗"]) expect(html).toContain(l);
  expect(html).toContain('aria-expanded="false"');
  expect(renderFlag(group({ latestOpenId: null }))).not.toContain("Acknowledge");
});

test("FlagCard History expands the person's history inline, with actions on open flags", () => {
  const history = {
    U0LIN0001: [
      {
        id: "fl1",
        severity: "warning" as const,
        status: "open" as const,
        detector: "d",
        excerpt: "newest",
        createdAt: T,
      },
      {
        id: "fl0",
        severity: "info" as const,
        status: "acknowledged" as const,
        detector: "d",
        excerpt: "older one",
        createdAt: T,
      },
    ],
  };
  const open = renderFlag(group(), true, history);
  expect(open).toContain('aria-expanded="true"');
  expect(open).toContain("older one");
  expect(open).toContain("acknowledged");
  // Open history rows get their own review buttons; reviewed ones don't.
  expect(open.match(/Acknowledge/g)?.length).toBe(2);
  // A history row pending undo is hidden.
  const hidden = renderFlag(group(), true, history, new Set(["flag:fl0"]));
  expect(hidden).not.toContain("older one");
});

// ---------------------------------------------------------------- follow-up drafts

const followup = (o: Partial<FollowupViewDto> = {}): FollowupViewDto => ({
  id: "f1",
  commitmentId: "c1",
  origin: "stalled",
  recipient: { id: "U0ADA0001", name: "Ada" },
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
  createdAt: T,
  updatedAt: T,
  ...o,
});
const renderDraft = (f: FollowupViewDto) =>
  text(renderToString(<FollowupCard f={f} now={NOW} onSend={() => {}} onDiscard={() => {}} />));

test("FollowupCard shows an editable draft with recipient, conversation and the approval label", () => {
  const html = renderDraft(followup());
  expect(html).toContain("FOLLOW-UP DRAFT");
  expect(html).toContain("<textarea");
  expect(html).toContain('maxLength="4000"');
  expect(html).toContain("Ada");
  expect(html).toContain("#ops");
  expect(html).toContain("Send for approval");
  expect(html).toContain("Requires your approval");
  expect(html).toContain("Discard");
  expect(html).toContain("any update &lt;i&gt;please&lt;/i&gt;?");
  expect(html).not.toContain("Posts as a new message");
  expect(renderDraft(followup({ noThread: true }))).toContain(
    "Posts as a new message (original expired)",
  );
});

test("FollowupCard shows its status as a chip", () => {
  expect(renderDraft(followup())).toMatch(/syn-chip--neutral[^"]*"[^>]*>draft</);
  expect(renderDraft(followup({ status: "awaiting_approval", actions: [] }))).toMatch(
    /syn-chip--neutral[^"]*"[^>]*>awaiting approval</,
  );
});

test("FollowupCard hides send controls without the send action and shows the server status", () => {
  const waiting = followup({
    status: "awaiting_approval",
    actions: [],
    outgoing: { id: "o1", status: "pending", failure: null },
  });
  const html = renderDraft(waiting);
  expect(html).toContain("Awaiting approval");
  expect(html).not.toContain("Send for approval");
  expect(html).not.toContain("<textarea");
  // Waiting on an approval is not a decision here: the approval card carries it.
  expect(buildNeedsYou({ ...emptyInput(), followups: [waiting] })).toEqual([]);
});

test("a follow-up send needing attention offers the server's resolve choices", () => {
  const card = (f: FollowupViewDto) => {
    const c = buildNeedsYou({ ...emptyInput(), followups: [f] })[0];
    if (c?.kind !== "outgoing") throw new Error("expected an outgoing card");
    return text(
      renderToString(<OutgoingAttentionCard out={c.data} now={NOW} onResolve={() => {}} />),
    );
  };
  const na = card(
    followup({
      status: "needs_attention",
      actions: [],
      outgoing: { id: "o1", status: "needs_attention", failure: "uncertain_outcome" },
      resolveActions: ["mark_sent", "resend", "discard"],
    }),
  );
  expect(na).toContain("Needs attention — check Slack");
  for (const l of ["Mark sent", "Resend", "Discard send"]) expect(na).toContain(l);
  expect(na).toContain("Ada");
  expect(na).toContain("any update &lt;i&gt;please&lt;/i&gt;?");
  const exhausted = card(
    followup({
      actions: [],
      outgoing: { id: "o1", status: "sent_unverified", failure: "unverified" },
      resolveActions: ["mark_sent", "discard"],
    }),
  );
  expect(exhausted).not.toContain("Resend");
});

// ---------------------------------------------------------------- commitments

const commitment = (o: Partial<CommitmentViewDto> = {}): CommitmentViewDto => ({
  id: "c1",
  description: "ship <b>report</b>",
  ownerSlackUserId: "U0ADA0001",
  ownerName: "Ada",
  counterpartySlackUserId: "U0GRA0001",
  counterpartyName: null,
  direction: "mine",
  status: "open",
  reviewStatus: "pending_review",
  dueAt: null,
  nextAction: null,
  completionEvidence: null,
  stalledAt: null,
  lastFollowupAt: null,
  closedAt: null,
  createdAt: T,
  updatedAt: T,
  sources: [],
  proposals: [],
  followups: [],
  actions: ["accept", "reject", "edit"],
  ...o,
});
const renderCommitment = (c: CommitmentViewDto, initiallyEditing = false) =>
  text(
    renderToString(
      <CommitmentReviewCard
        c={c}
        now={NOW}
        onTrack={() => {}}
        onReject={() => {}}
        initiallyEditing={initiallyEditing}
      />,
    ),
  );

test("CommitmentReviewCard offers Track it, Edit and Not a commitment; expired sources say so", () => {
  const html = renderCommitment(
    commitment({
      sources: [
        { sourceExternalRef: "C1:1", messageAvailable: false, permalink: null },
        { sourceExternalRef: "C1:2", messageAvailable: true, permalink: "https://x.slack.com/a" },
      ],
    }),
  );
  expect(html).toContain("POSSIBLE COMMITMENT");
  for (const l of ["Track it", "Edit", "Not a commitment"]) expect(html).toContain(l);
  expect(html).toContain("ship &lt;b&gt;report&lt;/b&gt;");
  expect(html).toContain("original message no longer available locally");
  expect(html).toContain('href="https://x.slack.com/a"');
  const editing = renderCommitment(commitment(), true);
  expect(editing).toContain('aria-label="Commitment description"');
  expect(editing).toContain('aria-label="Due date"');
  expect(editing).toContain("Track it with edits");
  expect(renderCommitment(commitment({ actions: ["accept"] }))).not.toContain("Not a commitment");
});

// ---------------------------------------------------------------- recommendations

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
  person: { slackUserId: "U0GRA0001", name: "Grace" },
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
  createdAt: T,
  ...o,
});
const renderRec = (r: RecommendationView) =>
  text(
    renderToString(
      <RecommendationCard
        r={r}
        now={NOW}
        onDecide={() => {}}
        onRetry={() => {}}
        onEvaluate={() => {}}
        onDismiss={() => {}}
        onDiscard={() => {}}
      />,
    ),
  );

test("RecommendationCard renders an update diff with added and removed observations", () => {
  const html = renderRec(
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
  );
  expect(html).toContain("update to version 2");
  expect(html).toContain("Likes async updates");
  expect(html).toContain("Prefers short messages");
  expect(html).toContain("line-through");
});

test("RecommendationCard shows expired evidence text, and a link only for an available permalink", () => {
  const one = (e: EvidenceView) =>
    renderRec(
      rec({
        proposed: [
          { section: "communication", key: "brief", text: "t", confidence: "low", evidence: [e] },
        ],
      }),
    );
  const expired = one(ev({ messageAvailable: false }));
  expect(expired).toContain("original message no longer available locally");
  expect(expired).not.toContain("<a ");
  const live = one(ev({ permalink: "https://x.slack.com/p1" }));
  expect(live).toContain('href="https://x.slack.com/p1"');
  expect(live).not.toContain("no longer available");
});

test("RecommendationCard renders text as text, never as HTML", () => {
  const html = renderRec(
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
  );
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;img");
});

test("RecommendationCard buttons follow the server's actions", () => {
  const both = renderRec(rec());
  expect(both).toContain("Approve");
  expect(both).toContain("Reject");
  expect(both).toContain("Reject reason");
  expect(both).not.toContain("Retry");
  expect(renderRec(rec({ actions: [] }))).not.toContain("<button");
  expect(renderRec(rec({ approvalId: null }))).not.toContain("Approve");
});

test("RecommendationCard shows Retry for a failed apply, and Evaluate for a suggestion", () => {
  const failed = renderRec(rec({ approvalStatus: "failed", actions: ["retry"] }));
  expect(failed).toContain("Apply failed — Retry");
  expect(failed).not.toContain("Approve");
  const suggestion = renderRec(
    rec({
      kind: "suggest_evaluation",
      proposed: null,
      approvalId: null,
      approvalStatus: null,
      actions: ["evaluate"],
      reason: "talks to you often",
    }),
  );
  expect(suggestion).toContain("Evaluate");
  expect(suggestion).toContain("talks to you often");
});

test("RecommendationCard renders Dismiss and Discard only when the actions include them", () => {
  const sug = rec({
    kind: "suggest_evaluation",
    proposed: null,
    approvalId: null,
    approvalStatus: null,
    reason: "r",
  });
  expect(renderRec({ ...sug, actions: ["evaluate", "dismiss"] })).toContain("Dismiss");
  expect(renderRec({ ...sug, actions: ["evaluate"] })).not.toContain("Dismiss");
  const stuck = renderRec(rec({ approvalStatus: "revoked", actions: ["discard"] }));
  expect(stuck).toContain("Discard");
  expect(stuck).not.toContain("Approve");
  expect(renderRec(rec({ approvalStatus: "failed", actions: ["retry", "discard"] }))).toContain(
    "Discard",
  );
  expect(renderRec(rec({ approvalStatus: "failed", actions: ["retry"] }))).not.toContain("Discard");
});

// ---------------------------------------------------------------- setup cards

const person = (slackUserId: string, name: string | null): PersonDto => ({
  slackUserId,
  name,
  rationale: null,
  priority: "normal",
  extraAttention: false,
});

test("IdentitySetupCard confirms the suggestion, and explains why alerts are paused", () => {
  const html = text(
    renderToString(
      <IdentitySetupCard
        identity={{ selfUserId: null, suggestion: "U0ADA0001", suggestionName: "Ada" }}
        people={[]}
        onConfirm={() => {}}
      />,
    ),
  );
  expect(html).toContain("Ada (U0ADA0001)");
  expect(html).toContain("Confirm");
  expect(html).toContain("notifications and suggested replies are paused");
  expect(html).not.toContain("<select");
});

test("IdentitySetupCard offers a manual pick from people when there is no suggestion (R18)", () => {
  const html = text(
    renderToString(
      <IdentitySetupCard
        identity={{ selfUserId: null, suggestion: null, suggestionName: null }}
        people={[person("U0ADA0001", "Ada"), person("U0GRA0001", null)]}
        onConfirm={() => {}}
      />,
    ),
  );
  expect(html).toContain("<select");
  expect(html).toContain("Ada (U0ADA0001)");
  expect(html).toContain("U0GRA0001");
  expect(html).toContain("Confirm");
});

test("PeopleSetupCard lists the people ready to evaluate", () => {
  const c = (id: string, name: string) => ({
    slackUserId: id,
    name,
    score: 50,
    messageCount: 9,
    hasProfile: false,
    hasPendingRecommendation: false,
    isTemporary: false,
    actions: ["evaluate" as const],
  });
  const html = text(
    renderToString(
      <PeopleSetupCard
        candidates={[c("U0GRA0001", "Grace"), c("U0LIN0001", "Linus")]}
        onEvaluate={() => {}}
        onSeeAll={() => {}}
      />,
    ),
  );
  expect(html).toContain("PEOPLE MEMORY · SETUP");
  expect(html).toContain("Grace");
  expect(html).toContain("Linus");
  expect(html.match(/>Evaluate</g)?.length).toBe(2);
});

test("PeopleSetupCard shows people queued this session as Queued, without Evaluate", () => {
  const c = (id: string, name: string) => ({
    slackUserId: id,
    name,
    score: 50,
    messageCount: 9,
    hasProfile: false,
    hasPendingRecommendation: false,
    isTemporary: false,
    actions: ["evaluate" as const],
  });
  const html = text(
    renderToString(
      <PeopleSetupCard
        candidates={[c("U0GRA0001", "Grace"), c("U0LIN0001", "Linus")]}
        queued={new Set(["U0GRA0001"])}
        onEvaluate={() => {}}
        onSeeAll={() => {}}
      />,
    ),
  );
  expect(html.match(/>Evaluate</g)?.length).toBe(1);
  expect(html.match(/>Queued</g)?.length).toBe(1);
  expect(html.indexOf("Grace")).toBeLessThan(html.indexOf("Queued"));
  expect(html.indexOf("Queued")).toBeLessThan(html.indexOf("Linus"));
});

const backfill = (o: Partial<SlackStatusDto["backfill"]> = {}): SlackStatusDto["backfill"] => ({
  stream: "slack.backfill",
  checkpoint: null,
  upperBound: null,
  status: "idle",
  pagesDone: 0,
  lastSuccessAt: null,
  lastError: null,
  nextRunAfter: null,
  resumable: false,
  ...o,
});
const renderBackfill = (
  b: SlackStatusDto["backfill"],
  sevenDay: number | null = 0.42,
  initiallyConfirming = false,
) =>
  text(
    renderToString(
      <BackfillSetupCard
        backfill={b}
        sevenDay={sevenDay}
        onStart={() => {}}
        initiallyConfirming={initiallyConfirming}
      />,
    ),
  );

test("BackfillSetupCard has two steps: Start backfill…, then a confirm panel with the 7-day usage", () => {
  const first = renderBackfill(backfill());
  expect(first).toContain("SLACK · SETUP");
  expect(first).toContain("Start backfill…");
  expect(first).not.toContain("Start now");
  const confirm = renderBackfill(backfill(), 0.42, true);
  expect(confirm).toContain("7-day usage is at 42%");
  expect(confirm).toContain("Start now");
  expect(confirm).toContain("Cancel");
  expect(renderBackfill(backfill(), null, true)).toContain("7-day usage isn&#x27;t known yet");
});

test("BackfillSetupCard shows only backend facts: state, pages done and resumable (D12)", () => {
  const running = renderBackfill(backfill({ status: "running", pagesDone: 3 }));
  expect(running).toContain("3 pages done");
  expect(running).not.toContain("<button");
  const resumable = renderBackfill(backfill({ status: "running", pagesDone: 3, resumable: true }));
  expect(resumable).toContain("Resume backfill…");
  const failed = renderBackfill(
    backfill({ status: "error", lastError: { kind: "parse_failed", message: "m" } }),
  );
  expect(failed).toContain("Resume backfill…");
  expect(failed).toContain("parse_failed");
});

// ---------------------------------------------------------------- feed, header, all clear

function emptyInput(): NeedsYouInput {
  return {
    urgent: [],
    approvals: [],
    flags: [],
    followups: [],
    reviewQueue: [],
    recommendations: [],
    identity: { selfUserId: "U0ADA0001", suggestion: null, suggestionName: null },
    people: [],
    candidates: { identityRequired: false, candidates: [] },
    slackStatus: null,
    hidden: new Set(),
  };
}

const noop = () => {};
const handlers: NeedsYouHandlers = {
  urgentStatus: noop,
  urgentReply: noop,
  resolve: noop,
  decide: noop,
  reviewFlag: noop,
  toggleHistory: noop,
  sendFollowup: noop,
  discardFollowup: noop,
  trackCommitment: noop,
  rejectCommitment: noop,
  recDecide: noop,
  recDismiss: noop,
  recDiscard: noop,
  recRetry: noop,
  recEvaluate: noop,
  confirmIdentity: noop,
  evaluatePerson: noop,
  seeAllPeople: noop,
  syncJira: noop,
  enableJira: noop,
  seeAllJira: noop,
  startBackfill: noop,
  dismissAwayDigest: noop,
  setAway: noop,
};
const feed = (input: NeedsYouInput) =>
  text(
    renderToString(
      <NeedsYou
        cards={buildNeedsYou(input)}
        allClear={allClearRows(input)}
        now={NOW}
        handlers={handlers}
        expanded={[]}
        history={{}}
        hidden={input.hidden}
        sevenDay={null}
        onCopy={noop}
      />,
    ),
  );

test("NeedsYou has the section header with a count chip and subtitle, cards in order", () => {
  const html = feed({
    ...emptyInput(),
    urgent: [item({ level: "critical" })],
    approvals: [sendApproval],
    flags: [group()],
  });
  expect(html).toContain("<h2");
  expect(html).toContain("Needs you");
  expect(html).toMatch(/syn-chip[^"]*"[^>]*>3</);
  // A running backfill renders as status but isn't counted.
  const running = feed({
    ...emptyInput(),
    urgent: [item()],
    slackStatus: {
      incremental: { ...backfill(), stream: "slack.messages" },
      backfill: backfill({ status: "running", pagesDone: 2 }),
      searchesToday: 0,
    },
  });
  expect(running).toContain("SLACK · SETUP");
  expect(running).toMatch(/syn-chip[^"]*"[^>]*>1</);
  expect(html).toContain("Decisions only you can make. Ordered by impact.");
  const at = (s: string) => html.indexOf(s);
  expect(at("URGENT · CRITICAL")).toBeLessThan(at("APPROVAL · SLACK SEND"));
  expect(at("APPROVAL · SLACK SEND")).toBeLessThan(at("RED FLAG · WARNING"));
  // Approvals, urgent and flags have cards: only Profile suggestions is all clear.
  expect(html).toContain("Profile suggestions");
  expect(html).not.toContain("Urgent inbox");
});

test("NeedsYou shows a running-backfill card even when it is the only card (count 0)", () => {
  const html = feed({
    ...emptyInput(),
    slackStatus: {
      incremental: { ...backfill(), stream: "slack.messages" },
      backfill: backfill({ status: "running", pagesDone: 2 }),
      searchesToday: 0,
    },
  });
  expect(html).toMatch(/syn-chip[^"]*"[^>]*>0</);
  expect(html).toContain("SLACK · SETUP");
  expect(html).toContain("2 pages done");
});

test("NeedsYou shows no identity card once selfUserId is set", () => {
  const unset = { selfUserId: null, suggestion: "U0ADA0001", suggestionName: "Ada" };
  expect(feed({ ...emptyInput(), identity: unset })).toContain("Confirm");
  expect(feed({ ...emptyInput(), identity: { ...unset, selfUserId: "U0ADA0001" } })).not.toContain(
    "Confirm",
  );
});

test("AllClear renders a ✓ row for each empty category", () => {
  const html = text(renderToString(<AllClear rows={allClearRows(emptyInput())} />));
  expect(html.match(/✓/g)?.length).toBe(4);
  for (const l of ["Urgent inbox", "Pending approvals", "Profile suggestions", "Red flags"]) {
    expect(html).toContain(l);
  }
  expect(html).toContain("nothing urgent");
  expect(renderToString(<AllClear rows={[]} />)).toBe("");
});
