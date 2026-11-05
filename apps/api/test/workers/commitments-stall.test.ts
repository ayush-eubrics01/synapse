import { beforeEach, describe, expect, test } from "bun:test";
import {
  type AIExecutionResult,
  type ClaudeJobRequest,
  type Job,
  JobError,
  type PromptPart,
} from "@synapse/contracts";
import { openDatabase, runMigrations, schema } from "@synapse/database";
import { FakeClock } from "@synapse/shared";
import { and, eq } from "drizzle-orm";
import { AuditLogger } from "../../src/core/audit/audit";
import { SettingsService } from "../../src/core/config/settings";
import { LiveBus } from "../../src/core/events/live-bus";
import { EventPublisher } from "../../src/core/events/publisher";
import { JobQueue } from "../../src/core/jobs/queue";
import type { HandlerRegistration } from "../../src/core/jobs/worker";
import { NotificationService } from "../../src/core/notifications/notifications";
import { SchedulerService } from "../../src/core/scheduler/scheduler";
import { StallService } from "../../src/modules/commitments/stall";
import { CommitmentStore } from "../../src/modules/commitments/store";
import { PeopleService } from "../../src/modules/people/service";
import { SecurityFlagsService } from "../../src/modules/security-flags/service";
import { registerCommitmentJobs } from "../../src/workers/commitments";

const NOW = "2026-11-05T12:00:00.000Z";
const H = 3_600_000;
const ago = (hours: number) => new Date(Date.parse(NOW) - hours * H).toISOString();
const SELF = "USELF00001";
const PRIYA = "UPRIYA0001";
const SECRET = "SECRET-BODY-TEXT-xyz";
const DESC = "SECRET-DESCRIPTION-qrs";
const GUIDE = "SECRET-GUIDELINE-ghj";
const signal = new AbortController().signal;
const ctx = { signal, checkpoint() {}, getCheckpoint: () => undefined } as never;
const noInj = { detected: false, severity: "info", quote: "", reason: "" };

let db: ReturnType<typeof openDatabase>["db"];
let queue: JobQueue;
let clock: FakeClock;
let settings: SettingsService;
let handlers: Map<string, HandlerRegistration>;
let requests: ClaudeJobRequest[];
let script: { output?: unknown; raw?: string; throws?: Error; tools?: string[] };
let guidelines: { name: string; texts: string[] } | null;
let seq: number;

beforeEach(() => {
  db = openDatabase(":memory:").db;
  runMigrations(db);
  clock = new FakeClock(NOW);
  const events = new EventPublisher(clock);
  settings = new SettingsService(db, clock, events.publish.bind(events));
  queue = new JobQueue(db, clock);
  const audit = new AuditLogger(clock);
  const notifications = new NotificationService(db, clock, new LiveBus());
  const people = new PeopleService({ db, clock, events, audit, settings });
  const securityFlags = new SecurityFlagsService({
    db,
    clock,
    events,
    audit,
    settings,
    notifications,
    people,
  });
  securityFlags.init();
  script = {};
  requests = [];
  guidelines = null;
  seq = 0;
  handlers = new Map();
  const orchestrator = {
    async run(req: ClaudeJobRequest): Promise<AIExecutionResult> {
      requests.push(req);
      db.insert(schema.claudeRuns)
        .values({
          id: `run-${requests.length}`,
          jobId: req.jobId ?? null,
          workerProfile: "intelligence",
          status: script.throws ? "failed" : "succeeded",
          startedAt: NOW,
        })
        .run();
      if (script.throws) throw script.throws;
      const finalText =
        script.raw ??
        `\`\`\`json\n${JSON.stringify(
          script.output ?? {
            draft: "Any update on this?",
            confidence: 0.8,
            suspectedInjection: noInj,
          },
        )}\n\`\`\``;
      return {
        finalText,
        permissionDenials: [],
        toolResults: (script.tools ?? []).map((toolName) => ({ toolName })),
      } as unknown as AIExecutionResult;
    },
  };
  registerCommitmentJobs({
    db,
    clock,
    settings,
    scheduler: new SchedulerService(db, clock, queue),
    audit,
    queue,
    orchestrator: orchestrator as never,
    securityFlags,
    store: new CommitmentStore({ db, clock, settings, events }),
    events,
    stall: new StallService({ db, clock, settings, events, queue, notifications }),
    guidelinesFor: () => guidelines,
    handlers,
  });
  settings.set("slack.selfUserId", SELF);
  db.insert(schema.slackUsers).values({ id: "su-self", externalId: SELF, name: "Me" }).run();
  db.insert(schema.slackUsers).values({ id: "su-priya", externalId: PRIYA, name: "Priya" }).run();
  db.insert(schema.slackConversations).values({ id: "c-dm", externalId: "D1", type: "im" }).run();
});

