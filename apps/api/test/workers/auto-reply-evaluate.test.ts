import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type AIProvider,
  type Job,
  JobError,
  type MessageSink,
  type SendMessageCommand,
  type SendResult,
} from "@synapse/contracts";
import { schema } from "@synapse/database";
import { FakeClock, newId } from "@synapse/shared";
import { eq } from "drizzle-orm";
import { type Container, createContainer } from "../../src/container";
import { loadConfig } from "../../src/core/config/config";
import { ACK_TEXT, withAutoReplyTag } from "../../src/modules/auto-reply/policy";
import { AUTOREPLY_EVALUATE_JOB } from "../../src/modules/auto-reply/service";

const NOW = "2026-11-06T12:00:00.000Z";
const SELF = "USELF00001";
const ADA = "UADA000001";
const CHANNEL = "C0CHAN0001";
const signal = new AbortController().signal;
const ctx = { signal, checkpoint() {}, getCheckpoint: () => undefined } as never;

class FakeSink implements MessageSink {
  sends: SendMessageCommand[] = [];
  async send(cmd: SendMessageCommand): Promise<SendResult> {
    this.sends.push(cmd);
    return { status: "sent_unverified" };
  }
  async findSent(): Promise<boolean | null> {
    return null;
  }
}

const fakeProvider: AIProvider = {
  execute: async () => {
    throw new Error("fake provider must not execute");
  },
  getHealth: async () => ({ status: "ok", version: "fake" }),
};

let c: Container;
let sink: FakeSink;

beforeEach(() => {
  sink = new FakeSink();
  c = createContainer(loadConfig({ SYNAPSE_DB_PATH: ":memory:" }), {
    run: async () => "Linger=yes",
    provider: fakeProvider,
    sink,
    clock: new FakeClock(NOW),
  });
  c.settings.set("slack.selfUserId", SELF);
  c.db
    .insert(schema.slackUsers)
    .values([
      { id: "u-self", externalId: SELF, name: "Me" },
      { id: "u-ada", externalId: ADA, name: "Ada" },
    ])
    .run();
  c.db
    .insert(schema.slackConversations)
    .values({ id: "c-ch", externalId: CHANNEL, type: "channel", name: "eng" })
    .run();
  c.db
    .insert(schema.slackMessages)
    .values({
      id: "m1",
      conversationId: "c-ch",
      ts: "1793880000.000100",
      senderUserId: "u-ada",
      text: "SECRET-INCOMING <@USELF00001> the deploy is failing",
      sentAt: NOW,
      collectedAt: NOW,
    })
    .run();
  c.people.setPriority(ADA, { priority: "high" });
});
afterEach(() => c.sqlite.close());

function followup(origin: "stalled" | "spec_clarity" | "urgent_reply" | "manual"): string {
  const id = newId();
  c.db
    .insert(schema.followups)
    .values({
      id,
      origin,
      conversationId: "c-ch",
      threadTs: "1793880000.000100",
      recipientSlackUserId: ADA,
      draftText: "SECRET-DRAFT is the checklist on track?",
      confidence: 0.9,
      status: "draft",
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run();
  return id;
}

function urgent(messageId = "m1", level: "critical" | "high" = "high"): void {
  c.db.transaction((tx) =>
    c.events.publish(tx, {
      type: "message.urgent_detected",
      aggregateType: "message",
      aggregateId: messageId,
      correlationId: newId(),
      payload: { messageId, level, assessed: true },
    }),
  );
  c.dispatcher.dispatchOnce();
}

function drafted(followupId: string): void {
  c.db.transaction((tx) =>
    c.events.publish(tx, {
      type: "followup.draft_created",
      aggregateType: "followup",
      aggregateId: followupId,
      correlationId: newId(),
      payload: { followupId },
    }),
  );
  c.dispatcher.dispatchOnce();
}

const evalJobs = () =>
  c.db.select().from(schema.jobs).where(eq(schema.jobs.type, AUTOREPLY_EVALUATE_JOB)).all();

describe("triggers", () => {
  test("away off: neither event enqueues a job", () => {
    urgent();
    drafted(followup("stalled"));
    drafted(followup("spec_clarity"));
    expect(evalJobs()).toHaveLength(0);
  });

  test("away on: an urgent message enqueues one acknowledgement job in group autoreply", () => {
    c.autoReply.setAway(true);
    urgent("m1", "critical");
    urgent("m1", "high");
    const jobs = evalJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      idempotencyKey: "autoreply:acknowledgement:m1",
      concurrencyGroup: "autoreply",
      input: { kind: "acknowledgement", messageId: "m1" },
      externalWrite: false,
    });
  });

  test("away on: draft origins map to kinds; other origins are ignored", () => {
    c.autoReply.setAway(true);
    const stalled = followup("stalled");
    const spec = followup("spec_clarity");
    drafted(stalled);
    drafted(spec);
    drafted(followup("urgent_reply"));
    drafted(followup("manual"));
    drafted("missing-followup");
    const keys = evalJobs()
      .map((j) => j.idempotencyKey)
      .sort();
    expect(keys).toEqual(
      [`autoreply:stalled_reminder:${stalled}`, `autoreply:followup_question:${spec}`].sort(),
    );
    expect(evalJobs().every((j) => j.concurrencyGroup === "autoreply")).toBe(true);
  });

  test("away switched off after enqueue: the job runs but records nothing", async () => {
    c.autoReply.setAway(true);
    urgent();
    c.autoReply.setAway(false);
    expect(await c.worker.runOnce()).toBe(true);
    expect(evalJobs()[0]?.status).toBe("COMPLETED");
    expect(c.db.select().from(schema.autoReplies).all()).toHaveLength(0);
  });
});

describe("autoreply.evaluate job", () => {
  test("runs the policy and the approved send goes out tagged", async () => {
    c.autoReply.setAway(true);
    urgent();
    expect(await c.worker.runOnce()).toBe(true);
    const rows = c.db.select().from(schema.autoReplies).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "acknowledgement", decision: "sent" });
    c.dispatcher.dispatchOnce();
    expect(await c.worker.runOnce()).toBe(true);
    expect(sink.sends.map((s) => s.text)).toEqual([withAutoReplyTag(ACK_TEXT)]);
  });

  test("the idempotency key prevents a second evaluation of the same trigger", async () => {
    c.autoReply.setAway(true);
    urgent();
    expect(await c.worker.runOnce()).toBe(true);
    // The same trigger again (a re-published event) finds the finished job and adds nothing.
    urgent();
    expect(evalJobs()).toHaveLength(1);
    c.dispatcher.dispatchOnce();
    await c.worker.runOnce();
    expect(c.db.select().from(schema.autoReplies).all()).toHaveLength(1);
  });

  test("invalid input fails as invalid_input", async () => {
    const reg = c.handlers.get(AUTOREPLY_EVALUATE_JOB);
    expect(reg).toBeDefined();
    const job = { id: "j", input: { kind: "acknowledgement" } } as unknown as Job;
    try {
      await reg?.handler(job, ctx);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(JobError);
      expect((e as JobError).classified.kind).toBe("invalid_input");
    }
  });
});
