import { expect, test } from "bun:test";
import type { AutoReplyView, AwayDigest, DashboardOverview } from "@synapse/contracts";
import { renderToString } from "react-dom/server";
import { AwayBanner } from "../app/components/header/AwayBanner";
import { Header } from "../app/components/header/Header";
import { AwayDigestCard } from "../app/components/triage/AwayDigestCard";
import { digestTitle } from "../lib/away";
import { buildNeedsYou, needsYouCount } from "../lib/needs-you";

const text = (html: string) => html.replace(/<!-- -->/g, "");
const NOW = new Date("2026-11-06T12:00:00Z");

const view = (o: Partial<AutoReplyView> = {}): AutoReplyView => ({
  id: "a1",
  kind: "acknowledgement",
  decision: "sent",
  reason: null,
  recipient: { slackUserId: "U1", name: "Grace" },
  conversationLabel: "#ops",
  threadTs: null,
  createdAt: "2026-11-06T11:30:00Z",
  outgoingStatus: "sent",
  ...o,
});

const digest = (o: Partial<AwayDigest> = {}): AwayDigest => ({
  session: { id: "S1", startedAt: "2026-11-06T08:00:00Z", endedAt: "2026-11-06T11:55:00Z" },
  sent: [view(), view({ id: "a2", kind: "stalled_reminder", outgoingStatus: "sent_unverified" })],
  held: [
    view({
      id: "a3",
      decision: "held",
      kind: "followup_question",
      reason: "daily_cap",
      recipient: { slackUserId: "U2", name: "Linus" },
      outgoingStatus: null,
    }),
  ],
  ...o,
});

const overview = (on: boolean, n = 0): DashboardOverview =>
  ({
    generatedAt: NOW.toISOString(),
    self: { slackUserId: "U0", name: "Ada" },
    counts: {},
    away: { on, highPriorityCount: n },
    lastSlackSyncAt: null,
    health: { status: "ok", issues: [] },
    pipeline: [],
    engineeringLock: null,
  }) as unknown as DashboardOverview;

const header = (o: DashboardOverview | null, onToggleAway = () => {}) =>
  renderToString(
    <Header
      overview={o}
      failure={null}
      now={NOW}
      onOpenPalette={() => {}}
      backfillStarted
      onToggleAway={onToggleAway}
    />,
  );

test("the Away switch is enabled and reflects the server state", () => {
  const off = header(overview(false));
  expect(off).toContain('role="switch"');
  expect(off).toContain('aria-checked="false"');
  expect(off).not.toContain("aria-disabled");
  expect(off).not.toContain("isn&#x27;t available yet");
  const on = header(overview(true));
  expect(on).toContain('aria-checked="true"');
  expect(on).not.toContain("aria-disabled");
});

test("the banner copy for n = 2 and n = 0, with a priority button", () => {
  const two = text(renderToString(<AwayBanner highPriorityCount={2} onSetPriority={() => {}} />));
  expect(two).toContain("Away mode is on");
  expect(two).toContain("Synapse may auto-reply to your 2 high-priority people");
  expect(two).toContain("Set priority people");
  const none = text(renderToString(<AwayBanner highPriorityCount={0} onSetPriority={() => {}} />));
  expect(none).toContain("No one is set to high priority, so nobody will get an auto-reply.");
});

const card = (d: AwayDigest) =>
  text(renderToString(<AwayDigestCard digest={d} now={NOW} onDismiss={() => {}} />));

test("the digest card shows sent and held rows in plain words", () => {
  const html = card(digest());
  expect(html).toContain("WHILE YOU WERE AWAY");
  expect(html).toContain("2 auto-replies sent, 1 held");
  expect(html).toContain("Grace");
  expect(html).toContain("Acknowledgement");
  expect(html).toContain("Stalled reminder");
  expect(html).toContain("#ops");
  expect(html).toContain("Delivered");
  expect(html).toContain("Sent, not yet verified");
  expect(html).toContain("Linus");
  expect(html).toContain("Follow-up question");
  expect(html).toContain("Daily limit reached");
  expect(html).toContain(">Dismiss</button>");
  expect(html).not.toContain("daily_cap");
});

test("a sent row whose send did not go out reads Not sent", () => {
  const html = card(
    digest({
      sent: [
        view({ outgoingStatus: "failed" }),
        view({ id: "a9", outgoingStatus: "needs_attention" }),
        view({ id: "a8", outgoingStatus: "sending" }),
      ],
      held: [],
    }),
  );
  expect(html).toContain("Not sent");
  expect(html).toContain("Not sent — needs your attention");
  expect(html).toContain("Sending…");
});

test("Dismiss calls the handler with the session id", () => {
  const calls: string[] = [];
  const el = AwayDigestCard({ digest: digest(), now: NOW, onDismiss: (id) => calls.push(id) });
  const find = (n: unknown): { onClick?: () => void } | null => {
    if (!n || typeof n !== "object") return null;
    const node = n as { type?: unknown; props?: { children?: unknown; onClick?: () => void } };
    if (node.props?.onClick && JSON.stringify(node.props.children) === '"Dismiss"')
      return node.props;
    const kids = ([] as unknown[]).concat(node.props?.children ?? []);
    for (const k of kids) {
      const f = find(k);
      if (f) return f;
    }
    return null;
  };
  // CardFrame and Actions are components, so walk the element tree through their props.
  const btn = find(el);
  expect(btn).not.toBeNull();
  btn?.onClick?.();
  expect(calls).toEqual(["S1"]);
});

const emptyInput = {
  urgent: [],
  approvals: [],
  flags: [],
  followups: [],
  reviewQueue: [],
  recommendations: [],
  identity: { selfUserId: "U0", suggestion: null, suggestionName: null },
  people: [],
  candidates: { identityRequired: false, candidates: [] },
  slackStatus: null,
  hidden: new Set<string>(),
};

test("the away digest ranks first in Needs you and counts", () => {
  const cards = buildNeedsYou({
    ...emptyInput,
    awayDigest: digest(),
    urgent: [
      {
        messageId: "m1",
        level: "critical",
        sender: { id: "U1", name: "Grace" },
        conversation: { id: "C1", name: "ops", type: "channel" },
        sentAt: "2026-11-06T11:00:00Z",
        reply: null,
      } as never,
    ],
  });
  expect(cards[0]?.kind).toBe("away-digest");
  expect(cards[0]?.key).toBe("away-digest:S1");
  expect(needsYouCount(cards)).toBe(2);
  expect(buildNeedsYou({ ...emptyInput, awayDigest: null })).toEqual([]);
});

test("digestTitle pluralises the sent count", () => {
  expect(digestTitle(1, 0)).toBe("1 auto-reply sent, 0 held");
  expect(digestTitle(2, 1)).toBe("2 auto-replies sent, 1 held");
  expect(digestTitle(0, 0)).toBe("0 auto-replies sent, 0 held");
});
