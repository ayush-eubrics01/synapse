import { expect, test } from "bun:test";
import type { ConversationSummary, ThreadMessage } from "@synapse/contracts";
import type { UrgentItemDto } from "../lib/api";
import {
  composerState,
  conversationChip,
  conversationSub,
  conversationTitle,
  filterConversations,
  groupThread,
  inboxSummary,
} from "../lib/inbox";

const conv = (o: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id: "D1",
  type: "im",
  name: null,
  isSelfDm: false,
  partner: { id: "U2", name: "Barbara Liskov" },
  lastMessageAt: "2026-11-06T10:00:00Z",
  lastSender: { id: "U2", name: "Barbara Liskov", isSelf: false },
  preview: "hi",
  messageCount: 3,
  theyWroteLast: false,
  awaitingApproval: false,
  openUrgent: [],
  ...o,
});

test("filterConversations", () => {
  const dm = conv({ id: "a" });
  const group = conv({ id: "b", type: "mpim" });
  const self = conv({ id: "c", isSelfDm: true, partner: null });
  const ch = conv({ id: "d", type: "channel", name: "ops", partner: null, theyWroteLast: true });
  const all = [dm, group, self, ch];
  const ids = (f: Parameters<typeof filterConversations>[1]) =>
    filterConversations(all, f).map((c) => c.id);
  expect(ids("all")).toEqual(["a", "b", "c", "d"]);
  expect(ids("dm")).toEqual(["a", "b", "c"]);
  expect(ids("channel")).toEqual(["d"]);
  expect(ids("waiting")).toEqual(["d"]);
});

test("conversationChip precedence", () => {
  const urgent = [{ messageId: "m", level: "high" }];
  expect(conversationChip(conv({ awaitingApproval: true, openUrgent: urgent }))).toEqual({
    label: "Awaiting approval",
    tone: "blue",
  });
  expect(conversationChip(conv({ openUrgent: urgent, type: "channel" }))).toEqual({
    label: "Urgent",
    tone: "red",
  });
  expect(conversationChip(conv({ type: "channel", theyWroteLast: true })).label).toBe("Channel");
  expect(conversationChip(conv({ isSelfDm: true, theyWroteLast: true })).label).toBe("Notes");
  expect(conversationChip(conv({ theyWroteLast: true })).label).toBe("They wrote last");
  expect(conversationChip(conv())).toEqual({ label: "You replied", tone: "neutral" });
});

test("titles, sub-lines and summary", () => {
  expect(conversationTitle(conv())).toBe("Barbara Liskov");
  expect(conversationTitle(conv({ type: "channel", name: "ops", partner: null }))).toBe("#ops");
  expect(conversationTitle(conv({ isSelfDm: true, partner: null }))).toBe("Notes to self");
  // A partner-less DM that isn't the self DM: its name, else "Direct message" (never the raw id).
  expect(conversationTitle(conv({ partner: null, name: "invented-dm" }))).toBe("invented-dm");
  expect(conversationTitle(conv({ partner: null, name: null }))).toBe("Direct message");
  expect(conversationSub(conv({ messageCount: 4 }))).toBe("Direct message · 4 messages");
  expect(conversationSub(conv({ type: "channel" }))).toBe("Channel");
  expect(conversationSub(conv({ isSelfDm: true }))).toBe("Self DM");
  expect(inboxSummary([conv({ messageCount: 3 }), conv({ messageCount: 4 })])).toBe(
    "7 messages · 2 conversations",
  );
});

const local = (d: number, h: number, m: number) => new Date(2026, 10, d, h, m).toISOString();
const msg = (id: string, sender: string, sentAt: string): ThreadMessage => ({
  id,
  conversation: { id: "D1", name: null, type: "im" },
  sender: { id: sender, name: sender },
  sentAt,
  text: "x",
  permalink: null,
  threadTs: null,
  replyCount: 0,
  isSelf: false,
  flag: null,
  commitment: null,
  sentViaSynapse: null,
  codeAnswerCount: 0,
});

test("groupThread: day separators across midnight", () => {
  const now = new Date(2026, 10, 6, 12, 0);
  const g = groupThread(
    [msg("1", "U", local(5, 23, 58)), msg("2", "U", local(6, 0, 1)), msg("3", "U", local(6, 0, 2))],
    now,
  );
  expect(g.map((x) => x.daySep)).toEqual(["Yesterday", "Today", null]);
  expect(g.map((x) => x.showHead)).toEqual([true, true, false]);
});

test("groupThread: head after 6 min gap, none at 4 min, and on sender change", () => {
  const now = new Date(2026, 10, 6, 12, 0);
  const g = groupThread(
    [
      msg("1", "A", local(6, 10, 0)),
      msg("2", "A", local(6, 10, 4)),
      msg("3", "A", local(6, 10, 10)),
      msg("4", "B", local(6, 10, 11)),
    ],
    now,
  );
  expect(g.map((x) => x.showHead)).toEqual([true, false, true, true]);
  expect(g.map((x) => x.daySep)).toEqual(["Today", null, null, null]);
});

const urgentItem = (draft: string | null, canRequest = true): UrgentItemDto =>
  ({
    messageId: "m1",
    draft: draft === null ? null : { text: draft, confidence: 0.5 },
    reply: canRequest ? null : { canRequest: false },
  }) as unknown as UrgentItemDto;

test("composerState: reply mode uses the first open urgent item's draft", () => {
  const c = conv({
    openUrgent: [
      { messageId: "m1", level: "high" },
      { messageId: "m2", level: "high" },
    ],
  });
  expect(composerState(c, new Map([["m1", urgentItem("On it")]]))).toEqual({
    mode: "reply",
    urgentId: "m1",
    draft: "On it",
  });
  expect(composerState(c, new Map())).toEqual({ mode: "reply", urgentId: "m1", draft: null });
});

test("composerState: a live send blocks reply mode (failure path)", () => {
  const c = conv({ awaitingApproval: true, openUrgent: [{ messageId: "m1", level: "high" }] });
  const s = composerState(c, new Map([["m1", urgentItem("x", false)]]));
  expect(s).toEqual({ mode: "note", text: "Reply is waiting for your approval in Needs you." });
});

test("composerState: note texts", () => {
  const none = new Map<string, UrgentItemDto>();
  const text = (c: ConversationSummary) => {
    const s = composerState(c, none);
    return s.mode === "note" ? s.text : "reply";
  };
  expect(text(conv({ awaitingApproval: true }))).toBe(
    "Reply is waiting for your approval in Needs you.",
  );
  expect(text(conv({ isSelfDm: true, theyWroteLast: true }))).toBe("Your own notes. Not screened.");
  expect(text(conv({ theyWroteLast: true }))).toBe("They wrote last.");
  expect(text(conv())).toBe("You replied last. Nothing waiting.");
});