function msg(
  o: {
    from?: "self" | "priya";
    sentAt?: string;
    text?: string | null;
    expired?: boolean;
    thread?: string;
    conv?: string;
  } = {},
) {
  seq += 1;
  const id = `m${seq}`;
  db.insert(schema.slackMessages)
    .values({
      id,
      conversationId: o.conv ?? "c-dm",
      ts: `${1000 + seq}.000000`,
      threadTs: o.thread ?? null,
      senderUserId: o.from === "self" ? "su-self" : "su-priya",
      text: o.text === undefined ? `${SECRET} ${seq}` : o.text,
      sentAt: o.sentAt ?? ago(25),
      contentExpiredAt: o.expired ? NOW : null,
      collectedAt: NOW,
    })
    .run();
  return id;
}

/** A theirs commitment (owner Priya) sourced from `sourceId`. */
function commitment(
  o: Partial<typeof schema.commitments.$inferInsert> & {
    sourceId?: string | null;
    /** The user accepted it through review (default); false is an auto-accepted detection. */
    reviewed?: boolean;
    conv?: string;
  } = {},
) {
  const { sourceId, reviewed = true, conv = "c-dm", ...rest } = o;
  const id = `c${++seq}`;
  db.insert(schema.commitments)
    .values({
      id,
      description: DESC,
      ownerSlackUserId: PRIYA,
      counterpartySlackUserId: SELF,
      direction: "theirs",
      status: "open",
      reviewStatus: "accepted",
      dedupKey: `k${id}`,
      createdAt: ago(26),
      updatedAt: ago(26),
      ...rest,
    })
    .run();
  const src = sourceId === undefined ? undefined : sourceId;
  if (src !== null) {
    db.insert(schema.commitmentSources)
      .values({
        id: `s${id}`,
        commitmentId: id,
        messageId: src ?? null,
        sourceExternalRef: `D1:${id}`,
        conversationId: conv,
        createdAt: ago(26),
      })
      .run();
  }
  if (reviewed) {
    db.insert(schema.commitmentUpdates)
      .values({
        id: `u${id}`,
        commitmentId: id,
        actor: "user",
        field: "review_status",
        fromValue: "pending_review",
        toValue: "accepted",
        createdAt: ago(26),
      })
      .run();
  }
  return id;
}

const call = (type: string, input?: Record<string, unknown>) => {
  const id = db.transaction(
    (tx) => queue.enqueue(tx, { type, idempotencyKey: `${type}${Math.random()}`, input }).id,
  );
  const job = { id, type, attempts: 1, maxAttempts: 3, input: input ?? null } as unknown as Job;
  return handlers.get(type)?.handler(job, ctx) as Promise<Record<string, unknown>>;
};
const get = (id: string) =>
  db.select().from(schema.commitments).where(eq(schema.commitments.id, id)).get() as NonNullable<
    typeof schema.commitments.$inferSelect
  >;
const evs = (type: string) =>
  db.select().from(schema.domainEvents).where(eq(schema.domainEvents.type, type)).all();
