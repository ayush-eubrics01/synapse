import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AIProvider, ConversationSummary, ConversationThread } from "@synapse/contracts";
import { schema } from "@synapse/database";
import { eq } from "drizzle-orm";
import { createApp } from "../../src/app";
import { type Container, createContainer } from "../../src/container";
import { loadConfig } from "../../src/core/config/config";
import { InboxConversations } from "../../src/modules/inbox/conversations";

const fakeProvider: AIProvider = {
  execute: async () => {
    throw new Error("fake provider must not execute");
  },
  getHealth: async () => ({ status: "ok", version: "fake" }),
};
const NOW = "2026-11-06T12:00:00.000Z";
const SELF = "U0SELF001";
const ADA = "U0ADA0001";

let c: Container;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  c = createContainer(loadConfig({ SYNAPSE_DB_PATH: ":memory:" }), {
    run: async () => "Linger=no",
    provider: fakeProvider,
    clock: { now: () => new Date(NOW) },
  });
  app = createApp(c);
});
afterEach(() => c.sqlite.close());

const req = (path: string) => app.request(`http://127.0.0.1:7400${path}`);
const list = async () =>
  (await (await req("/api/inbox/conversations")).json()) as ConversationSummary[];
const thread = (id: string, q = "") => req(`/api/inbox/conversations/${id}/thread${q}`);
const at = (min: number) =>
  new Date(Date.parse("2026-11-06T10:00:00.000Z") + min * 60_000).toISOString();

function seed(withSelf = true): void {
  const { db } = c;
  if (withSelf) c.settings.set("slack.selfUserId", SELF);
  db.insert(schema.slackUsers).values({ id: "u-self", externalId: SELF, name: "Grace" }).run();
  db.insert(schema.slackUsers).values({ id: "u-ada", externalId: ADA, name: "Ada" }).run();
  const conv = (id: string, ext: string, type: "im" | "mpim" | "channel", name: string | null) =>
    db.insert(schema.slackConversations).values({ id, externalId: ext, type, name }).run();
  conv("c-ada", "D0ADA0001", "im", null);
  // The self DM is recognised by its stored name equalling the self user's stored name.
  conv("c-self", "D0SELF001", "im", "Grace");
  conv("c-ops", "C0OPS0001", "channel", "ops");
  let n = 0;
  const msg = (id: string, conv: string, sender: string, min: number, text: string | null) =>
    db
      .insert(schema.slackMessages)
      .values({
        id,
        conversationId: conv,
        ts: `1793880${String(++n).padStart(3, "0")}.000100`,
        senderUserId: sender,
        text,
        sentAt: at(min),
        collectedAt: at(min),
      })
      .run();
  msg("m1", "c-ada", "u-self", 0, "hello Ada");
  msg("m2", "c-ada", "u-ada", 10, "x".repeat(200));
  msg("m3", "c-self", "u-self", 20, "note to self");
  msg("m4", "c-ops", "u-ada", 5, "deploy done");
  msg("m5", "c-ops", "u-self", 3, null);
  msg("m6", "c-ops", "u-self", 4, "ok Q&amp;A   sure");
}

