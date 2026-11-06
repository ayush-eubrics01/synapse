import { expect, test } from "bun:test";
import type {
  CodeAnswerView,
  ConversationSummary,
  ConversationThread,
  ThreadMessage,
} from "@synapse/contracts";
import { renderToString } from "react-dom/server";
import { CodeAnswerPanel } from "../app/components/inbox/CodeAnswerPanel";
import { Composer } from "../app/components/inbox/Composer";
import { Inbox, type InboxProps } from "../app/components/inbox/Inbox";
import {
  canUseAsReply,
  codeAnswerStatusText,
  formatEvidence,
  preselectRepository,
} from "../lib/code-answers";
import { repo } from "./brain-fixtures";

const noop = () => {};

const view = (o: Partial<CodeAnswerView> = {}): CodeAnswerView => ({
  id: "ca1",
  messageId: "m1",
  repositoryId: "r1",
  repositoryName: "demo-app",
  trigger: "user",
  status: "ready",
  answer: "Config is loaded in the start function.",
  confidence: 0.82,
  evidence: [{ path: "src/a.ts", line: 12 }],
  droppedEvidenceCount: 0,
  notAnswerableReason: null,
  failure: null,
  suspectedInjection: null,
  outgoingId: null,
  outgoingStatus: null,
  createdAt: "2026-11-06T10:00:00.000Z",
  updatedAt: "2026-11-06T10:00:00.000Z",
  ...o,
});

const panel = (o: Partial<Parameters<typeof CodeAnswerPanel>[0]> = {}) =>
  renderToString(
    <CodeAnswerPanel
      messageId="m1"
      count={1}
      repositories={[repo({ id: "r1", name: "demo-app" })]}
      tick={{ n: 0, messageId: null }}
      onUseAsReply={noop}
      initialViews={[view()]}
      {...o}
    />,
  );

test("pure helpers", () => {
  expect(preselectRepository([repo({ id: "r1" })])).toBe("r1");
  expect(preselectRepository([repo({ id: "r1" }), repo({ id: "r2" })])).toBeNull();
  expect(preselectRepository([])).toBeNull();
  expect(formatEvidence({ path: "src/a.ts", line: 12 })).toBe("src/a.ts:12");
  expect(formatEvidence({ path: "src/a.ts" })).toBe("src/a.ts");
  expect(canUseAsReply(view(), false)).toBe(true);
  expect(canUseAsReply(view({ status: "held" }), false)).toBe(true);
  expect(canUseAsReply(view({ status: "failed", answer: null }), false)).toBe(false);
  expect(canUseAsReply(view({ status: "sent" }), true)).toBe(false);
  const bad = view({ suspectedInjection: { detected: true, severity: "high", reason: "x" } });
  expect(canUseAsReply(bad, false)).toBe(false);
  expect(canUseAsReply(bad, true)).toBe(true);
  expect(codeAnswerStatusText(view({ status: "failed", failure: "run_failed" }))).toBe(
    "Failed: run_failed",
  );
});

test("the panel offers 'Answer from code…' with the only repository preselected", () => {
  const html = panel({ initialViews: [], count: 0 });
  expect(html).toContain("Answer from code…");
  expect(html).toMatch(/<option value="r1" selected="">demo-app<\/option>/);
  const two = panel({
    initialViews: [],
    count: 0,
    repositories: [repo({ id: "r1" }), repo({ id: "r2", name: "demo-api" })],
  });
  expect(two).toContain("Choose repository");
  expect(two).toMatch(/<option value="" selected="">/);
  expect(two).toMatch(/<button[^>]*disabled=""[^>]*>Answer from code…/);
  expect(panel({ repositories: [], initialViews: [], count: 0 })).toBe("");
});

test("a ready answer shows text, confidence and evidence as plain path:line", () => {
  const html = panel();
  expect(html).toContain("Config is loaded in the start function.");
  expect(html).toContain("confidence 0.82");
  expect(html).toContain("<li>src/a.ts:12</li>");
  expect(html).not.toContain("<a ");
  expect(html).toContain("Use as reply");
  expect(html).toContain("Dismiss");
  expect(html).toMatch(/<button[^>]*>Use as reply/);
  expect(html).not.toMatch(/disabled=""[^>]*>Use as reply/);
});

test("answer text renders escaped, never as HTML", () => {
  const html = panel({
    initialViews: [
      view({ answer: "<script>alert(1)</script>", evidence: [{ path: "<b>x</b>.ts" }] }),
    ],
  });
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(html).not.toContain("<b>x</b>");
});

test("not_answerable, unverified and failed show their reason and no 'Use as reply'", () => {
  for (const [v, text] of [
    [
      view({ status: "not_answerable", answer: null, notAnswerableReason: "Not in this repo" }),
      "Not in this repo",
    ],
    [
      view({ status: "unverified", answer: null, failure: "evidence_unverified" }),
      "No verified evidence",
    ],
    [view({ status: "failed", answer: null, failure: "run_failed" }), "Failed: run_failed"],
  ] as const) {
    const html = panel({ initialViews: [v] });
    expect(html).toContain(text);
    expect(html).not.toContain("Use as reply");
    expect(html).toContain("Dismiss");
  }
});