const draftJobs = () =>
  db.select().from(schema.jobs).where(eq(schema.jobs.type, "commitments.draft_followup")).all();
const notes = () => db.select().from(schema.notifications).all();
const followups = () => db.select().from(schema.followups).all();

describe("commitments.check_stalled", () => {
  test("no owner message for 25 h: stalled once, one event, one draft job", async () => {
    const src = msg({ from: "self" });
    const id = commitment({ sourceId: src });
    const r = await call("commitments.check_stalled");
    expect(r).toMatchObject({ stalled: 1 });
    const c = get(id);
    expect(c.stalledAt).toBe(NOW);
    expect(evs("commitment.stalled")).toHaveLength(1);
    const jobs = draftJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      idempotencyKey: `commitments.draft:${id}:${NOW}`,
      priority: 70,
      concurrencyGroup: "commitments.intelligence",
    });
    await call("commitments.check_stalled");
    expect(evs("commitment.stalled")).toHaveLength(1);
    expect(draftJobs()).toHaveLength(1);
  });

  test("waits less than waitHours: not stalled", async () => {
    const src = msg({ from: "self", sentAt: ago(5) });
    const id = commitment({ sourceId: src });
    await call("commitments.check_stalled");
    expect(get(id).stalledAt).toBeNull();
  });

  test("an owner message after the source (even with null text) means not stalled", async () => {
    const src = msg({ from: "self", sentAt: ago(30) });
    msg({ from: "priya", sentAt: ago(28), text: null });
    const id = commitment({ sourceId: src });
    await call("commitments.check_stalled");
    expect(get(id).stalledAt).toBeNull();
    expect(evs("commitment.stalled")).toHaveLength(0);
  });

  test("an owner message in another conversation does not count", async () => {
    db.insert(schema.slackConversations)
      .values({ id: "c-x", externalId: "C9", type: "channel" })
      .run();
    const src = msg({ from: "self", sentAt: ago(30) });
    msg({ from: "priya", sentAt: ago(28), conv: "c-x" });
    const id = commitment({ sourceId: src });
    await call("commitments.check_stalled");
    expect(get(id).stalledAt).toBe(NOW);
  });

  test("past due stalls before waitHours; a recent follow-up cools it down", async () => {
    const src = msg({ from: "self", sentAt: ago(2) });
    const a = commitment({ sourceId: src, dueAt: ago(1) });
    const b = commitment({ sourceId: src, dueAt: ago(1), lastFollowupAt: ago(1) });
    await call("commitments.check_stalled");
    expect(get(a).stalledAt).toBe(NOW);
    expect(get(b).stalledAt).toBeNull();
  });

  test("closed, unreviewed, mine and blocked commitments are never stalled", async () => {
    const src = msg({ from: "self" });
    const ids = [
      commitment({ sourceId: src, status: "completed", closedAt: ago(1) }),
      commitment({ sourceId: src, reviewStatus: "pending_review" }),
      commitment({ sourceId: src, direction: "mine" }),
      commitment({ sourceId: src, status: "blocked" }),
    ];
    await call("commitments.check_stalled");
    for (const id of ids) expect(get(id).stalledAt).toBeNull();
  });

  test("an existing stall is skipped; an owner reply after it clears it", async () => {
    const src = msg({ from: "self" });
    const id = commitment({ sourceId: src });
    await call("commitments.check_stalled");
    clock.set(new Date(Date.parse(NOW) + 2 * H));
    await call("commitments.check_stalled");
    expect(get(id).stalledAt).toBe(NOW);
    expect(evs("commitment.stalled")).toHaveLength(1);
    msg({ from: "priya", sentAt: new Date(Date.parse(NOW) + H).toISOString() });
    const r = await call("commitments.check_stalled");
    expect(r).toMatchObject({ cleared: 1, stalled: 0 });
    expect(get(id).stalledAt).toBeNull();
  });

  test("a follow-up sent after the stall clears it and restarts the wait", async () => {
    const src = msg({ from: "self" });
    const id = commitment({ sourceId: src });
    await call("commitments.check_stalled");
    clock.set(new Date(Date.parse(NOW) + 2 * H));
    db.update(schema.commitments)
      .set({ lastFollowupAt: clock.now().toISOString() })
      .where(eq(schema.commitments.id, id))
      .run();
    const r = await call("commitments.check_stalled");
    expect(r).toMatchObject({ cleared: 1, stalled: 0 });
    expect(get(id).stalledAt).toBeNull();
    clock.set(new Date(Date.parse(NOW) + 27 * H));
    await call("commitments.check_stalled");
    expect(get(id).stalledAt).not.toBeNull();
    expect(draftJobs()).toHaveLength(2);
  });

  test("past-due mine commitment emits commitment.overdue once, content-free", async () => {
    const id = commitment({
      direction: "mine",
      ownerSlackUserId: SELF,
      dueAt: ago(1),
      sourceId: null,
    });
    await call("commitments.check_stalled");
    await call("commitments.check_stalled");
    const ev = evs("commitment.overdue");
    expect(ev).toHaveLength(1);
    expect(JSON.stringify(ev[0]?.payload)).toBe(JSON.stringify({ commitmentId: id }));
    const marks = db
      .select()
      .from(schema.commitmentUpdates)
      .where(
        and(
          eq(schema.commitmentUpdates.commitmentId, id),
          eq(schema.commitmentUpdates.field, "overdue_notified"),
        ),
      )
      .all();
    expect(marks).toHaveLength(1);
    expect(JSON.stringify(marks)).not.toContain(DESC);
    expect(draftJobs()).toHaveLength(0);
  });
});

