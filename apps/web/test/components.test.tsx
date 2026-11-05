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
    renderToString(<IdentitySetup identity={{ ...base, selfUserId: "U1" }} onConfirm={() => {}} />),
  ).toBe("");
  expect(
    renderToString(<IdentitySetup identity={{ ...base, selfUserId: null }} onConfirm={() => {}} />),
  ).toContain("Confirm");
});
