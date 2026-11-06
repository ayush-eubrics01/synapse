import type { ConversationSummary, ThreadMessage } from "@synapse/contracts";
import type { UrgentItemDto } from "./api";
import { dayLabel } from "./format";

export type InboxFilter = "all" | "dm" | "channel" | "waiting";
type ChipTone = "neutral" | "red" | "amber" | "green" | "blue";

export const INBOX_FILTERS: ReadonlyArray<{ value: InboxFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "dm", label: "Direct" },
  { value: "channel", label: "Channels" },
  { value: "waiting", label: "They wrote last" },
];

/** `dm` covers im, mpim and the self DM; `channel` covers channels; `waiting` covers theyWroteLast. */
export function filterConversations(
  list: ConversationSummary[],
  f: InboxFilter,
): ConversationSummary[] {
  switch (f) {
    case "all":
      return list;
    case "dm":
      return list.filter((c) => c.type !== "channel");
    case "channel":
      return list.filter((c) => c.type === "channel");
    case "waiting":
      return list.filter((c) => c.theyWroteLast);
  }
}

export function conversationChip(c: ConversationSummary): { label: string; tone: ChipTone } {
  if (c.awaitingApproval) return { label: "Awaiting approval", tone: "blue" };
  if (c.openUrgent.length > 0) return { label: "Urgent", tone: "red" };
  if (c.type === "channel") return { label: "Channel", tone: "neutral" };
  if (c.isSelfDm) return { label: "Notes", tone: "neutral" };
  if (c.theyWroteLast) return { label: "They wrote last", tone: "amber" };
  return { label: "You replied", tone: "neutral" };
}

export function conversationTitle(c: ConversationSummary): string {
  if (c.isSelfDm) return "Notes to self";
  if (c.type === "channel") return `#${c.name ?? c.id}`;
  // A partner-less DM that isn't the self DM (e.g. one I started, no reply yet): never the raw id.
  if (c.type === "im") return c.partner?.name ?? c.name ?? "Direct message";
  return c.partner?.name ?? c.name ?? c.id;
}

export function conversationSub(c: ConversationSummary): string {
  if (c.isSelfDm) return "Self DM";
  if (c.type === "channel") return "Channel";
  return `Direct message · ${c.messageCount} messages`;
}

export function inboxSummary(list: ConversationSummary[]): string {
  const n = list.reduce((sum, c) => sum + c.messageCount, 0);
  return `${n} messages · ${list.length} conversations`;
}

const HEAD_GAP_MS = 5 * 60_000;

function dayKey(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** Day separators and Slack-style head grouping: a head on a new day, a new sender, or a gap over 5 min. */
export function groupThread(
  msgs: ThreadMessage[],
  now: Date,
): Array<{ daySep: string | null; showHead: boolean; m: ThreadMessage }> {
  let prev: { t: number; sender: string } | null = null;
  return msgs.map((m) => {
    const t = Date.parse(m.sentAt);
    const newDay = prev === null || Number.isNaN(t) || dayKey(t) !== dayKey(prev.t);
    const showHead =
      newDay || prev === null || prev.sender !== m.sender.id || t - prev.t > HEAD_GAP_MS;
    const daySep = newDay ? dayLabel(m.sentAt, now) || null : null;
    prev = { t: Number.isNaN(t) ? 0 : t, sender: m.sender.id };
    return { daySep, showHead, m };
  });
}

export type ComposerState =
  | { mode: "reply"; urgentId: string; draft: string | null }
  | { mode: "code_answer"; codeAnswerId: string; draft: string }
  | { mode: "note"; text: string };

/**
 * The composer acts only when the conversation has an open urgent item whose reply can still be
 * requested (spec D10); otherwise it is a status note.
 */
export function composerState(
  c: ConversationSummary,
  urgentById: ReadonlyMap<string, UrgentItemDto>,
): ComposerState {
  const first = c.openUrgent[0];
  if (first) {
    const item = urgentById.get(first.messageId);
    if (!item?.reply || item.reply.canRequest) {
      return { mode: "reply", urgentId: first.messageId, draft: item?.draft?.text ?? null };
    }
  }
  if (c.awaitingApproval)
    return { mode: "note", text: "Reply is waiting for your approval in Needs you." };
  if (c.isSelfDm) return { mode: "note", text: "Your own notes. Not screened." };
  if (c.theyWroteLast) return { mode: "note", text: "They wrote last." };
  return { mode: "note", text: "You replied last. Nothing waiting." };
}