describe("commitments.reminders", () => {
  const mine = (o: Partial<typeof schema.commitments.$inferInsert> = {}) =>
    commitment({
      direction: "mine",
      ownerSlackUserId: SELF,
      counterpartySlackUserId: PRIYA,
      sourceId: null,
      ...o,
    });

  test("notifies once per (commitment, state); no description in the title", async () => {
    const id = mine({ dueAt: new Date(Date.parse(NOW) + 3 * H).toISOString() });
    mine({ dueAt: new Date(Date.parse(NOW) + 72 * H).toISOString() });
    await call("commitments.reminders");
    await call("commitments.reminders");
    expect(notes()).toHaveLength(1);
    expect(notes()[0]).toMatchObject({
      kind: "commitment.reminder",
      severity: "warning",
      title: "Due soon: commitment to Priya",
      ref: `commitment:${id}:due_soon`,
    });
    clock.set(new Date(Date.parse(NOW) + 4 * H));
    await call("commitments.reminders");
    await call("commitments.reminders");
    const all = notes();
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({
      severity: "high",
      title: "Overdue: commitment to Priya",
      ref: `commitment:${id}:overdue`,
    });
    expect(JSON.stringify(all)).not.toContain(DESC);
  });

  test("no counterparty uses the generic title; closed, theirs and unreviewed are skipped", async () => {
    mine({ counterpartySlackUserId: null, dueAt: ago(1) });
    mine({ dueAt: ago(1), status: "completed", closedAt: ago(1) });
    mine({ dueAt: ago(1), reviewStatus: "pending_review" });
    commitment({ dueAt: ago(1), sourceId: null });
    await call("commitments.reminders");
    expect(notes().map((n) => n.title)).toEqual(["Overdue: your commitment"]);
  });
});

