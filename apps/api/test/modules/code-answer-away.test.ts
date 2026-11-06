import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AIExecutionResult,
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
import type { HandlerRegistration } from "../../src/core/jobs/worker";
import { withAutoReplyTag } from "../../src/modules/auto-reply/policy";
import { AUTOREPLY_EVALUATE_JOB, AutoReplyService } from "../../src/modules/auto-reply/service";
import { matchRepository } from "../../src/modules/code-answers/away-trigger";
import { CODE_ANSWER_JOB } from "../../src/modules/code-answers/service";
import { AutoSendBlocked } from "../../src/modules/outgoing/service";
import { tempDir } from "../fixtures/git-repo";

const NOW = "2026-11-06T12:00:00.000Z";
const MIN = 60_000;
const H = 60 * MIN;
const SELF = "USELF00001";
const PRIO = "UPRIO00001";
const NORM = "UNORM00001";
const DM = "D0PRIO0001";
const QUESTION = "QUESTION-MARKER How does demo-app retry jobs?";
const ANSWER = "The worker retries three times.";
const ctx = {
  signal: new AbortController().signal,
  checkpoint() {},
  getCheckpoint: () => undefined,
} as never;

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

const roots: string[] = [];
afterAll(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

let c: Container;
let clock: FakeClock;
let sink: FakeSink;
let appRoot: string;
let seq: number;

beforeEach(() => {
  clock = new FakeClock(NOW);
  sink = new FakeSink();
  seq = 0;
  c = createContainer(loadConfig({ SYNAPSE_DB_PATH: ":memory:" }), {
    run: async () => "Linger=yes",
    provider: fakeProvider,
    sink,
    clock,
  });
  c.settings.set("slack.selfUserId", SELF);
  const parent = tempDir();
  roots.push(parent);
  appRoot = join(parent, "demo-app");
  mkdirSync(join(appRoot, "src"), { recursive: true });
  writeFileSync(join(appRoot, "src/a.ts"), "export {};\n");
  const apiRoot = join(parent, "demo-api");
  mkdirSync(apiRoot);
  c.db
    .insert(schema.repositories)
    .values(
      [
        ["repo-app", "demo-app", appRoot],
        ["repo-api", "demo-api", apiRoot],
      ].map(([id, name, localPath]) => ({
        id: id as string,
        name: name as string,
        localPath: localPath as string,
        upstreamPushDisabled: true,
        trackedBranch: "main",
        jiraProjectKeys: [],
        createdAt: NOW,
        updatedAt: NOW,
      })),
    )
    .run();
  c.db
    .insert(schema.projects)
    .values({ id: "proj-1", name: "Demo Project", createdAt: NOW, updatedAt: NOW })
    .run();
  c.db
    .insert(schema.projectRepositories)
    .values({ projectId: "proj-1", repositoryId: "repo-app" })
    .run();
  c.db
    .insert(schema.slackUsers)
    .values([
      { id: "u-self", externalId: SELF, name: "Me" },
      { id: "u-prio", externalId: PRIO, name: "Pat" },
      { id: "u-norm", externalId: NORM, name: "Sam" },
    ])
    .run();
  c.db
    .insert(schema.slackConversations)
    .values([
      { id: "c-dm", externalId: DM, type: "im" },
      { id: "c-dm2", externalId: "D0NORM0001", type: "im" },
      { id: "c-ch", externalId: "C0CHAN0001", type: "channel", name: "dev" },
    ])
    .run();
  c.people.setPriority(PRIO, { priority: "high" });
  c.autoReply.setAway(true);
});
afterEach(() => c.sqlite.close());

function addMessage(
  over: { text?: string; sender?: string; conv?: string; sentAt?: string } = {},
): { id: string; ts: string } {
  seq += 1;
  const id = `m${seq}`;
  const ts = `${1793880000 + seq}.000100`;
  c.db
    .insert(schema.slackMessages)
    .values({
      id,
      conversationId: over.conv ?? "c-dm",
      ts,
      senderUserId: over.sender ?? "u-prio",
      text: over.text ?? QUESTION,
      sentAt: over.sentAt ?? clock.now().toISOString(),
      collectedAt: clock.now().toISOString(),
    })
    .run();
  return { id, ts };
}

function deliver(messageId: string): void {
  c.db.transaction((tx) =>
    c.events.publish(tx, {
      type: "message.received",
      aggregateType: "slack_message",
      aggregateId: messageId,
      correlationId: newId(),
      payload: { messageId },
    }),
  );
  c.dispatcher.dispatchOnce();
}

function receive(over: Parameters<typeof addMessage>[0] = {}): string {
  const m = addMessage(over);
  deliver(m.id);
  return m.id;
}

const rows = () => c.db.select().from(schema.codeAnswers).all();
const row = (id: string) =>
  c.db.select().from(schema.codeAnswers).where(eq(schema.codeAnswers.id, id)).get();
const answerJobs = () =>
  c.db
    .select()
    .from(schema.jobs)
    .all()
    .filter((j) => j.type === CODE_ANSWER_JOB);
const autoReplyJobs = () =>
  c.db
    .select()
    .from(schema.jobs)
    .all()
    .filter((j) => j.type === AUTOREPLY_EVALUATE_JOB);
const allAr = () => c.db.select().from(schema.autoReplies).all();
const approvals = () => c.db.select().from(schema.approvals).all();
const outgoing = () => c.db.select().from(schema.outgoingMessages).all();

describe("matchRepository (Review Focus 4)", () => {
  const repos = [
    { id: "repo-app", name: "demo-app" },
    { id: "repo-api", name: "demo-api" },
  ];
  const projects = [{ name: "Demo Project", repositoryIds: ["repo-app"] }];
  test.each([
    ["Does demo-app retry?", "repo-app"],
    ["DEMO-APP?", "repo-app"],
    ["rapid demo-apps?", null],
    ["demo-app or demo-api?", null],
    ["In Demo Project, how are jobs retried?", "repo-app"],
    ["demo-app and Demo Project?", "repo-app"],
    ["demo-app, demo-app again?", "repo-app"],
    ["How does it retry?", null],
    // Fix round 1: '-' and '_' are name characters.
    ["Does demo-app-two retry?", null],
    ["Is demo_app_x used?", null],
    ["Tell me about demo-app.", "repo-app"],
    ["Is it in (demo-app)?", "repo-app"],
  ])("%p -> %p", (text, expected) => {
    expect(matchRepository(text, repos, projects)).toBe(expected);
  });

  test("a name inside a longer word does not match (api in rapid)", () => {
    const r = [{ id: "r-api", name: "api" }];
    expect(matchRepository("rapid deploys?", r, [])).toBeNull();
    expect(matchRepository("is the_api up?", r, [])).toBeNull();
    expect(matchRepository("is the api up?", r, [])).toBe("r-api");
  });

  test("regex metacharacters match literally", () => {
    expect(matchRepository("demoXapp?", [{ id: "r-dot", name: "demo.app" }], [])).toBeNull();
    expect(matchRepository("demo.app?", [{ id: "r-dot", name: "demo.app" }], [])).toBe("r-dot");
    expect(matchRepository("is c++ used?", [{ id: "r-cpp", name: "c++" }], [])).toBe("r-cpp");
    expect(matchRepository("is cc used?", [{ id: "r-cpp", name: "c++" }], [])).toBeNull();
  });

  test("a project counts only when it links exactly one repository", () => {
    const two = [{ name: "Big Project", repositoryIds: ["repo-app", "repo-api"] }];
    expect(matchRepository("In Big Project?", repos, two)).toBeNull();
    const dup = [{ name: "Demo Project", repositoryIds: ["repo-app", "repo-app"] }];
    expect(matchRepository("In Demo Project?", repos, dup)).toBe("repo-app");
  });
});

describe("away trigger (C6)", () => {
  test("a priority sender's DM question naming one repository queues one away row and job", () => {
    const id = receive();
    expect(rows().map((r) => [r.messageId, r.repositoryId, r.trigger, r.status])).toEqual([
      [id, "repo-app", "away", "queued"],
    ]);
    expect(answerJobs()).toHaveLength(1);
    expect(allAr()).toHaveLength(0);
  });

  test("a repository named through its project counts", () => {
    receive({ text: "Where does Demo Project keep its config?" });
    expect(rows().map((r) => r.repositoryId)).toEqual(["repo-app"]);
  });

  test.each([
    ["no question mark", { text: "Tell me how demo-app retries jobs" }],
    ["a normal-priority sender", { sender: "u-norm", conv: "c-dm2" }],
    ["no repository named", { text: "How do retries work?" }],
    ["two repositories named", { text: "Does demo-app call demo-api?" }],
    ["a message before the session", { sentAt: new Date(Date.parse(NOW) - H).toISOString() }],
    ["a channel message not addressed to the user", { conv: "c-ch" }],
  ])("%s -> nothing", (_name, over) => {
    receive(over);
    expect(rows()).toHaveLength(0);
    expect(answerJobs()).toHaveLength(0);
    expect(allAr()).toHaveLength(0);
  });

  test("a message the user already answered -> nothing", () => {
    const m = addMessage();
    clock.advance(MIN);
    addMessage({ sender: "u-self", text: "on it" });
    deliver(m.id);
    expect(rows()).toHaveLength(0);
  });

  test("an incoming message carrying the auto-reply tag spends no run or cap slot", () => {
    receive({ text: "How does demo-app retry?\n\nSent using @claude" });
    receive({ text: "How does demo-app retry? sent  USING @Claude" });
    expect(rows()).toHaveLength(0);
    expect(answerJobs()).toHaveLength(0);
  });

  test("codeAnswer.away.enabled false -> nothing", () => {
    c.settings.set("codeAnswer.away.enabled", false);
    receive();
    expect(rows()).toHaveLength(0);
    expect(answerJobs()).toHaveLength(0);
  });

  test("code_answer removed from allowedKinds -> nothing", () => {
    c.settings.set("autoReply.allowedKinds", [
      "acknowledgement",
      "stalled_reminder",
      "followup_question",
    ]);
    receive();
    expect(rows()).toHaveLength(0);
  });

  test("away off -> nothing", () => {
    c.autoReply.setAway(false);
    receive();
    expect(rows()).toHaveLength(0);
  });

  test("daily run cap: the 11th within a rolling 24 h is not queued; after 24 h it is", () => {
    for (let i = 0; i < 10; i += 1) {
      receive();
      clock.advance(MIN);
    }
    expect(rows()).toHaveLength(10);
    receive();
    expect(rows()).toHaveLength(10);
    expect(answerJobs()).toHaveLength(10);
    // Rolling: the first run leaves the window 24 h after it was created.
    clock.set(new Date(Date.parse(NOW) + 24 * H + 30_000));
    receive();
    expect(rows()).toHaveLength(11);
  });

  test("a failing create is contained in its savepoint and logs ids only", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const m = addMessage();
      deliver(m.id);
      // A second delivery of the same message: create refuses (already running).
      deliver(m.id);
      expect(rows()).toHaveLength(1);
      expect(answerJobs()).toHaveLength(1);
      const logged = spy.mock.calls.map((a) => a.join(" ")).join("\n");
      expect(logged).toContain(`message=${m.id}`);
      expect(logged).not.toContain("QUESTION-MARKER");
    } finally {
      spy.mockRestore();
    }
  });
});