describe("GET /api/inbox/conversations", () => {
  test("empty database", async () => {
    expect(await list()).toEqual([]);
  });

  test("order, partner, flags, preview", async () => {
    seed();
    const l = await list();
    expect(l.map((x) => x.id)).toEqual(["D0SELF001", "D0ADA0001", "C0OPS0001"]);
    const [self, ada, ops] = l as [ConversationSummary, ConversationSummary, ConversationSummary];
    expect(l.filter((x) => x.isSelfDm).map((x) => x.id)).toEqual(["D0SELF001"]);
    expect(ada.partner).toEqual({ id: ADA, name: "Ada" });
    expect(ops.partner).toBeNull();
    expect(self.partner).toBeNull();
    expect(ada.theyWroteLast).toBe(true);
    expect(ops.theyWroteLast).toBe(false);
    expect(self.theyWroteLast).toBe(false);
    expect(ada.preview?.length).toBe(140);
    expect(ada.messageCount).toBe(2);
    expect(ada.lastSender).toEqual({ id: ADA, name: "Ada", isSelf: false });
    expect(ops.lastMessageAt).toBe(at(5));
  });

  test("a DM I started with no reply and no name is not a self DM", async () => {
    seed();
    c.db
      .insert(schema.slackConversations)
      .values({ id: "c-new", externalId: "D0NEW0001", type: "im", name: null })
      .run();
    c.db
      .insert(schema.slackMessages)
      .values({
        id: "m9",
        conversationId: "c-new",
        ts: "1793889999.000100",
        senderUserId: "u-self",
        text: "invented opener",
        sentAt: at(30),
        collectedAt: at(30),
      })
      .run();
    const d = (await list()).find((x) => x.id === "D0NEW0001");
    expect(d).toMatchObject({ isSelfDm: false, partner: null, theyWroteLast: false, name: null });
    expect(d?.lastSender.isSelf).toBe(true);
  });

  test("a partner-less DM whose name differs from the self name is not a self DM", async () => {
    seed();
    c.sqlite.run("update slack_conversations set name = 'someone-else' where id = 'c-self'");
    const d = (await list()).find((x) => x.id === "D0SELF001");
    expect(d).toMatchObject({ isSelfDm: false, partner: null, theyWroteLast: false });
  });

  test("null preview when latest text expired", async () => {
    seed();
    c.sqlite.run("update slack_messages set text = null where id = 'm2'");
    const ada = (await list()).find((x) => x.id === "D0ADA0001");
    expect(ada?.preview).toBeNull();
  });

  test("no self id: nothing is self", async () => {
    seed(false);
    const l = await list();
    expect(l.every((x) => !x.isSelfDm && !x.theyWroteLast && !x.lastSender.isSelf)).toBe(true);
  });

  test("awaitingApproval from a real requestSend; openUrgent", async () => {
    seed();
    c.db.transaction((tx) => {
      c.outgoing.requestSend(tx, {
        followupId: null,
        conversationExternalId: "D0ADA0001",
        text: "reply",
        requestedByModule: "test",
      });
    });
    c.sqlite.run(
      "update slack_messages set urgency_level = 'high', urgency_reason = 'r', urgency_status = 'new' where id = 'm4'",
    );
    const l = await list();
    expect(l.find((x) => x.id === "D0ADA0001")?.awaitingApproval).toBe(true);
    expect(l.find((x) => x.id === "C0OPS0001")?.awaitingApproval).toBe(false);
    expect(l.find((x) => x.id === "C0OPS0001")?.openUrgent).toEqual([
      { messageId: "m4", level: "high" },
    ]);
    expect(l.find((x) => x.id === "D0ADA0001")?.openUrgent).toEqual([]);
  });

  test("limit is validated", async () => {
    expect((await req("/api/inbox/conversations?limit=0")).status).toBe(400);
    expect((await req("/api/inbox/conversations?limit=101")).status).toBe(400);
    seed();
    const r = (await (await req("/api/inbox/conversations?limit=2")).json()) as unknown[];
    expect(r.length).toBe(2);
  });
});

