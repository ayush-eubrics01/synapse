import { expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { IdentitySetup } from "../app/components/IdentitySetup";
import { UrgentInbox } from "../app/components/UrgentInbox";
import type { UrgentItemDto } from "../lib/api";

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
  expect(live).not.toContain("Send");
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