function seedAway(
  over: Partial<typeof schema.codeAnswers.$inferInsert> = {},
  msg: Parameters<typeof addMessage>[0] = {},
): { id: string; messageId: string; ts: string } {
  const m = addMessage(msg);
  const id = newId();
  c.db
    .insert(schema.codeAnswers)
    .values({
      id,
      messageId: m.id,
      repositoryId: "repo-app",
      trigger: "away",
      status: "ready",
      answer: ANSWER,
      confidence: 0.9,
      evidence: [{ path: "src/a.ts", line: 1 }],
      droppedEvidenceCount: 0,
      createdAt: clock.now().toISOString(),
      updatedAt: clock.now().toISOString(),
      ...over,
    })
    .run();
  return { id, messageId: m.id, ts: m.ts };
}

const evaluate = (codeAnswerId: string) =>
  c.autoReply.evaluate({ kind: "code_answer", codeAnswerId });

function expectNothingForApproval(): void {
  expect(approvals()).toHaveLength(0);
  expect(outgoing()).toHaveLength(0);
  expect(sink.sends).toHaveLength(0);
}

describe("away decision (C7)", () => {
  test("default: held code_answer_review becomes a pending user approval with the exact text", async () => {
    const a = seedAway();
    const r = evaluate(a.id);
    expect(r).toMatchObject({ status: "held", reason: "code_answer_review" });
    const [ar] = allAr();
    expect(ar).toMatchObject({
      kind: "code_answer",
      decision: "held",
      reason: "code_answer_review",
      text: null,
      recipientSlackUserId: PRIO,
      conversationExternalId: DM,
      threadTs: a.ts,
      sourceMessageId: a.messageId,
    });
    const [ap] = approvals();
    expect(ap).toMatchObject({ action: "slack.send", status: "pending", decidedBy: null });
    expect(ap?.requestedByModule).toBe("code-answer");
    const [o] = outgoing();
    expect(o).toMatchObject({
      text: ANSWER,
      conversationExternalId: DM,
      threadTs: a.ts,
      status: "pending",
      approvalId: ap?.id,
    });
    expect(o?.text).not.toContain("Sent using @claude");
    expect(ar?.outgoingId).toBe(o?.id ?? "");
    expect(ar?.approvalId).toBe(ap?.id ?? "");
    expect(row(a.id)).toMatchObject({ status: "held", outgoingId: o?.id, autoReplyId: ar?.id });
    // Nothing goes out without the user's approval.
    while (await c.worker.runOnce()) {}
    expect(sink.sends).toHaveLength(0);
    // No answer or question text in events or audit.
    const events = JSON.stringify(c.db.select().from(schema.domainEvents).all());
    const audit = JSON.stringify(c.db.select().from(schema.auditEvents).all());
    for (const s of [events, audit]) {
      expect(s).not.toContain("retries three times");
      expect(s).not.toContain("QUESTION-MARKER");
    }
  });

  test("dismissing a held answer rejects its pending review approval and fails the outgoing", async () => {
    const a = seedAway();
    evaluate(a.id);
    const [ap] = approvals();
    expect(ap?.status).toBe("pending");
    c.codeAnswers.dismiss(a.id);
    c.dispatcher.dispatchOnce();
    expect(row(a.id)?.status).toBe("dismissed");
    expect(approvals()[0]?.status).toBe("rejected");
    expect(outgoing()[0]).toMatchObject({ status: "failed", failure: "rejected" });
    while (await c.worker.runOnce()) c.dispatcher.dispatchOnce();
    expect(sink.sends).toHaveLength(0);
  });

  test("the user can approve the review send; its delivery is not reported as an auto-reply", async () => {
    const a = seedAway();
    evaluate(a.id);
    const [ap] = approvals();
    c.approvals.approve(ap?.id as string);
    c.dispatcher.dispatchOnce();
    while (await c.worker.runOnce()) c.dispatcher.dispatchOnce();
    expect(sink.sends.map((s) => s.text)).toEqual([ANSWER]);
    const sentEvents = c.db
      .select()
      .from(schema.domainEvents)
      .all()
      .filter((e) => e.type === "autoreply.sent");
    expect(sentEvents).toHaveLength(0);
    expect(allAr()[0]?.decision).toBe("held");
    expect(row(a.id)?.status).toBe("held");
  });

  test("autoSend on and every check passing: sent with the tag and a policy approval", () => {
    c.settings.set("codeAnswer.away.autoSend", true);
    const a = seedAway();
    const r = evaluate(a.id);
    expect(r).toMatchObject({ status: "sent" });
    const [o] = outgoing();
    expect(o?.text).toBe(withAutoReplyTag(ANSWER));
    expect(o?.text.endsWith("Sent using @claude")).toBe(true);
    const [ap] = approvals();
    expect(ap).toMatchObject({ action: "slack.auto_reply", decidedBy: "policy" });
    expect(allAr()[0]).toMatchObject({ decision: "sent", outgoingId: o?.id });
    expect(row(a.id)).toMatchObject({ status: "sent", outgoingId: o?.id });
  });

  test("autoSend on, blocked at request time: rolled back and held away_off", () => {
    c.settings.set("codeAnswer.away.autoSend", true);
    const svc = new AutoReplyService({
      db: c.db,
      clock,
      events: c.events,
      audit: c.audit,
      queue: c.queue,
      settings: c.settings,
      people: c.people,
      securityFlags: c.securityFlags,
      outgoing: {
        requestAutoSend: () => {
          throw new AutoSendBlocked("x", "away_off");
        },
        requestSend: (tx, i) => c.outgoing.requestSend(tx, i),
      },
      codeAnswers: c.codeAnswers,
    });
    const a = seedAway();
    expect(svc.evaluate({ kind: "code_answer", codeAnswerId: a.id })).toMatchObject({
      status: "held",
      reason: "away_off",
    });
    expect(allAr().map((x) => [x.decision, x.reason])).toEqual([["held", "away_off"]]);
    expect(row(a.id)).toMatchObject({ status: "held", outgoingId: null });
    expectNothingForApproval();
  });

  test.each([
    [
      "suspected injection",
      {
        suspectedInjection: {
          detected: true,
          severity: "warning",
          quote: "",
          reason: "placeholder",
        },
      },
      "injection_suspected",
    ],
    ["confidence 0.5", { confidence: 0.5 }, "low_confidence"],
    ["a fenced block", { answer: "It retries:\n```ts\nretry(3)\n```" }, "content_code_block"],
  ])("%s -> held, nothing for approval", (_name, over, reason) => {
    const a = seedAway(over as Partial<typeof schema.codeAnswers.$inferInsert>);
    expect(evaluate(a.id)).toMatchObject({ status: "held", reason });
    expect(allAr().map((x) => x.reason)).toEqual([reason]);
    expect(row(a.id)).toMatchObject({ status: "held", outgoingId: null });
    expectNothingForApproval();
  });

  test("a link with autoSend on -> content_link, no approval", () => {
    c.settings.set("codeAnswer.away.autoSend", true);
    const a = seedAway({ answer: "See https://example.com for the retry docs." });
    expect(evaluate(a.id)).toMatchObject({ status: "held", reason: "content_link" });
    expectNothingForApproval();
  });

  test("a normal-priority recipient with autoSend on -> not_priority", () => {
    c.settings.set("codeAnswer.away.autoSend", true);
    const a = seedAway({}, { sender: "u-norm", conv: "c-dm2" });
    expect(evaluate(a.id)).toMatchObject({ status: "held", reason: "not_priority" });
    expectNothingForApproval();
  });

  test.each([
    ["not_answerable", { status: "not_answerable", notAnswerableReason: "placeholder reason" }],
    ["unverified", { status: "unverified", failure: "evidence_unverified" }],
  ] as const)(
    "%s -> held with that reason, nothing for approval, in the digest",
    (reason, over) => {
      const a = seedAway({ answer: null, confidence: null, evidence: [], ...over });
      expect(evaluate(a.id)).toMatchObject({ status: "held", reason });
      expectNothingForApproval();
      // The row keeps its own status; the decision is linked.
      expect(row(a.id)).toMatchObject({ status: reason, autoReplyId: allAr()[0]?.id });
      c.autoReply.setAway(false);
      const digest = c.autoReply.digest();
      expect(digest?.held.map((h) => [h.kind, h.reason])).toEqual([["code_answer", reason]]);
    },
  );

  test("away switched off before evaluate -> held away_off in that session's digest", () => {
    const a = seedAway();
    c.autoReply.setAway(false);
    expect(evaluate(a.id)).toMatchObject({ status: "held", reason: "away_off" });
    expectNothingForApproval();
    expect(row(a.id)).toMatchObject({ status: "held", outgoingId: null });
    expect(c.autoReply.digest()?.held.map((h) => h.reason)).toEqual(["away_off"]);
  });

  test("a second evaluate is skipped already_evaluated", () => {
    const a = seedAway();
    evaluate(a.id);
    expect(evaluate(a.id)).toEqual({ status: "skipped", reason: "already_evaluated" });
    expect(allAr()).toHaveLength(1);
    expect(approvals()).toHaveLength(1);
  });

  test("a user-triggered row is skipped; a dismissed row is skipped not_ready", () => {
    const u = seedAway({ trigger: "user" });
    expect(evaluate(u.id)).toEqual({ status: "skipped", reason: "kind_mismatch" });
    const d = seedAway({ status: "dismissed" });
    expect(evaluate(d.id)).toEqual({ status: "skipped", reason: "not_ready" });
    expect(evaluate("nope")).toEqual({ status: "skipped", reason: "not_found" });
    expect(allAr()).toHaveLength(0);
  });

  test("the evaluate worker accepts the code_answer trigger and rejects a bad one", async () => {
    const a = seedAway();
    const h = c.handlers.get(AUTOREPLY_EVALUATE_JOB) as HandlerRegistration;
    const job = (input: unknown) => ({ id: "j", type: AUTOREPLY_EVALUATE_JOB, input }) as Job;
    expect(await h.handler(job({ kind: "code_answer", codeAnswerId: a.id }), ctx)).toMatchObject({
      status: "held",
      reason: "code_answer_review",
    });
    await expect(h.handler(job({ kind: "code_answer" }), ctx)).rejects.toThrow(
      "invalid auto-reply trigger",
    );
  });
});

