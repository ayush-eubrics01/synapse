import { beforeEach, describe, expect, test } from "bun:test";
import {
  type AIExecutionResult,
  type ClaudeJobRequest,
  type DomainEvent,
  type EventType,
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
import { ExtractionQueue } from "../../src/modules/commitments/extraction-queue";
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
const unclear = {
  clear: false,
  missing: ["steps", "environment"],
  questions: ["What steps reproduce it?", "Which environment is it on?"],
  suspectedInjection: { detected: false, severity: "info", quote: "", reason: "" },
};
const noInj = { detected: false, severity: "info", quote: "", reason: "" };

let db: ReturnType<typeof openDatabase>["db"];
let queue: JobQueue;
let clock: FakeClock;
let settings: SettingsService;
let handlers: Map<string, HandlerRegistration>;
let requests: ClaudeJobRequest[];
let script: { output?: unknown; raw?: string; throws?: Error; tools?: string[] };
let seq: number;
let extractionQueue: ExtractionQueue;

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
        script.raw ?? `\`\`\`json\n${JSON.stringify(script.output ?? unclear)}\n\`\`\``;
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
    handlers,
  });
  extractionQueue = new ExtractionQueue({ db, clock, settings, queue });
  settings.set("slack.selfUserId", SELF);
  db.insert(schema.slackUsers).values({ id: "su-self", externalId: SELF, name: "Me" }).run();
  db.insert(schema.slackUsers).values({ id: "su-priya", externalId: PRIYA, name: "Priya" }).run();
  db.insert(schema.slackConversations).values({ id: "c-dm", externalId: "D1", type: "im" }).run();
  db.insert(schema.slackConversations)
    .values({ id: "c-ch", externalId: "C1", type: "channel" })
    .run();
  db.insert(schema.slackConversations).values({ id: "c-mp", externalId: "G1", type: "mpim" }).run();
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
      sentAt: o.sentAt ?? ago(1),
      contentExpiredAt: o.expired ? NOW : null,
      collectedAt: NOW,
    })
    .run();
  return id;
}

const REQUEST = "the nightly export is broken and I need you to take a look at it today";
const JOB = "commitments.check_spec_clarity";

const spec = (messageId: string, attempts = 1) => {
  const id = db.transaction(
    (tx) =>
      queue.enqueue(tx, {
        type: JOB,
        idempotencyKey: `${JOB}${Math.random()}`,
        input: { messageId },
      }).id,
  );
  const job = { id, type: JOB, attempts, maxAttempts: 3, input: { messageId } } as unknown as Job;
  return handlers.get(JOB)?.handler(job, ctx) as Promise<Record<string, unknown>>;
};
const considered = (messageId: string) =>
  db.transaction((tx) =>
    extractionQueue.handle(
      {
        type: "message.received",
        payload: { messageId },
        correlationId: "c",
      } as DomainEvent<EventType>,
      tx,
    ),
  );
const specJobs = () =>
  db
    .select()
    .from(schema.jobs)
    .all()
    .filter((j) => j.type === JOB && j.idempotencyKey.startsWith("commitments.spec:"));
const followups = () => db.select().from(schema.followups).all();
const history = () => db.select().from(schema.followupHistory).all();
const evs = (type: string) =>
  db.select().from(schema.domainEvents).where(eq(schema.domainEvents.type, type)).all();
const promptOf = (i = 0) =>
  (requests[i]?.parts ?? []).map((p: PromptPart) => `${p.provenance}|${p.content}`);