test("queued and running rows show a status and no actions", () => {
  const html = panel({
    initialViews: [view({ status: "running", answer: null, confidence: null, evidence: [] })],
  });
  expect(html).toContain("Reading the code…");
  expect(html).not.toContain("Dismiss");
});

test("dismissed rows are hidden", () => {
  expect(panel({ initialViews: [view({ status: "dismissed" })] })).not.toContain(
    "Config is loaded",
  );
});

test("a suspected injection shows the red-flag banner and a disabled 'Use as reply' until 'Use anyway'", () => {
  const bad = view({
    suspectedInjection: { detected: true, severity: "high", reason: "asks to reveal secrets" },
  });
  const html = panel({ initialViews: [bad] });
  expect(html).toContain("syn-msg-flag--high");
  expect(html).toContain("Suspected injection: asks to reveal secrets");
  expect(html).toContain("Use anyway");
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Use as reply/);
  const acked = panel({ initialViews: [bad], initialAcknowledged: ["ca1"] });
  expect(acked).not.toContain("Use anyway");
  expect(acked).not.toMatch(/disabled=""[^>]*>Use as reply/);
  expect(acked).toContain("Suspected injection");
});

// The composer switch: the thread view's Inbox swaps in the code-answer draft.
const conv = (): ConversationSummary => ({
  id: "D1",
  type: "im",
  name: null,
  isSelfDm: false,
  partner: { id: "U2", name: "Pat Demo" },
  lastMessageAt: "2026-11-06T11:55:00Z",
  lastSender: { id: "U2", name: "Pat Demo", isSelf: false },
  preview: "where?",
  messageCount: 1,
  theyWroteLast: true,
  awaitingApproval: false,
  openUrgent: [],
});
const message = (o: Partial<ThreadMessage> = {}): ThreadMessage => ({
  id: "m1",
  conversation: { id: "D1", name: null, type: "im" },
  sender: { id: "U2", name: "Pat Demo" },
  sentAt: "2026-11-06T11:55:00Z",
  text: "where is config loaded?",
  permalink: null,
  threadTs: null,
  replyCount: 0,
  isSelf: false,
  flag: null,
  commitment: null,
  sentViaSynapse: null,
  codeAnswerCount: 0,
  ...o,
});
const inbox = (draft: NonNullable<InboxProps["codeAnswers"]>["draft"]) => {
  const thread: ConversationThread = { conversation: conv(), messages: [message()] };
  return renderToString(
    <Inbox
      conversations={[conv()]}
      filter="all"
      onFilter={noop}
      selectedId="D1"
      onSelect={noop}
      thread={thread}
      urgentById={new Map()}
      now={new Date("2026-11-06T12:00:00Z")}
      hidden={new Set()}
      handlers={{ trackCommitment: noop, rejectCommitment: noop, urgentReply: noop }}
      codeAnswers={{
        repositories: [repo({ id: "r1" })],
        tick: { n: 0, messageId: null },
        onDismissed: noop,
        draft,
        onUseAsReply: noop,
        onSend: noop,
        onDiscard: noop,
      }}
    />,
  );
};

test("the thread offers 'Answer from code…' and the composer follows the chosen answer", () => {
  const plain = inbox(null);
  expect(plain).toContain("Answer from code…");
  expect(plain).toContain("They wrote last.");
  const withDraft = inbox({ codeAnswerId: "ca1", draft: "Draft <b>text</b>", useAnyway: false });
  expect(withDraft).toContain("Draft · answer from code");
  expect(withDraft).toContain("Draft &lt;b&gt;text&lt;/b&gt;");
  expect(withDraft).toContain("Request approval to send");
  expect(withDraft).not.toContain("They wrote last.");
});

test("the code-answer composer without a send handler cannot request approval", () => {
  const html = renderToString(
    <Composer state={{ mode: "code_answer", codeAnswerId: "ca1", draft: "x" }} onReply={noop} />,
  );
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Request approval to send/);
});

test("event message id parsing and readable send errors", async () => {
  const { codeAnswerEventMessageId, codeAnswerErrorText } = await import("../lib/code-answers");
  const { ApiError } = await import("../lib/api");
  expect(codeAnswerEventMessageId(JSON.stringify({ payload: { messageId: "m1" } }))).toBe("m1");
  expect(codeAnswerEventMessageId(JSON.stringify({ messageId: "m2" }))).toBe("m2");
  expect(codeAnswerEventMessageId("not json")).toBeNull();
  expect(codeAnswerEventMessageId("{}")).toBeNull();
  const text = codeAnswerErrorText(
    new ApiError("POST /x failed with 409", 409, "invalid_state"),
    "x",
  );
  expect(text).not.toContain("POST");
  expect(codeAnswerErrorText(new Error("boom"), "fallback")).toBe("fallback");
});

test("duplicate evidence entries render without key collisions", () => {
  const html = panel({
    initialViews: [
      view({
        evidence: [
          { path: "a.ts", line: 1 },
          { path: "a.ts", line: 1 },
        ],
      }),
    ],
  });
  expect(html.match(/<li>a\.ts:1<\/li>/g)).toHaveLength(2);
});