describe("generate hook (onFinished)", () => {
  function runResult(): AIExecutionResult {
    return {
      status: "succeeded",
      toolResults: [
        {
          toolUseId: "t-1",
          toolName: "Read",
          input: { file_path: join(appRoot, "src/a.ts") },
          isError: false,
          content: "1\texport {};",
        },
      ],
      finalText: `\`\`\`json\n${JSON.stringify({
        answerable: true,
        answer: ANSWER,
        confidence: 0.9,
        evidence: [{ path: "src/a.ts", line: 1 }],
        suspectedInjection: { detected: false, severity: "warning", quote: "", reason: "" },
      })}\n\`\`\``,
      numTurns: 3,
      durationMs: 10,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        costUsdEquivalent: 0,
      },
      permissionDenials: [],
      connectors: [],
      availableTools: [],
      exitCode: 0,
    };
  }

  const runJob = (id: string) =>
    (c.handlers.get(CODE_ANSWER_JOB) as HandlerRegistration).handler(
      { id: "j-ca", type: CODE_ANSWER_JOB, input: { codeAnswerId: id } } as Job,
      ctx,
    );
  const create = (trigger: "user" | "away") => {
    const m = addMessage();
    return c.db.transaction((tx) =>
      c.codeAnswers.create(tx, { messageId: m.id, repositoryId: "repo-app", trigger }),
    );
  };

  test("an away run ending ready queues the code_answer decision", async () => {
    c.orchestrator.run = (async () => runResult()) as typeof c.orchestrator.run;
    const id = create("away");
    await runJob(id);
    expect(row(id)?.status).toBe("ready");
    expect(autoReplyJobs().map((j) => [j.idempotencyKey, j.input])).toEqual([
      [`autoreply:code_answer:${id}`, { kind: "code_answer", codeAnswerId: id }],
    ]);
  });

  test("an away run ending not_answerable queues the decision", async () => {
    const r = runResult();
    r.finalText = `\`\`\`json\n${JSON.stringify({
      answerable: false,
      answer: "",
      confidence: 0.2,
      evidence: [],
      notAnswerableReason: "placeholder reason",
      suspectedInjection: { detected: false, severity: "warning", quote: "", reason: "" },
    })}\n\`\`\``;
    c.orchestrator.run = (async () => r) as typeof c.orchestrator.run;
    const id = create("away");
    await runJob(id);
    expect(row(id)?.status).toBe("not_answerable");
    expect(autoReplyJobs()).toHaveLength(1);
  });

  test("an away run ending unverified queues the decision", async () => {
    const r = runResult();
    // The cited path was never observed in a tool result, so no evidence survives.
    r.finalText = r.finalText.replace("src/a.ts", "src/never-read.ts");
    c.orchestrator.run = (async () => r) as typeof c.orchestrator.run;
    const id = create("away");
    await runJob(id);
    expect(row(id)?.status).toBe("unverified");
    expect(autoReplyJobs().map((j) => j.idempotencyKey)).toEqual([`autoreply:code_answer:${id}`]);
  });

  test("a failed away run records nothing", async () => {
    c.orchestrator.run = (async () => {
      throw new JobError({ kind: "unknown", message: "run failed" });
    }) as typeof c.orchestrator.run;
    const id = create("away");
    await expect(runJob(id)).rejects.toThrow();
    expect(row(id)?.status).toBe("failed");
    expect(autoReplyJobs()).toHaveLength(0);
    expect(allAr()).toHaveLength(0);
  });

  test("a user run ending ready queues nothing", async () => {
    c.orchestrator.run = (async () => runResult()) as typeof c.orchestrator.run;
    const id = create("user");
    await runJob(id);
    expect(row(id)?.status).toBe("ready");
    expect(autoReplyJobs()).toHaveLength(0);
  });
});