describe("commitments.check_spec_clarity handler", () => {
  test("unclear request: numbered draft, DM top-level, history and event carry no text", async () => {
    const id = msg({ text: REQUEST });
    const r = await spec(id);
    expect(r).toMatchObject({ drafted: true, questions: 2 });
    const f = followups();
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({
      origin: "spec_clarity",
      originMessageId: id,
      conversationId: "c-dm",
      threadTs: null,
      recipientSlackUserId: PRIYA,
      status: "draft",
      confidence: null,
      commitmentId: null,
    });
    expect(f[0]?.draftText).toBe(
      "A few questions so I can pick this up:\n1. What steps reproduce it?\n2. Which environment is it on?",
    );
    expect(history().map((h) => [h.event, h.detail])).toEqual([
      ["clarity_missing", "steps,environment"],
    ]);
    expect(evs("followup.draft_created")).toHaveLength(1);
    expect(JSON.stringify(evs("followup.draft_created"))).not.toContain(SECRET);
    expect(JSON.stringify(db.select().from(schema.auditEvents).all())).not.toContain("What steps");
    expect(requests[0]).toMatchObject({
      allowedTools: ["ToolSearch"],
      maxTurns: 3,
      model: "haiku",
    });
  });

  test("channel request threads under it; a DM thread reply stays in its thread; mpim threads", async () => {
    const ch = msg({ conv: "c-ch", text: `<@${SELF}> ${REQUEST}` });
    await spec(ch);
    expect(followups()[0]?.threadTs).toBe("1001.000000");
    const mp = msg({ conv: "c-mp", text: REQUEST });
    await spec(mp);
    expect(followups().find((f) => f.originMessageId === mp)?.threadTs).toBe("1002.000000");
    const dm = msg({ text: REQUEST, thread: "999.000000" });
    await spec(dm);
    expect(followups().find((f) => f.originMessageId === dm)?.threadTs).toBe("999.000000");
  });

  test("clear request stores nothing", async () => {
    script.output = { ...unclear, clear: true, missing: [], questions: [] };
    expect(await spec(msg({ text: REQUEST }))).toMatchObject({ clear: true });
    expect(followups()).toHaveLength(0);
    expect(history()).toHaveLength(0);
  });

  test("clear=false with no questions stores nothing", async () => {
    script.output = { ...unclear, questions: [] };
    await spec(msg({ text: REQUEST }));
    expect(followups()).toHaveLength(0);
  });

  test("never a second spec followup for the same message, even once discarded", async () => {
    const id = msg({ text: REQUEST });
    await spec(id);
    db.update(schema.followups).set({ status: "discarded" }).run();
    expect(await spec(id)).toEqual({ skipped: "followup_exists" });
    expect(requests).toHaveLength(1);
    expect(followups()).toHaveLength(1);
  });

  test("R13: the handler skips without a run when the user posted after the request", async () => {
    const a = msg({ text: REQUEST, sentAt: ago(5) });
    msg({ from: "self", text: "on it", sentAt: ago(4) });
    expect(await spec(a)).toEqual({ skipped: "answered" });
    expect(requests).toHaveLength(0);
    // Threaded: a self reply in another thread does not count; one in this thread does.
    const t = msg({ conv: "c-ch", text: REQUEST, thread: "50.0", sentAt: ago(5) });
    msg({ conv: "c-ch", from: "self", text: "elsewhere", thread: "60.0", sentAt: ago(4) });
    expect(await spec(t)).toMatchObject({ drafted: true });
    const t2 = msg({ conv: "c-ch", text: REQUEST, thread: "51.0", sentAt: ago(5) });
    msg({ conv: "c-ch", from: "self", text: "here", thread: "51.0", sentAt: ago(4) });
    expect(await spec(t2)).toEqual({ skipped: "answered" });
    // A self message before the request does not count.
    const b = msg({ conv: "c-mp", from: "self", text: "earlier", sentAt: ago(9) });
    expect(b).toBeTruthy();
    expect(await spec(msg({ conv: "c-mp", text: REQUEST, sentAt: ago(8) }))).toMatchObject({
      drafted: true,
    });
  });

  test("context: up to 5 earlier conversation messages, oldest first, untrusted, target last", async () => {
    for (let i = 0; i < 7; i++) msg({ from: i % 2 ? "self" : "priya", sentAt: ago(30 - i) });
    msg({ expired: true, sentAt: ago(24.5) });
    const id = msg({ text: REQUEST, sentAt: ago(20) });
    msg({ sentAt: ago(19) }); // later: never context
    await spec(id);
    const parts = requests[0]?.parts ?? [];
    expect(parts[0]?.provenance).toBe("system");
    const rest = parts.slice(1);
    expect(rest).toHaveLength(6);
    expect(rest.every((p) => p.provenance === "untrusted")).toBe(true);
    expect(rest[5]?.content).toBe(REQUEST);
    expect(rest[0]?.source).toContain("slack message m3 ");
  });

  test("context of a thread request is that thread only", async () => {
    msg({ conv: "c-ch", text: "unrelated channel chatter" });
    const root = msg({ conv: "c-ch", text: "root of the thread" }); // ts 1002.000000
    msg({ conv: "c-ch", text: "in another thread", thread: "5.000000" });
    msg({ conv: "c-ch", text: "thread reply one", thread: "1002.000000" });
    const id = msg({ conv: "c-ch", text: `<@${SELF}> ${REQUEST}`, thread: "1002.000000" });
    await spec(id);
    const texts = (requests[0]?.parts ?? []).slice(1).map((p) => p.content);
    expect(texts).toEqual(["root of the thread", "thread reply one", `<@${SELF}> ${REQUEST}`]);
    expect(root).toBeTruthy();
    expect(followups()[0]?.threadTs).toBe("1002.000000");
  });

  test("the request is untrusted; no message text leaves the untrusted parts", async () => {
    await spec(msg({ text: REQUEST }));
    const trusted = (requests[0]?.parts ?? []).filter((p) => p.provenance !== "untrusted");
    expect(JSON.stringify(trusted)).not.toContain("nightly export");
    expect(requests[0]?.instructions).not.toContain("nightly export");
  });

  test("a message from self, expired text or a missing identity is skipped without a run", async () => {
    expect(await spec(msg({ from: "self", text: REQUEST }))).toEqual({ skipped: "ineligible" });
    expect(await spec(msg({ text: REQUEST, expired: true }))).toEqual({ skipped: "ineligible" });
    expect(await spec("nope")).toEqual({ skipped: "ineligible" });
    settings.clear("slack.selfUserId");
    expect(await spec(msg({ text: REQUEST }))).toEqual({ skipped: "no_identity" });
    expect(requests).toHaveLength(0);
  });

  test("questions are capped at 300 chars and the draft at 4000", async () => {
    script.raw = `\`\`\`json\n${JSON.stringify({ ...unclear, questions: Array(5).fill("q".repeat(300)) })}\n\`\`\``;
    await spec(msg({ text: REQUEST }));
    const d = followups()[0]?.draftText as string;
    expect(d.length).toBeLessThanOrEqual(4000);
    expect(d.split("\n")).toHaveLength(6);
  });

  test("a hidden character in a question is escaped", async () => {
    script.output = { ...unclear, questions: ["Which\u202Eone?"] };
    await spec(msg({ text: REQUEST }));
    expect(followups()[0]?.draftText).toContain("\\u{202E}");
  });

  test("suspected injection is flagged on the sender's message, never self", async () => {
    script.output = {
      ...unclear,
      suspectedInjection: {
        detected: true,
        severity: "high",
        quote: "nightly export",
        reason: "x",
      },
    };
    const id = msg({ text: REQUEST });
    await spec(id);
    const flags = db.select().from(schema.securityFlags).all();
    expect(flags).toHaveLength(1);
    expect(flags[0]?.messageId).toBe(id);
  });

  test("invalid output fails as incomplete_ai_output and stores nothing", async () => {
    script.raw = "no json here";
    const err = await spec(msg({ text: REQUEST })).catch((e) => e);
    expect(err).toBeInstanceOf(JobError);
    expect((err as JobError).classified.kind).toBe("incomplete_ai_output");
    expect(followups()).toHaveLength(0);
    expect(String((err as Error).message)).not.toContain("nightly");
  });

  test("a failed run is classified without text in lastError", async () => {
    script.throws = new JobError({ kind: "provider_error", message: "claude down" });
    const err = await spec(msg({ text: REQUEST })).catch((e) => e);
    expect(err).toBeInstanceOf(JobError);
    expect(followups()).toHaveLength(0);
  });
});

