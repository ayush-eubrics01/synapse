import { beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToString } from "react-dom/server";
import { Composer } from "../app/components/inbox/Composer";
import { FollowupCard } from "../app/components/triage/FollowupCard";
import { UrgentCard } from "../app/components/triage/UrgentCard";
import type { FollowupViewDto, UrgentItemDto } from "../lib/api";
import { clearAllDrafts, clearDraft, readDraft, writeDraft } from "../lib/drafts";

const T = "2026-01-01T00:00:00.000Z";
const NOW = new Date("2026-01-01T00:05:00.000Z");
const noop = () => {};
const text = (html: string) => html.replace(/<!-- -->/g, "");

beforeEach(() => clearAllDrafts());

test("write, read and clear a draft by key", () => {
  writeDraft("reply:m1", "x");
  expect(readDraft("reply:m1")).toBe("x");
  expect(readDraft("reply:m2")).toBeUndefined();
  clearDraft("reply:m1");
  expect(readDraft("reply:m1")).toBeUndefined();
});

test("the reply composer shows the model draft, then the stored edit", () => {
  const state = { mode: "reply" as const, urgentId: "m1", draft: "model text" };
  expect(renderToString(<Composer state={state} onReply={noop} />)).toContain("model text");
  writeDraft("reply:m1", "edited text");
  const html = renderToString(<Composer state={state} onReply={noop} />);
  expect(html).toContain("edited text");
  expect(html).not.toContain("model text");
});

test("the code-answer composer shows the model draft, then the stored edit", () => {
  const state = { mode: "code_answer" as const, codeAnswerId: "c1", draft: "model text" };
  expect(renderToString(<Composer state={state} onReply={noop} />)).toContain("model text");
  writeDraft("code_answer:c1", "edited text");
  const html = renderToString(<Composer state={state} onReply={noop} />);
  expect(html).toContain("edited text");
  expect(html).not.toContain("model text");
});

test("UrgentCard shows the stored reply draft", () => {
  const item: UrgentItemDto = {
    messageId: "m1",
    level: "high",
    reason: "r",
    status: "in_progress",
    allowedTransitions: [],
    assessed: true,
    fallback: false,
    coalesced: false,
    sender: { id: "U0PLACE", name: "Demo" },
    conversation: { id: "C0PLACE", name: "ops", type: "channel" },
    sentAt: T,
    text: "hello",
    permalink: null,
    draft: { text: "model text" } as UrgentItemDto["draft"],
    reply: null,
  };
  writeDraft("reply:m1", "stored reply");
  const html = text(
    renderToString(
      <UrgentCard item={item} now={NOW} onStatus={noop} onReply={noop} onCopy={noop} />,
    ),
  );
  expect(html).toContain("stored reply");
});

test("FollowupCard shows the stored follow-up draft", () => {
  const f = {
    id: "f1",
    commitmentId: "c1",
    origin: "stalled",
    recipient: { id: "U0PLACE", name: "Demo" },
    conversationLabel: "#ops",
    threadReply: true,
    noThread: false,
    draftText: "model text",
    confidence: 0.8,
    status: "draft",
    outgoing: null,
    approvalId: null,
    actions: ["send", "discard"],
    resolveActions: [],
    createdAt: T,
    updatedAt: T,
  } as FollowupViewDto;
  writeDraft("followup:f1", "stored follow-up");
  const html = text(
    renderToString(<FollowupCard f={f} now={NOW} onSend={noop} onDiscard={noop} />),
  );
  expect(html).toContain("stored follow-up");
});

test("the draft store never touches browser storage", () => {
  for (const file of ["lib/drafts.ts", "app/components/ui/useDraft.ts"]) {
    const src = readFileSync(join(import.meta.dir, "..", file), "utf8");
    expect(src).not.toMatch(/localStorage|sessionStorage|indexedDB/);
  }
});
