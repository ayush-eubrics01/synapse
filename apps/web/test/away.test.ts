import { expect, test } from "bun:test";
import { holdReasonSchema } from "@synapse/contracts";
import { bannerCopy, deliveryLabel, holdReasonLabel, kindLabel } from "../lib/away";

test("every contract hold reason has a plain-words label", () => {
  for (const r of holdReasonSchema.options) {
    const label = holdReasonLabel(r);
    expect(label.length).toBeGreaterThan(0);
    expect(label).not.toBe(r);
    expect(label).not.toContain("_");
  }
});

test("hold reason labels use the briefed copy", () => {
  expect(holdReasonLabel("away_off")).toBe("You came back first");
  expect(holdReasonLabel("not_priority")).toBe("Not a priority person");
  expect(holdReasonLabel("loop_tag")).toBe("Their message was itself an auto-reply");
  expect(holdReasonLabel("flagged")).toBe("Their message has an open red flag");
  expect(holdReasonLabel("daily_cap")).toBe("Daily limit reached");
  expect(holdReasonLabel("thread_gap")).toBe("Replied in this thread recently");
  expect(holdReasonLabel("low_confidence")).toBe("Not confident enough");
  expect(holdReasonLabel("content_secret")).toBe("Draft looked like it contained a secret");
  expect(holdReasonLabel("content_internal_url")).toBe("Draft contained an internal link");
  expect(holdReasonLabel("content_promise")).toBe("Draft made a promise for you");
  expect(holdReasonLabel("kind_not_allowed")).toBe("Kind turned off");
  expect(holdReasonLabel("missing_context")).toBe("Original message no longer available");
  expect(holdReasonLabel("policy_disabled")).toBe("Auto-replies turned off in permissions");
  expect(holdReasonLabel("recipient_mismatch")).toBe("Recipient didn't match the conversation");
  expect(holdReasonLabel("not_addressed")).toBe("Their message wasn't addressed to you");
  expect(holdReasonLabel("before_session")).toBe("Message arrived before you went away");
  expect(holdReasonLabel("already_answered")).toBe("You had already replied");
  expect(holdReasonLabel("injection_suspected")).toBe(
    "Drafting run suspected a manipulation attempt",
  );
  expect(holdReasonLabel("content_mention")).toBe("Draft mentioned people or a group");
  expect(holdReasonLabel("content_link")).toBe("Draft contained a link");
  expect(holdReasonLabel("stale")).toBe("Too much time passed before it could send");
});

test("a held row without a reason still reads in words", () => {
  expect(holdReasonLabel(null)).toBe("Held");
});

test("kind labels", () => {
  expect(kindLabel("acknowledgement")).toBe("Acknowledgement");
  expect(kindLabel("stalled_reminder")).toBe("Stalled reminder");
  expect(kindLabel("followup_question")).toBe("Follow-up question");
  expect(kindLabel("code_answer")).toBe("Code answer");
});

test("delivery labels come from the outgoing status", () => {
  expect(deliveryLabel("sent")).toBe("Delivered");
  expect(deliveryLabel("sent_unverified")).toBe("Sent, not yet verified");
  expect(deliveryLabel("pending")).toBe("Sending…");
  expect(deliveryLabel("sending")).toBe("Sending…");
  expect(deliveryLabel("needs_attention")).toBe("Not sent — needs your attention");
  expect(deliveryLabel("failed")).toBe("Not sent");
  expect(deliveryLabel("revoked")).toBe("Not sent");
  expect(deliveryLabel(null)).toBe("Not sent");
});

test("banner copy for n people", () => {
  expect(bannerCopy(2)).toContain("auto-reply to your 2 high-priority people");
  expect(bannerCopy(2)).toContain("“Sent using @claude”");
  expect(bannerCopy(2)).toContain("Everything else waits for you.");
  expect(bannerCopy(0)).toBe(
    "No one is set to high priority, so nobody will get an auto-reply. Everything waits for you.",
  );
});