const sessionId = () => c.autoReply.status().sessionId as string;
function priorSent(over: { conv?: string; thread?: string | null; ago: number }): void {
  c.db
    .insert(schema.autoReplies)
    .values({
      id: newId(),
      sessionId: sessionId(),
      kind: "acknowledgement",
      recipientSlackUserId: PRIO,
      conversationExternalId: over.conv ?? DM,
      threadTs: over.thread ?? null,
      decision: "sent",
      text: "placeholder",
      createdAt: new Date(clock.now().getTime() - over.ago).toISOString(),
    })
    .run();
}

describe("fix round 1: caps bound only unapproved sends", () => {
  test("thread_gap: autoSend off still creates the review approval; autoSend on holds", () => {
    priorSent({ ago: 5 * MIN });
    const off = seedAway();
    expect(evaluate(off.id)).toMatchObject({ status: "held", reason: "code_answer_review" });
    expect(approvals()).toHaveLength(1);
    c.settings.set("codeAnswer.away.autoSend", true);
    const on = seedAway();
    expect(evaluate(on.id)).toMatchObject({ status: "held", reason: "thread_gap" });
    expect(approvals()).toHaveLength(1);
    expect(row(on.id)).toMatchObject({ status: "held", outgoingId: null });
  });

  test("daily_cap: autoSend off still creates the review approval; autoSend on holds", () => {
    for (let i = 0; i < 3; i += 1) priorSent({ conv: "C0CHAN0001", thread: `t${i}`, ago: 2 * H });
    const off = seedAway();
    expect(evaluate(off.id)).toMatchObject({ status: "held", reason: "code_answer_review" });
    expect(approvals()).toHaveLength(1);
    c.settings.set("codeAnswer.away.autoSend", true);
    const on = seedAway();
    expect(evaluate(on.id)).toMatchObject({ status: "held", reason: "daily_cap" });
    expect(approvals()).toHaveLength(1);
    expect(outgoing()).toHaveLength(1);
  });
});