describe("GET /api/inbox/conversations/:id/thread", () => {
  test("404 and 400", async () => {
    seed();
    const nf = await thread("D0NOPE001");
    expect(nf.status).toBe(404);
    expect(await nf.json()).toEqual({ error: "conversation not found" });
    expect((await thread("xyz")).status).toBe(400);
  });

  test("thread limit is bounded to 1..500", async () => {
    seed();
    expect((await thread("C0OPS0001", "?limit=0")).status).toBe(400);
    expect((await thread("C0OPS0001", "?limit=501")).status).toBe(400);
    expect((await thread("C0OPS0001", "?limit=500")).status).toBe(200);
  });

  test("oldest first, isSelf, newest-limit window", async () => {
    seed();
    const t = (await (await thread("C0OPS0001")).json()) as ConversationThread;
    expect(t.messages.map((m) => m.id)).toEqual(["m5", "m6", "m4"]);
    expect(t.messages.map((m) => m.isSelf)).toEqual([true, true, false]);
    expect(t.conversation.id).toBe("C0OPS0001");
    const w = (await (await thread("C0OPS0001", "?limit=2")).json()) as ConversationThread;
    expect(w.messages.map((m) => m.id)).toEqual(["m6", "m4"]);
  });

  test("permalinks pass through safePermalink: a javascript: link becomes null", async () => {
    seed();
    c.db
      .update(schema.slackMessages)
      .set({ permalink: "javascript:alert(1)" })
      .where(eq(schema.slackMessages.id, "m4"))
      .run();
    c.db
      .update(schema.slackMessages)
      .set({ permalink: "https://example.slack.com/archives/C0OPS0001/p1793880006000100" })
      .where(eq(schema.slackMessages.id, "m6"))
      .run();
    const t = (await (await thread("C0OPS0001")).json()) as ConversationThread;
    const link = (id: string) => t.messages.find((m) => m.id === id)?.permalink;
    expect(link("m4")).toBeNull();
    expect(link("m6")).toBe("https://example.slack.com/archives/C0OPS0001/p1793880006000100");
  });

  test("highest-severity flag and commitment", async () => {
    seed();
    const flag = (id: string, severity: string, ruleId: string) =>
      c.db
        .insert(schema.securityFlags)
        .values({
          id,
          messageId: "m4",
          sourceExternalRef: "ref",
          slackUserId: ADA,
          detector: "rules",
          ruleId,
          severity: severity as "info",
          excerpt: "e",
          reason: `reason-${severity}`,
          status: "open",
          createdAt: NOW,
          updatedAt: NOW,
        })
        .run();
    flag("f1", "info", "r1");
    flag("f2", "high", "r2");
    const cm = (id: string, review: "pending_review" | "rejected", created: string) =>
      c.db
        .insert(schema.commitments)
        .values({
          id,
          description: `d-${id}`,
          ownerSlackUserId: ADA,
          direction: "theirs",
          status: "open",
          reviewStatus: review,
          dedupKey: id,
          createdAt: created,
          updatedAt: created,
        })
        .run();
    cm("cm1", "pending_review", at(1));
    cm("cm2", "rejected", at(2));
    for (const id of ["cm1", "cm2"])
      c.db
        .insert(schema.commitmentSources)
        .values({
          id: `s-${id}`,
          commitmentId: id,
          messageId: "m4",
          sourceExternalRef: "ref",
          conversationId: "C0OPS0001",
          createdAt: NOW,
        })
        .run();
    const t = (await (await thread("C0OPS0001")).json()) as ConversationThread;
    const m4 = t.messages.find((m) => m.id === "m4");
    expect(m4?.flag).toEqual({ severity: "high", reason: "reason-high" });
    expect(m4?.commitment).toEqual({
      id: "cm1",
      description: "d-cm1",
      direction: "theirs",
      reviewStatus: "pending_review",
      status: "open",
    });
    expect(t.messages.find((m) => m.id === "m6")?.flag).toBeNull();
    expect(t.messages.find((m) => m.id === "m6")?.commitment).toBeNull();
  });

  test("a thread with no outgoing rows never calls autoSent; the source has no auto_replies SQL", async () => {
    seed();
    const deps = {
      db: c.db,
      settings: c.settings,
      urgent: c.urgent,
      normalise: (t: string) => t,
      autoSent: () => {
        throw new Error("must not be called");
      },
    };
    const view = new InboxConversations(deps).thread("C0OPS0001", 50);
    expect(view?.messages.length).toBeGreaterThan(0);
    expect(
      readFileSync(join(import.meta.dir, "../../src/modules/inbox/conversations.ts"), "utf8"),
    ).not.toContain("auto_replies");
  });

  test("sentViaSynapse.auto is true only when an auto_replies row links the outgoing row", async () => {
    seed();
    const outId = c.db.transaction((tx) => {
      const r = c.outgoing.requestSend(tx, {
        followupId: null,
        conversationExternalId: "C0OPS0001",
        text: "ok Q&A sure",
        requestedByModule: "test",
      });
      tx.update(schema.outgoingMessages)
        .set({ status: "sent_unverified", sendingAt: at(2) })
        .where(eq(schema.outgoingMessages.id, r.outgoingId))
        .run();
      return r.outgoingId;
    });
    const m6 = async () =>
      ((await (await thread("C0OPS0001")).json()) as ConversationThread).messages.find(
        (m) => m.id === "m6",
      )?.sentViaSynapse;
    expect(await m6()).toEqual({ status: "sent_unverified", auto: false });
    c.db
      .insert(schema.awaySessions)
      .values({ id: "as1", startedAt: at(0), endedAt: null, dismissedAt: null })
      .run();
    c.db
      .insert(schema.autoReplies)
      .values({
        id: "ar1",
        sessionId: "as1",
        kind: "acknowledgement",
        recipientSlackUserId: "UADA000001",
        conversationExternalId: "C0OPS0001",
        decision: "sent",
        outgoingId: outId,
        createdAt: at(1),
      })
      .run();
    expect(await m6()).toEqual({ status: "sent_unverified", auto: true });
    // A non-'sent' decision row (e.g. a held code-answer review the user approved) is not an auto-reply.
    c.db
      .update(schema.autoReplies)
      .set({ decision: "held" })
      .where(eq(schema.autoReplies.id, "ar1"))
      .run();
    expect(await m6()).toEqual({ status: "sent_unverified", auto: false });
  });

  test("sentViaSynapse matches normalised text within an hour only", async () => {
    seed();
    const out = (text: string, status: "sent" | "pending") =>
      c.db.transaction((tx) => {
        const r = c.outgoing.requestSend(tx, {
          followupId: null,
          conversationExternalId: "C0OPS0001",
          text,
          requestedByModule: "test",
        });
        tx.update(schema.outgoingMessages)
          .set({ status, sendingAt: at(2) })
          .where(eq(schema.outgoingMessages.id, r.outgoingId))
          .run();
      });
    out("ok Q&A sure", "sent");
    const t = (await (await thread("C0OPS0001")).json()) as ConversationThread;
    // m6 sentAt = at(4): 2 min after sendingAt
    expect(t.messages.find((m) => m.id === "m6")?.sentViaSynapse).toEqual({
      status: "sent",
      auto: false,
    });
    expect(t.messages.find((m) => m.id === "m4")?.sentViaSynapse).toBeNull();
    c.sqlite.run(`update outgoing_messages set sending_at = '${at(4 - 120)}'`);
    const t2 = (await (await thread("C0OPS0001")).json()) as ConversationThread;
    expect(t2.messages.find((m) => m.id === "m6")?.sentViaSynapse).toBeNull();
    // a not-yet-sent row never matches
    c.sqlite.run(`update outgoing_messages set status = 'pending', sending_at = '${at(2)}'`);
    const t3 = (await (await thread("C0OPS0001")).json()) as ConversationThread;
    expect(t3.messages.find((m) => m.id === "m6")?.sentViaSynapse).toBeNull();
  });
});