describe("commitments.draft_followup", () => {
  async function stalled(
    src: string | null = msg({ from: "self", text: `${SECRET} src` }),
    o: Parameters<typeof commitment>[0] = {},
  ) {
    const id = commitment({ sourceId: src, ...o });
    await call("commitments.check_stalled");
    const job = draftJobs()[0];
    return { id, input: job?.input as Record<string, unknown> };
  }

  test("stores the draft with the guidelines part only in this run; text stays out of trusted parts", async () => {
    guidelines = { name: "Priya SECRETNAME", texts: [GUIDE] };
    const src = msg({ from: "self", thread: "999.000000" });
    msg({ from: "priya", text: `${SECRET} reply`, sentAt: ago(26) });
    const { id, input } = await stalled(src);
    const r = await call("commitments.draft_followup", input);
    expect(r).toMatchObject({ drafted: true, noThread: false });
    const f = followups();
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({
      commitmentId: id,
      origin: "stalled",
      status: "draft",
      conversationId: "c-dm",
      threadTs: "999.000000",
      recipientSlackUserId: PRIYA,
      confidence: 0.8,
      draftText: "Any update on this?",
    });
    expect(evs("followup.draft_created")).toHaveLength(1);
    const req = requests[0] as ClaudeJobRequest & { parts: PromptPart[] };
    expect(req).toMatchObject({
      workerProfile: "intelligence",
      priorityClass: "batch",
      model: "haiku",
      allowedTools: ["ToolSearch"],
      maxTurns: 3,
    });
    const kinds = req.parts.map((p) => p.provenance);
    expect(kinds.slice(0, 3)).toEqual(["system", "user_approved", "user_approved"]);
    expect(kinds.slice(3).every((k) => k === "untrusted")).toBe(true);
    const trusted = req.parts.filter((p) => p.provenance !== "untrusted");
    expect(trusted[1]?.content).toContain(DESC);
    expect(trusted[2]?.content).toContain(GUIDE);
    const trustedText = JSON.stringify(trusted) + req.instructions;
    expect(trustedText).not.toContain("SECRETNAME");
    expect(trustedText).not.toContain("Priya");
    expect(trustedText).not.toContain(SECRET);
  });

  test("no guidelines part when the recipient has none; context is capped at 10 untrusted parts", async () => {
    const src = msg({ from: "self" });
    for (let i = 0; i < 14; i++) msg({ from: "priya", sentAt: ago(26 + i) });
    const { input } = await stalled(src);
    await call("commitments.draft_followup", input);
    const req = requests[0] as ClaudeJobRequest & { parts: PromptPart[] };
    expect(req.parts.map((p) => p.provenance).slice(0, 3)).toEqual([
      "system",
      "user_approved",
      "untrusted",
    ]);
    expect(req.parts.filter((p) => p.provenance === "untrusted")).toHaveLength(10);
  });

  test("an expired source: conversation kept, no thread, noThread recorded, expired text never sent", async () => {
    const src = msg({ from: "self", expired: true, text: null });
    const { input } = await stalled(src);
    const r = await call("commitments.draft_followup", input);
    expect(r).toMatchObject({ drafted: true, noThread: true });
    const f = followups()[0];
    expect(f).toMatchObject({ conversationId: "c-dm", threadTs: null });
    const history = db.select().from(schema.followupHistory).all();
    expect(history.map((h) => [h.event, h.detail])).toContainEqual(["noThread", "no_thread"]);
  });

  test("a source whose message row is gone still drafts into the conversation", async () => {
    const id = commitment({ sourceId: null });
    db.insert(schema.commitmentSources)
      .values({
        id: "s-gone",
        commitmentId: id,
        messageId: null,
        sourceExternalRef: "D1:gone",
        conversationId: "c-dm",
        createdAt: ago(26),
      })
      .run();
    await call("commitments.check_stalled");
    const r = await call("commitments.draft_followup", draftJobs()[0]?.input as never);
    expect(r).toMatchObject({ drafted: true, noThread: true });
  });

  test("skips a pending_review, closed, unstalled or already-drafted commitment without running", async () => {
    const src = msg({ from: "self" });
    const { id, input } = await stalled(src);
    db.update(schema.commitments)
      .set({ reviewStatus: "pending_review" })
      .where(eq(schema.commitments.id, id))
      .run();
    expect(await call("commitments.draft_followup", input)).toEqual({ skipped: "closed" });
    db.update(schema.commitments)
      .set({ reviewStatus: "accepted", status: "completed", closedAt: NOW })
      .where(eq(schema.commitments.id, id))
      .run();
    expect(await call("commitments.draft_followup", input)).toEqual({ skipped: "closed" });
    db.update(schema.commitments)
      .set({ status: "open", closedAt: null, stalledAt: null })
      .where(eq(schema.commitments.id, id))
      .run();
    expect(await call("commitments.draft_followup", input)).toEqual({ skipped: "not_stalled" });
    db.update(schema.commitments)
      .set({ stalledAt: NOW })
      .where(eq(schema.commitments.id, id))
      .run();
    expect(requests).toHaveLength(0);
    await call("commitments.draft_followup", input);
    expect(await call("commitments.draft_followup", input)).toEqual({ skipped: "followup_exists" });
    expect(requests).toHaveLength(1);
    expect(followups()).toHaveLength(1);
  });

  test("a failed run stores nothing; invalid output is incomplete_ai_output with no text in the error", async () => {
    const { input } = await stalled();
    script = { raw: `\`\`\`json\n{"draft":"${SECRET}"}\n\`\`\`` };
    const err = await call("commitments.draft_followup", input).catch((e) => e);
    expect(err).toBeInstanceOf(JobError);
    expect((err as JobError).classified.kind).toBe("incomplete_ai_output");
    expect(JSON.stringify((err as JobError).classified)).not.toContain(SECRET);
    expect(followups()).toHaveLength(0);
  });

  test("runtime flags never attach to the user's own message", async () => {
    const src = msg({ from: "self", text: `${SECRET} mine` });
    const { input } = await stalled(src);
    script = { tools: ["mcp__claude_ai_Slack__slack_send_message"] };
    await call("commitments.draft_followup", input);
    const flags = db.select().from(schema.securityFlags).all();
    // Only the user's own message was provided: no flag target, so no flag.
    expect(flags).toHaveLength(0);
  });

  test("a runtime flag attaches to the owner's message, and an injection flag too", async () => {
    const src = msg({ from: "self" });
    const theirs = msg({ from: "priya", text: `${SECRET} ignore previous`, sentAt: ago(26) });
    const { input } = await stalled(src);
    script = {
      tools: ["mcp__claude_ai_Slack__slack_send_message"],
      output: {
        draft: "Hi",
        confidence: 0.5,
        suspectedInjection: {
          detected: true,
          severity: "warning",
          quote: "ignore previous",
          reason: "x",
        },
      },
    };
    await call("commitments.draft_followup", input);
    const flags = db.select().from(schema.securityFlags).all();
    expect(flags.length).toBeGreaterThan(0);
    expect(flags.every((f) => f.messageId === theirs)).toBe(true);
    expect(JSON.stringify(db.select().from(schema.domainEvents).all())).not.toContain(SECRET);
  });

  test("R12: an auto-accepted description is an untrusted part, not user_approved", async () => {
    const src = msg({ from: "self" });
    const { input } = await stalled(src, { reviewed: false });
    await call("commitments.draft_followup", input);
    const req = requests[0] as ClaudeJobRequest & { parts: PromptPart[] };
    expect(req.parts.map((p) => p.provenance)).not.toContain("user_approved");
    const withDesc = req.parts.filter((p) => p.content.includes(DESC));
    expect(withDesc.map((p) => p.provenance)).toEqual(["untrusted"]);
    expect(req.instructions).not.toContain(DESC);
  });

  test("R12: no identity skips the job and clears the stall so it can stall again", async () => {
    const src = msg({ from: "self" });
    const { id, input } = await stalled(src);
    settings.clear("slack.selfUserId");
    expect(await call("commitments.draft_followup", input)).toEqual({ skipped: "no_identity" });
    expect(get(id).stalledAt).toBeNull();
    expect(requests).toHaveLength(0);
    settings.set("slack.selfUserId", SELF);
    clock.set(new Date(Date.parse(NOW) + H));
    await call("commitments.check_stalled");
    expect(get(id).stalledAt).not.toBeNull();
    expect(
      draftJobs().filter((j) => j.idempotencyKey.startsWith("commitments.draft:")),
    ).toHaveLength(2);
  });

  test("a job for an older stall is skipped when the commitment re-stalled since", async () => {
    const src = msg({ from: "self" });
    const { id, input } = await stalled(src);
    db.update(schema.commitments)
      .set({ stalledAt: new Date(Date.parse(NOW) + H).toISOString() })
      .where(eq(schema.commitments.id, id))
      .run();
    expect(await call("commitments.draft_followup", input)).toEqual({ skipped: "not_stalled" });
    expect(requests).toHaveLength(0);
    expect(followups()).toHaveLength(0);
  });

  describe("R11 thread placement", () => {
    const draftThread = async (src: string, o: Parameters<typeof commitment>[0] = {}) => {
      const { input } = await stalled(src, o);
      const r = await call("commitments.draft_followup", input);
      expect(r).toMatchObject({ drafted: true, noThread: false });
      return followups()[0]?.threadTs;
    };

    test("DM, top-level source: top-level follow-up (not noThread)", async () => {
      expect(await draftThread(msg({ from: "self" }))).toBeNull();
      const history = db.select().from(schema.followupHistory).all();
      expect(history.map((h) => h.event)).not.toContain("noThread");
    });

    test("DM, thread-reply source: that thread", async () => {
      expect(await draftThread(msg({ from: "self", thread: "555.000000" }))).toBe("555.000000");
    });

    test("channel: threads under the source ts, or its thread", async () => {
      db.insert(schema.slackConversations)
        .values({ id: "c-ch", externalId: "C1", type: "channel", name: "x" })
        .run();
      const src = msg({ from: "self", conv: "c-ch" });
      const ts = db
        .select()
        .from(schema.slackMessages)
        .where(eq(schema.slackMessages.id, src))
        .get()?.ts;
      expect(await draftThread(src, { conv: "c-ch" })).toBe(ts as string);
    });
  });
});