describe("commitments.queue consumer: spec clarity trigger", () => {
  test("a DM request queues one job with its key, priority, group and message id", () => {
    const id = msg({ text: REQUEST });
    considered(id);
    considered(id);
    const jobs = specJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      idempotencyKey: `commitments.spec:${id}`,
      priority: 45,
      concurrencyGroup: "commitments.intelligence",
    });
    expect(jobs[0]?.input).toEqual({ messageId: id, senderRef: PRIYA });
    expect(handlers.get(JOB)?.timeoutMs).toBe(420_000);
  });

  test("a channel message needs a mention of the user (raw or escaped)", () => {
    considered(msg({ conv: "c-ch", text: REQUEST }));
    expect(specJobs()).toHaveLength(0);
    considered(msg({ conv: "c-ch", text: `<@${SELF}> ${REQUEST}` }));
    considered(msg({ conv: "c-ch", text: `&lt;@${SELF}&gt; ${REQUEST}` }));
    expect(specJobs()).toHaveLength(2);
  });

  test("a message from self, a short message or a non-request does not trigger", () => {
    considered(msg({ from: "self", text: REQUEST }));
    considered(msg({ text: "please fix the export now" }));
    considered(msg({ text: "the weather is lovely and I had a great weekend with family" }));
    expect(specJobs()).toHaveLength(0);
  });

  test("the regex is case-insensitive and word-bounded", () => {
    considered(msg({ text: "PLEASE look into why the nightly export keeps timing out for us" }));
    expect(specJobs()).toHaveLength(1);
    considered(
      msg({ text: "the prefixes and additions in the nightly export look odd to everyone" }),
    );
    expect(specJobs()).toHaveLength(1);
  });

  test("old, expired, text-less messages and a missing identity do not trigger", () => {
    considered(msg({ text: REQUEST, sentAt: "2026-06-01T00:00:00.000Z" }));
    considered(msg({ text: REQUEST, expired: true }));
    considered(msg({ text: null }));
    expect(specJobs()).toHaveLength(0);
    settings.clear("slack.selfUserId");
    considered(msg({ text: REQUEST }));
    expect(specJobs()).toHaveLength(0);
  });

  test("R13: older than maxAgeHours does not trigger; the setting widens it", () => {
    considered(msg({ text: REQUEST, sentAt: ago(30) }));
    expect(specJobs()).toHaveLength(0);
    settings.set("commitments.spec.maxAgeHours", 48);
    considered(msg({ text: REQUEST, sentAt: ago(30) }));
    expect(specJobs()).toHaveLength(1);
  });

  test("R13: a bot sender does not trigger", () => {
    db.update(schema.slackUsers)
      .set({ isBot: true })
      .where(eq(schema.slackUsers.id, "su-priya"))
      .run();
    considered(msg({ text: REQUEST }));
    expect(specJobs()).toHaveLength(0);
  });

  test("R13: an open spec followup in the same thread blocks; discarded or other thread does not", async () => {
    const first = msg({ conv: "c-ch", text: `<@${SELF}> ${REQUEST}` });
    await spec(first); // thread = its ts
    const root = followups()[0]?.threadTs as string;
    considered(msg({ conv: "c-ch", text: `<@${SELF}> ${REQUEST}`, thread: root, sentAt: ago(2) }));
    expect(specJobs()).toHaveLength(0);
    considered(
      msg({ conv: "c-ch", text: `<@${SELF}> ${REQUEST}`, thread: "77.0", sentAt: ago(2) }),
    );
    expect(specJobs()).toHaveLength(1);
    db.update(schema.followups).set({ status: "discarded" }).run();
    considered(msg({ conv: "c-ch", text: `<@${SELF}> ${REQUEST}`, thread: root, sentAt: ago(1) }));
    expect(specJobs()).toHaveLength(2);
  });

  test("R13: an unthreaded message is blocked by any open spec followup in its conversation", async () => {
    await spec(msg({ text: REQUEST }));
    considered(msg({ text: REQUEST }));
    expect(specJobs()).toHaveLength(0);
    for (const status of ["awaiting_approval", "sending", "needs_attention"] as const) {
      db.update(schema.followups).set({ status }).run();
      considered(msg({ text: REQUEST }));
      expect(specJobs()).toHaveLength(0);
    }
    db.update(schema.followups).set({ status: "sent" }).run();
    considered(msg({ text: REQUEST }));
    expect(specJobs()).toHaveLength(1);
  });

  test("R13: per-sender daily cap counts spec jobs enqueued today", () => {
    settings.set("commitments.spec.maxPerSenderPerDay", 2);
    for (let i = 0; i < 3; i++) considered(msg({ text: REQUEST }));
    expect(specJobs()).toHaveLength(2);
    // Another sender is unaffected.
    db.insert(schema.slackUsers).values({ id: "su-o", externalId: "UOTHER0001", name: "O" }).run();
    const id = msg({ conv: "c-ch", text: `<@${SELF}> ${REQUEST}` });
    db.update(schema.slackMessages)
      .set({ senderUserId: "su-o" })
      .where(eq(schema.slackMessages.id, id))
      .run();
    considered(id);
    expect(specJobs()).toHaveLength(3);
    // Yesterday's jobs do not count.
    db.update(schema.jobs).set({ createdAt: "2026-11-04T10:00:00.000Z" }).run();
    considered(msg({ text: REQUEST }));
    expect(specJobs()).toHaveLength(4);
  });

  test("an already-extracted message still gets its clarity check, and extraction is still queued otherwise", () => {
    const id = msg({ text: REQUEST });
    db.update(schema.slackMessages)
      .set({ commitmentsExtractedAt: NOW })
      .where(eq(schema.slackMessages.id, id))
      .run();
    considered(id);
    expect(specJobs()).toHaveLength(1);
    const id2 = msg({ text: REQUEST });
    considered(id2);
    expect(
      db
        .select()
        .from(schema.jobs)
        .all()
        .filter((j) => j.type === "commitments.extract"),
    ).toHaveLength(1);
  });
});
