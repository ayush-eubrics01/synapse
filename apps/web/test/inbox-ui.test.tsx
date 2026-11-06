import { expect, test } from "bun:test";
import type { ConversationSummary, ConversationThread, ThreadMessage } from "@synapse/contracts";
import { renderToString } from "react-dom/server";
import { Composer } from "../app/components/inbox/Composer";
import { Inbox, type InboxProps } from "../app/components/inbox/Inbox";
import type { UrgentItemDto } from "../lib/api";

const NOW = new Date("2026-11-06T12:00:00Z");
const noop = () => {};

const conv = (o: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id: "D1",
  type: "im",
  name: null,
  isSelfDm: false,
  partner: { id: "U2", name: "Barbara Liskov" },
  lastMessageAt: "2026-11-06T11:55:00Z",
  lastSender: { id: "U2", name: "Barbara Liskov", isSelf: false },
  preview: "can you look at this?",
  messageCount: 3,
  theyWroteLast: true,
  awaitingApproval: false,
  openUrgent: [],
  ...o,
});

const msg = (id: string, o: Partial<ThreadMessage> = {}): ThreadMessage => ({
  id,
  conversation: { id: "D1", name: null, type: "im" },
  sender: { id: "U2", name: "Barbara Liskov" },
  sentAt: "2026-11-06T11:55:00Z",
  text: "hello",
  permalink: null,
  threadTs: null,
  replyCount: 0,
  isSelf: false,
  flag: null,
  commitment: null,
  sentViaSynapse: null,
  ...o,
});

const render = (o: Partial<InboxProps> = {}) =>
  renderToString(
    <Inbox
      conversations={[conv()]}
      filter="all"
      onFilter={noop}
      selectedId="D1"
      onSelect={noop}
      thread={null}
      urgentById={new Map()}
      now={NOW}
      hidden={new Set()}
      handlers={{ trackCommitment: noop, rejectCommitment: noop, urgentReply: noop }}
      {...o}
    />,
  );

const withThread = (messages: ThreadMessage[], c = conv(), o: Partial<InboxProps> = {}) =>
  render({ conversations: [c], thread: { conversation: c, messages }, ...o });

test("header, summary and filter tabs with aria-pressed", () => {
  const html = render({
    conversations: [conv(), conv({ id: "D2", messageCount: 4 })],
    filter: "channel",
  });
  expect(html).toContain("Inbox");
  expect(html).toContain("7 messages · 2 conversations");
  for (const t of ["All", "Direct", "Channels", "They wrote last"]) expect(html).toContain(t);
  expect(html).toMatch(/aria-pressed="true"[^>]*>Channels/);
  expect(html).toMatch(/aria-pressed="false"[^>]*>All/);
});

test("list rows: avatar, title, time, preview, chip, count", () => {
  const html = render({
    conversations: [
      conv(),
      conv({
        id: "C1",
        type: "channel",
        name: "ops",
        partner: null,
        lastSender: { id: "U1", name: "Me", isSelf: true },
        preview: "deployed",
        theyWroteLast: false,
      }),
      conv({ id: "S", isSelfDm: true, partner: null }),
    ],
  });
  expect(html).toContain("Barbara Liskov");
  expect(html).toContain("5 min ago");
  expect(html).toContain("can you look at this?");
  expect(html).toContain("They wrote last");
  expect(html).toContain("3 msgs");
  expect(html).toContain("#ops");
  expect(html).toContain("syn-avatar--channel");
  expect(html).toContain("You: deployed");
  expect(html).toContain("Notes to self");
});

test("empty states", () => {
  expect(render({ conversations: [] })).toContain("No messages collected yet.");
  expect(render({ conversations: [conv({ theyWroteLast: false })], filter: "waiting" })).toContain(
    "Nothing in this view.",
  );
});