describe("commitments.draft_followup manual (Task 9)", () => {
  const manual = (id: string) => ({ commitmentId: id, manual: true, origin: "manual" });

  test("a manual request drafts an unstalled commitment with origin manual", async () => {
    const id = commitment({ sourceId: msg({ from: "self" }), stalledAt: null });
    const r = await call("commitments.draft_followup", manual(id));
    expect(r).toMatchObject({ drafted: true });
    expect(followups()[0]).toMatchObject({ commitmentId: id, origin: "manual", status: "draft" });
    const h = db.select().from(schema.followupHistory).all();
    expect(h.map((x) => x.detail)).toContain("manual");
  });

  test("manual still skips a closed commitment and an existing live follow-up", async () => {
    const id = commitment({ sourceId: msg({ from: "self" }), stalledAt: null });
    await call("commitments.draft_followup", manual(id));
    expect(await call("commitments.draft_followup", manual(id))).toEqual({
      skipped: "followup_exists",
    });
    db.update(schema.followups).set({ status: "discarded" }).run();
    db.update(schema.commitments)
      .set({ status: "cancelled", closedAt: NOW })
      .where(eq(schema.commitments.id, id))
      .run();
    expect(await call("commitments.draft_followup", manual(id))).toEqual({ skipped: "closed" });
    expect(requests).toHaveLength(1);
  });

  test("without the manual flag an unstalled commitment is still skipped", async () => {
    const id = commitment({ sourceId: msg({ from: "self" }), stalledAt: null });
    expect(
      await call("commitments.draft_followup", { commitmentId: id, origin: "manual" }),
    ).toEqual({ skipped: "not_stalled" });
  });
});