describe("fix round 1: sessions", () => {
  test("a row from an earlier session evaluated while a new session is open holds away_off", () => {
    const first = sessionId();
    const a = seedAway();
    c.autoReply.setAway(false);
    clock.advance(10 * MIN);
    c.autoReply.setAway(true);
    expect(sessionId()).not.toBe(first);
    c.settings.set("codeAnswer.away.autoSend", true);
    expect(evaluate(a.id)).toMatchObject({ status: "held", reason: "away_off" });
    expect(allAr().map((x) => [x.sessionId, x.reason])).toEqual([[first, "away_off"]]);
    expectNothingForApproval();
    expect(row(a.id)).toMatchObject({ status: "held", outgoingId: null });
  });
});

describe("fix round 1: re-requesting a send from the thread view", () => {
  const view = (id: string) => c.codeAnswers.get(id);
  const reviewed = () => {
    const a = seedAway();
    evaluate(a.id);
    return a;
  };

  test("after the review approval was rejected, a re-request makes a fresh approval", () => {
    const a = reviewed();
    const [ap] = approvals();
    const firstOut = row(a.id)?.outgoingId;
    c.approvals.reject(ap?.id as string, "edit first");
    c.dispatcher.dispatchOnce();
    expect(outgoing()[0]).toMatchObject({ status: "failed", failure: "rejected" });
    expect(view(a.id)?.sendable).toBe(true);
    const r = c.codeAnswers.requestSend(a.id, "Edited: the worker retries three times.", false);
    expect(r.outgoingId).not.toBe(firstOut);
    expect(row(a.id)).toMatchObject({ status: "sent", outgoingId: r.outgoingId });
    const fresh = approvals().find((x) => x.id === r.approvalId);
    expect(fresh).toMatchObject({ action: "slack.send", status: "pending" });
    expect(view(a.id)?.sendable).toBe(false);
    // Only once per failed send: the new one is pending.
    expect(() => c.codeAnswers.requestSend(a.id, ANSWER, false)).toThrow("invalid_state");
  });

  test("while the review approval is pending a re-request is refused", () => {
    const a = reviewed();
    expect(view(a.id)?.sendable).toBe(false);
    expect(() => c.codeAnswers.requestSend(a.id, ANSWER, false)).toThrow("invalid_state");
    expect(approvals()).toHaveLength(1);
  });

  test("after delivery a re-request is refused", async () => {
    const a = reviewed();
    c.approvals.approve(approvals()[0]?.id as string);
    c.dispatcher.dispatchOnce();
    while (await c.worker.runOnce()) c.dispatcher.dispatchOnce();
    expect(sink.sends).toHaveLength(1);
    expect(view(a.id)?.sendable).toBe(false);
    expect(() => c.codeAnswers.requestSend(a.id, ANSWER, false)).toThrow("invalid_state");
  });

  test.each([
    ["cancelled_away_off", true],
    ["cancelled_policy_disabled", true],
    ["cancelled_stale", true],
    ["expired", true],
    ["revoked", false],
    ["tool_error", false],
    ["not_started", false],
  ])("a sent row whose send failed %s: re-request allowed=%p", (failure, allowed) => {
    c.settings.set("codeAnswer.away.autoSend", true);
    const a = seedAway();
    evaluate(a.id);
    expect(row(a.id)?.status).toBe("sent");
    const outId = row(a.id)?.outgoingId as string;
    c.db
      .update(schema.outgoingMessages)
      .set({ status: "failed", failure })
      .where(eq(schema.outgoingMessages.id, outId))
      .run();
    expect(view(a.id)?.sendable).toBe(allowed);
    if (allowed) {
      const r = c.codeAnswers.requestSend(a.id, ANSWER, false);
      expect(row(a.id)?.outgoingId).toBe(r.outgoingId);
      // The fresh send is a user approval with the exact text, never a policy one.
      expect(approvals().find((x) => x.id === r.approvalId)).toMatchObject({
        action: "slack.send",
        decidedBy: null,
      });
      expect(outgoing().find((o) => o.id === r.outgoingId)?.text).toBe(ANSWER);
    } else {
      expect(() => c.codeAnswers.requestSend(a.id, ANSWER, false)).toThrow("invalid_state");
    }
  });

  test("kill switch: autoSend off before the send is claimed returns the answer to held; the user can still approve it", async () => {
    c.settings.set("codeAnswer.away.autoSend", true);
    const a = seedAway();
    evaluate(a.id);
    const outId = row(a.id)?.outgoingId as string;
    expect(row(a.id)?.status).toBe("sent");
    c.settings.set("codeAnswer.away.autoSend", false);
    c.dispatcher.dispatchOnce();
    while (await c.worker.runOnce()) {}
    expect(sink.sends).toHaveLength(0);
    expect(outgoing().find((o) => o.id === outId)).toMatchObject({
      status: "failed",
      failure: "cancelled_policy_disabled",
    });
    expect(allAr()[0]).toMatchObject({
      decision: "held",
      reason: "code_answer_review",
      text: null,
    });
    expect(row(a.id)?.status).toBe("held");
    expect(view(a.id)?.sendable).toBe(true);
    const r = c.codeAnswers.requestSend(a.id, ANSWER, false);
    expect(approvals().find((x) => x.id === r.approvalId)).toMatchObject({
      action: "slack.send",
      status: "pending",
      decidedBy: null,
    });
  });
});