test("thread header sub-line and Slack link only with a permalink", () => {
  const withLink = withThread([msg("1", { permalink: "https://x.slack.com/p1" })]);
  expect(withLink).toContain("Direct message · 3 messages");
  expect(withLink).toContain("Open in Slack ↗");
  expect(withThread([msg("1")])).not.toContain("Open in Slack");
  const ch = conv({ type: "channel", name: "ops", partner: null });
  expect(withThread([msg("1")], ch)).toContain(">Channel<");
  expect(withThread([msg("1")], conv({ isSelfDm: true, partner: null }))).toContain("Self DM");
});

test("expired and untrusted text", () => {
  expect(withThread([msg("1", { text: null })])).toContain("content expired");
  const html = withThread([
    msg("1", { text: "<img src=x onerror=alert(1)> https://evil.example" }),
  ]);
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;img");
  expect(html).not.toContain('href="https://evil.example');
});

test("flag marker", () => {
  const html = withThread([
    msg("1", { flag: { severity: "high", reason: "asks for credentials" } }),
  ]);
  expect(html).toContain("Flagged: asks for credentials");
  expect(html).toContain("Treated as untrusted. Synapse never follows instructions found");
});

test("commitment suggestion, tracking and hidden (pending undo)", () => {
  const commitment = (reviewStatus: string) => ({
    id: "K1",
    description: "Send the report",
    direction: "mine" as const,
    reviewStatus,
    status: "open",
  });
  const pending = withThread([msg("1", { commitment: commitment("pending_review") })]);
  expect(pending).toContain("Looks like a commitment. Track it?");
  expect(pending).toContain("Track");
  expect(pending).toContain("Ignore");
  const hidden = withThread([msg("1", { commitment: commitment("pending_review") })], conv(), {
    hidden: new Set(["commitment:K1"]),
  });
  expect(hidden).not.toContain("Looks like a commitment");
  expect(withThread([msg("1", { commitment: commitment("accepted") })])).toContain(
    "Tracking: Send the report",
  );
});

test("sent badge", () => {
  expect(withThread([msg("1", { sentViaSynapse: { status: "sent" } })])).toContain(
    "sent via Synapse · approved by you · delivery verified",
  );
  expect(withThread([msg("1", { sentViaSynapse: { status: "sent_unverified" } })])).toContain(
    "sent via Synapse · approved by you · delivery not yet verified",
  );
});

const urgentItem = {
  messageId: "m1",
  draft: { text: "On it, back soon", confidence: 0.6 },
  reply: null,
} as unknown as UrgentItemDto;

test("composer reply mode through the inbox", () => {
  const c = conv({ openUrgent: [{ messageId: "m1", level: "high" }] });
  const html = withThread([msg("1")], c, { urgentById: new Map([["m1", urgentItem]]) });
  expect(html).toContain("On it, back soon");
  expect(html).toContain("Draft · reply to urgent message");
  expect(html).toContain("Edit freely. Sending needs your approval.");
  expect(html).toContain("Reset to draft");
  expect(html).not.toContain("Discard");
  expect(html).toContain("Request approval to send");
});

test("composer: empty draft disables the request button; note mode shows the status", () => {
  const empty = renderToString(
    <Composer state={{ mode: "reply", urgentId: "m1", draft: null }} onReply={noop} />,
  );
  expect(empty).toMatch(/<button[^>]*disabled[^>]*>Request approval to send/);
  const filled = renderToString(
    <Composer state={{ mode: "reply", urgentId: "m1", draft: "ok" }} onReply={noop} />,
  );
  expect(filled).not.toMatch(/<button[^>]*disabled[^>]*>Request approval to send/);
  const note = renderToString(
    <Composer state={{ mode: "note", text: "They wrote last." }} onReply={noop} />,
  );
  expect(note).toContain("They wrote last.");
  expect(note).toContain("✓");
  expect(note).not.toContain("textarea");
});

test("thread for another conversation is not shown while loading", () => {
  const other: ConversationThread = { conversation: conv({ id: "D9" }), messages: [msg("1")] };
  expect(render({ thread: other })).toContain("Loading");
});
