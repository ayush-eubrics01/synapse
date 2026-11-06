import { afterEach, beforeEach, expect, test } from "bun:test";
import type { AIProvider } from "@synapse/contracts";
import { schema } from "@synapse/database";
import { FakeClock, newId } from "@synapse/shared";
import { type Container, createContainer } from "../../src/container";
import { loadConfig } from "../../src/core/config/config";

/**
 * Phase 6b final review, item 6: the Slack content-retention job also clears auto-reply text, and
 * the text of terminal outgoing messages and follow-up drafts, older than
 * `retention.slackContentDays`. Non-terminal rows are never touched.
 */

const NOW = "2026-11-06T12:00:00.000Z";
const DAY = 86_400_000;
const OLD = new Date(Date.parse(NOW) - 31 * DAY).toISOString();
const NEW = new Date(Date.parse(NOW) - 29 * DAY).toISOString();
const TEXT = "SECRET-RETAINED-TEXT";

const fakeProvider: AIProvider = {
  execute: async () => {
    throw new Error("fake provider must not execute");
  },
  getHealth: async () => ({ status: "ok", version: "fake" }),
};

let c: Container;

beforeEach(() => {
  c = createContainer(loadConfig({ SYNAPSE_DB_PATH: ":memory:" }), {
    run: async () => "Linger=yes",
    provider: fakeProvider,
    clock: new FakeClock(NOW),
  });
  c.settings.set("retention.slackContentDays", 30);
  c.db.insert(schema.awaySessions).values({ id: "s1", startedAt: OLD, endedAt: OLD }).run();
});
afterEach(() => c.sqlite.close());

function autoReply(id: string, createdAt: string, decision: "sent" | "held" = "sent") {
  c.db
    .insert(schema.autoReplies)
    .values({
      id,
      sessionId: "s1",
      kind: "acknowledgement",
      recipientSlackUserId: "UADA000001",
      conversationExternalId: "C0CHAN0001",
      decision,
      text: decision === "sent" ? TEXT : null,
      createdAt,
    })
    .run();
}

type OutStatus = (typeof schema.outgoingMessages.$inferSelect)["status"];
function outgoing(id: string, status: OutStatus, createdAt: string) {
  c.db
    .insert(schema.approvals)
    .values({
      id: `a-${id}`,
      action: "slack.send",
      payload: { outgoingId: id },
      riskLevel: "medium",
      idempotencyKey: `k-${id}`,
      createdAt,
    })
    .run();
  c.db
    .insert(schema.outgoingMessages)
    .values({
      id,
      approvalId: `a-${id}`,
      conversationExternalId: "C0CHAN0001",
      text: TEXT,
      status,
      createdAt,
      updatedAt: createdAt,
    })
    .run();
}

type FuStatus = (typeof schema.followups.$inferSelect)["status"];
function followup(id: string, status: FuStatus, createdAt: string) {
  c.db
    .insert(schema.followups)
    .values({
      id,
      origin: "stalled",
      conversationId: "c-dm",
      recipientSlackUserId: "UADA000001",
      draftText: TEXT,
      status,
      createdAt,
      updatedAt: createdAt,
    })
    .run();
}

const textOf = <T extends { id: string }>(rows: T[], pick: (r: T) => string | null) =>
  Object.fromEntries(rows.map((r) => [r.id, pick(r)]));

async function runRetention() {
  const reg = c.handlers.get("slack.retention_cleanup");
  if (!reg) throw new Error("retention handler missing");
  return reg.handler({ id: newId(), type: "slack.retention_cleanup", input: null } as never, {
    signal: new AbortController().signal,
    checkpoint() {},
    getCheckpoint: () => undefined,
  });
}

test("auto-reply text older than retention is cleared; newer text stays", async () => {
  autoReply("old", OLD);
  autoReply("new", NEW);
  autoReply("held", OLD, "held");
  const r = await runRetention();
  expect(r).toMatchObject({ autoReplyText: 1 });
  expect(textOf(c.db.select().from(schema.autoReplies).all(), (a) => a.text)).toEqual({
    old: null,
    new: TEXT,
    held: null,
  });
});

test("terminal outgoing text older than retention is cleared; non-terminal rows are untouched", async () => {
  outgoing("sent-old", "sent", OLD);
  outgoing("failed-old", "failed", OLD);
  outgoing("sent-new", "sent", NEW);
  for (const s of ["pending", "sending", "sent_unverified", "needs_attention"] as const) {
    outgoing(`${s}-old`, s, OLD);
  }
  const r = await runRetention();
  expect(r).toMatchObject({ outgoingText: 2 });
  // The column is NOT NULL, so expired text is blanked rather than nulled.
  expect(textOf(c.db.select().from(schema.outgoingMessages).all(), (o) => o.text)).toEqual({
    "sent-old": "",
    "failed-old": "",
    "sent-new": TEXT,
    "pending-old": TEXT,
    "sending-old": TEXT,
    "sent_unverified-old": TEXT,
    "needs_attention-old": TEXT,
  });
});

test("terminal follow-up drafts older than retention are cleared; live drafts are untouched", async () => {
  followup("sent-old", "sent", OLD);
  followup("discarded-old", "discarded", OLD);
  followup("failed-old", "failed", OLD);
  followup("sent-new", "sent", NEW);
  for (const s of ["draft", "awaiting_approval", "sending", "needs_attention"] as const) {
    followup(`${s}-old`, s, OLD);
  }
  const r = await runRetention();
  expect(r).toMatchObject({ followupDrafts: 3 });
  expect(textOf(c.db.select().from(schema.followups).all(), (f) => f.draftText)).toEqual({
    "sent-old": null,
    "discarded-old": null,
    "failed-old": null,
    "sent-new": TEXT,
    "draft-old": TEXT,
    "awaiting_approval-old": TEXT,
    "sending-old": TEXT,
    "needs_attention-old": TEXT,
  });
});

test("the job result and audit carry counts only, never text", async () => {
  autoReply("old", OLD);
  outgoing("sent-old", "sent", OLD);
  followup("sent-old", "sent", OLD);
  const r = await runRetention();
  expect(JSON.stringify(r)).not.toContain("SECRET");
  const dump = JSON.stringify([
    c.db.select().from(schema.auditEvents).all(),
    c.db.select().from(schema.domainEvents).all(),
  ]);
  expect(dump).not.toContain("SECRET");
});
