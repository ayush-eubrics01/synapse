import { beforeEach, expect, test } from "bun:test";
import {
  type AIExecutionResult,
  type ClaudeJobRequest,
  type Job,
  JobError,
  type ScreeningRecord,
  type UrgencyLevel,
} from "@synapse/contracts";
import { openDatabase, runMigrations, schema } from "@synapse/database";
import { FakeClock } from "@synapse/shared";
import { eq } from "drizzle-orm";
import { AuditLogger } from "../../src/core/audit/audit";
import { SettingsService } from "../../src/core/config/settings";
import { LiveBus } from "../../src/core/events/live-bus";
import { EventPublisher } from "../../src/core/events/publisher";
import { JobQueue } from "../../src/core/jobs/queue";
import type { HandlerRegistration } from "../../src/core/jobs/worker";
import { NotificationService } from "../../src/core/notifications/notifications";
import { PeopleService } from "../../src/modules/people/service";
import { SecurityFlagsService } from "../../src/modules/security-flags/service";
import { registerUrgencyJobs } from "../../src/workers/urgency";

const NOW = "2026-11-05T12:00:00.000Z";
const SECRET = "SECRET-BODY-TEXT-xyz";
const signal = new AbortController().signal;
const ctx = { signal, checkpoint() {}, getCheckpoint: () => undefined } as never;

let db: ReturnType<typeof openDatabase>["db"];
let queue: JobQueue;
let settings: SettingsService;
let handlers: Map<string, HandlerRegistration>;
let seq = 0;

type Entry = {
  messageId: string;
  level?: UrgencyLevel;
  reason?: string;
  suspectedInjection?: {
    detected: boolean;
    severity: "info" | "warning" | "high";
    quote: string;
    reason: string;
  };
};
interface Script {
  entries?: Entry[];
  denials?: string[];
  tools?: string[];
  throws?: Error;
  /** permission_denials persisted on the claude_runs row (the orchestrator does this even for failed runs). */
  runDenials?: string[];
  /** The orchestrator rejected before inserting a claude_runs row (quota gate, invalid request). */
  noRow?: boolean;
  raw?: string;
}
let script: Script;
let requests: ClaudeJobRequest[];
let calls: number;

const inj = { detected: false, severity: "info" as const, quote: "", reason: "" };

beforeEach(() => {
  db = openDatabase(":memory:").db;
  runMigrations(db);
  const clock = new FakeClock(NOW);
  const events = new EventPublisher(clock);
  settings = new SettingsService(db, clock, events.publish.bind(events));
  queue = new JobQueue(db, clock);
  const notifications = new NotificationService(db, clock, new LiveBus());
  const people = new PeopleService({ db, clock, events, audit: new AuditLogger(clock), settings });
  const securityFlags = new SecurityFlagsService({
    db,
    clock,
    events,
    audit: new AuditLogger(clock),
    settings,
    notifications,
    people,
  });
  securityFlags.init();
  script = {};
  requests = [];
  calls = 0;
  handlers = new Map();
  const orchestrator = {
    async run(req: ClaudeJobRequest): Promise<AIExecutionResult> {
      calls++;
      requests.push(req);
      if (!script.noRow)
        db.insert(schema.claudeRuns)
          .values({
            id: `run-${calls}`,
            jobId: req.jobId ?? null,
            workerProfile: "intelligence",
            status: script.throws ? "failed" : "succeeded",
            startedAt: NOW,
            permissionDenials: script.runDenials ?? null,
          })
          .run();
      if (script.throws) throw script.throws;
      const finalText =
        script.raw ??
        `\`\`\`json\n${JSON.stringify({
          assessments: (script.entries ?? []).map((e) => ({
            level: "low",
            reason: "r",
            suspectedInjection: inj,
            ...e,
          })),
        })}\n\`\`\``;
      return {
        finalText,
        permissionDenials: script.denials ?? [],
        toolResults: (script.tools ?? []).map((toolName) => ({ toolName })),
      } as unknown as AIExecutionResult;
    },
  };
  registerUrgencyJobs({
    db,
    clock,
    settings,
    events,
    queue,
    notifications,
    orchestrator: orchestrator as never,
    securityFlags,
    handlers,
  });
  seq = 0;
  db.insert(schema.slackUsers).values({ id: "su1", externalId: "UPRIYA0001", name: "Priya" }).run();
  db.insert(schema.slackConversations)
    .values({ id: "c-ch", externalId: "C1", type: "channel", name: "payments" })
    .run();
  db.insert(schema.slackConversations).values({ id: "c-dm", externalId: "D1", type: "im" }).run();
});

function add(
  o: {
    route?: ScreeningRecord["route"];
    ruleLevel?: UrgencyLevel;
    text?: string | null;
    conv?: string;
    extra?: Partial<ScreeningRecord>;
    status?: string;
    /** thread_ts: replies share their root's ts. */
    thread?: string;
    sentAt?: string;
  } = {},
) {
  seq += 1;
  const id = `m${seq}`;
  db.insert(schema.slackMessages)
    .values({
      id,
      conversationId: o.conv ?? "c-ch",
      ts: `${1000 + seq}.000000`,
      threadTs: o.thread ?? null,
      senderUserId: "su1",
      text: o.text === undefined ? `${SECRET} ${seq}` : o.text,
      sentAt: o.sentAt ?? new Date(Date.parse(NOW) - 60_000 + seq * 1000).toISOString(),
      collectedAt: NOW,
      urgencyStatus: o.status ?? null,
      screening: {
        version: 1,
        candidate: true,
        score: 3,
        ruleLevel: o.ruleLevel ?? "medium",
        matchedRules: ["kw:prod"],
        urgencySignals: [],
        route: o.route ?? "assess",
        assessed: false,
        ...o.extra,
      } satisfies ScreeningRecord,
    })
    .run();
  return id;
}

const msg = (id: string) =>
  db.select().from(schema.slackMessages).where(eq(schema.slackMessages.id, id)).get() as {
    urgencyLevel: string | null;
    urgencyReason: string | null;
    urgencyStatus: string | null;
    screening: ScreeningRecord;
  };

function run(attempts = 1, maxAttempts = 3) {
  const jobId = db.transaction(
    (tx) => queue.enqueue(tx, { type: "urgency.assess", idempotencyKey: `t${Math.random()}` }).id,
  );
  const job = { id: jobId, type: "urgency.assess", attempts, maxAttempts } as unknown as Job;
  return handlers.get("urgency.assess")?.handler(job, ctx) as Promise<unknown>;
}

const notifs = () => db.select().from(schema.notifications).all();
const urgentEvents = () =>
  db
    .select()
    .from(schema.domainEvents)
    .all()
    .filter((e) => e.type === "message.urgent_detected");
const jobsOf = (type: string) =>
  db
    .select()
    .from(schema.jobs)
    .all()
    .filter((j) => j.type === type);
const flags = () => db.select().from(schema.securityFlags).all();

test("registers urgency.assess with a 360 s timeout", () => {
  expect(handlers.get("urgency.assess")?.timeoutMs).toBe(360_000);
});

test("batch of 3 writes all three levels, reasons and status", async () => {
  const a = add();
  const b = add();
  const c = add({ status: "acknowledged" });
  script.entries = [
    { messageId: a, level: "critical", reason: "prod down" },
    { messageId: b, level: "medium" },
    { messageId: c, level: "low" },
  ];
  await run();
  expect(msg(a)).toMatchObject({ urgencyLevel: "critical", urgencyReason: "prod down" });
  expect(msg(b).urgencyLevel).toBe("medium");
  expect(msg(c).urgencyLevel).toBe("low");
  expect(msg(a).urgencyStatus).toBe("new");
  expect(msg(c).urgencyStatus).toBe("acknowledged"); // never reset
  for (const id of [a, b, c]) {
    expect(msg(id).screening).toMatchObject({
      assessed: true,
      fallback: false,
      route: "assess",
      matchedRules: ["kw:prod"],
    });
  }
});

test("request is built from the batch: untrusted parts, ToolSearch only, model setting", async () => {
  const a = add();
  script.entries = [{ messageId: a }];
  await run();
  const req = requests[0] as ClaudeJobRequest;
  expect(req.allowedTools).toEqual(["ToolSearch"]);
  expect(req.workerProfile).toBe("intelligence");
  expect(req.priorityClass).toBe("urgent");
  expect(req.model).toBe("haiku");
  expect(req.maxTurns).toBe(3);
  const untrusted = (req.parts ?? []).filter((p) => p.provenance === "untrusted");
  expect(untrusted).toHaveLength(1);
  expect(untrusted[0]?.source).toBe(`slack message ${a} from Priya`);
  expect(req.instructions).not.toContain(SECRET);
});

test("non-candidates, other routes, assessed and expired messages are never selected", async () => {
  const cand = add();
  add({ route: "batch" });
  add({ route: "skip" });
  add({ extra: { assessed: true } });
  add({ text: null });
  script.entries = [{ messageId: cand }];
  await run();
  const req = requests[0] as ClaudeJobRequest;
  expect((req.parts ?? []).filter((p) => p.provenance === "untrusted")).toHaveLength(1);
});

test("empty batch completes without a Claude call", async () => {
  add({ route: "batch" });
  expect(await run()).toEqual({ assessed: 0 });
  expect(calls).toBe(0);
});

test("an id outside the batch fails the run and writes nothing", async () => {
  const a = add();
  script.entries = [{ messageId: a, level: "critical" }, { messageId: "stranger" }];
  await expect(run()).rejects.toMatchObject({ classified: { kind: "incomplete_ai_output" } });
  expect(msg(a).urgencyLevel).toBeNull();
  expect(msg(a).screening.assessed).toBe(false);
  expect(notifs()).toHaveLength(0);
});

test("a duplicate id fails the run and writes nothing", async () => {
  const a = add();
  script.entries = [
    { messageId: a, level: "critical" },
    { messageId: a, level: "low" },
  ];
  await expect(run()).rejects.toMatchObject({ classified: { kind: "incomplete_ai_output" } });
  expect(msg(a).urgencyLevel).toBeNull();
});

test("a missing id falls back to its rule level while the others are assessed", async () => {
  const a = add();
  const b = add();
  const miss = add({ ruleLevel: "high" });
  script.entries = [
    { messageId: a, level: "low" },
    { messageId: b, level: "medium" },
  ];
  await run();
  expect(msg(a).screening.fallback).toBe(false);
  expect(msg(b).urgencyLevel).toBe("medium");
  expect(msg(miss)).toMatchObject({
    urgencyLevel: "high",
    urgencyReason: "Rule-based (assessment unavailable)",
    urgencyStatus: "new",
  });
  expect(msg(miss).screening).toMatchObject({ assessed: true, fallback: true });
  expect(notifs()).toHaveLength(1); // the fallback high level notifies
});

test("critical result: one notification, one event, one suggest job; re-run adds nothing", async () => {
  const a = add();
  script.entries = [{ messageId: a, level: "critical" }];
  await run();
  const n = notifs();
  expect(n).toHaveLength(1);
  expect(n[0]).toMatchObject({
    kind: "urgency.urgent",
    severity: "high",
    title: "Critical: message from Priya in #payments",
    ref: a,
  });
  expect(JSON.stringify(n)).not.toContain(SECRET);
  expect(urgentEvents()).toHaveLength(1);
  expect(urgentEvents()[0]?.payload).toEqual({
    messageId: a,
    level: "critical",
    assessed: true,
  });
  expect(msg(a).screening.notified).toBe(true);
  const suggest = jobsOf("urgency.suggest_response");
  expect(suggest).toHaveLength(1);
  expect(suggest[0]).toMatchObject({ idempotencyKey: `urgency.suggest:${a}`, priority: 150 });
  expect(suggest[0]?.concurrencyGroup).toBe("urgency.suggest");

  // replay: the message is assessed, so nothing is selected; force re-selection too
  await run();
  db.update(schema.slackMessages)
    .set({ screening: { ...msg(a).screening, assessed: false } })
    .run();
  script.entries = [{ messageId: a, level: "critical" }];
  await run();
  expect(notifs()).toHaveLength(1);
  expect(urgentEvents()).toHaveLength(1);
  expect(jobsOf("urgency.suggest_response")).toHaveLength(1);
});

test("high is a warning; DM and group DM labels; medium never notifies", async () => {
  const a = add({ conv: "c-dm" });
  db.insert(schema.slackConversations).values({ id: "c-g", externalId: "G1", type: "mpim" }).run();
  const b = add({ conv: "c-g" });
  const c = add();
  script.entries = [
    { messageId: a, level: "high" },
    { messageId: b, level: "critical" },
    { messageId: c, level: "medium" },
  ];
  await run();
  const titles = notifs().map((n) => [n.title, n.severity]);
  expect(titles).toContainEqual(["High: message from Priya in a DM", "warning"]);
  expect(titles).toContainEqual(["Critical: message from Priya in a group DM", "high"]);
  expect(notifs()).toHaveLength(2);
  expect(jobsOf("urgency.suggest_response")).toHaveLength(2);
});

test("suspectedInjection.detected records an AI flag against the run", async () => {
  const a = add();
  script.entries = [
    {
      messageId: a,
      level: "low",
      suspectedInjection: { detected: true, severity: "warning", quote: "do x", reason: "asks AI" },
    },
  ];
  await run();
  const f = flags().filter((x) => x.detector === "ai");
  expect(f).toHaveLength(1);
  expect(f[0]?.claudeRunId).toBe("run-1");
});

test("denied Slack send tool raises high runtime flags for every batch message", async () => {
  const a = add();
  const b = add();
  script.entries = [{ messageId: a }, { messageId: b }];
  script.denials = ["mcp__claude_ai_Slack__slack_send_message"];
  await run();
  const f = flags().filter((x) => x.detector === "runtime");
  expect(f.map((x) => x.messageId).sort()).toEqual([a, b]);
  expect(f.every((x) => x.severity === "high")).toBe(true);
  expect(f[0]?.excerpt).toContain("mcp__claude_ai_Slack__slack_send_message");
  expect(JSON.stringify(f)).not.toContain(SECRET);
});

test("a denied read tool or an unexpected read tool result is a warning flag", async () => {
  const a = add();
  script.entries = [{ messageId: a }];
  script.tools = ["mcp__claude_ai_Slack__slack_read_channel", "ToolSearch"];
  await run();
  const f = flags().filter((x) => x.detector === "runtime");
  expect(f).toHaveLength(1);
  expect(f[0]?.severity).toBe("warning");
});

test("ToolSearch alone raises no runtime flag", async () => {
  const a = add();
  script.entries = [{ messageId: a }];
  script.tools = ["ToolSearch"];
  await run();
  expect(flags()).toHaveLength(0);
});

test("quota deferral: critical-rule message gets a not-yet-assessed notification, stays unassessed", async () => {
  const crit = add({ ruleLevel: "critical" });
  const med = add({ ruleLevel: "medium" });
  script.throws = new JobError({ kind: "quota_exhausted", message: "q" });
  await expect(run()).rejects.toMatchObject({ classified: { kind: "quota_exhausted" } });
  const n = notifs();
  expect(n).toHaveLength(1);
  expect(n[0]?.title).toBe("Likely incident (not yet assessed): message from Priya in #payments");
  expect(n[0]?.ref).toBe(crit);
  expect(urgentEvents()).toHaveLength(1);
  expect(urgentEvents()[0]?.payload).toMatchObject({
    level: "critical",
    assessed: false,
  });
  expect(msg(crit).screening).toMatchObject({ assessed: false, notified: true });
  expect(msg(crit).urgencyLevel).toBeNull();
  expect(msg(med).screening.notified).toBeUndefined();

  // the retry after the deferral does not notify twice
  await expect(run()).rejects.toBeInstanceOf(JobError);
  expect(notifs()).toHaveLength(1);
});

test("auth_paused defers the same way", async () => {
  add({ ruleLevel: "critical" });
  script.throws = new JobError({ kind: "auth_paused", message: "a" });
  await expect(run()).rejects.toMatchObject({ classified: { kind: "auth_paused" } });
  expect(notifs()).toHaveLength(1);
});

test("a retryable failure before the last attempt changes nothing", async () => {
  const a = add({ ruleLevel: "critical" });
  script.throws = new JobError({ kind: "incomplete_ai_output", message: "bad" });
  await expect(run(2, 3)).rejects.toBeInstanceOf(JobError);
  expect(msg(a).screening.assessed).toBe(false);
  expect(notifs()).toHaveLength(0);
});

test("third failing attempt falls back to the rule level, notifies and rethrows", async () => {
  const a = add({ ruleLevel: "high" });
  const b = add({ ruleLevel: "low" });
  script.throws = new JobError({ kind: "incomplete_ai_output", message: "bad" });
  await expect(run(3, 3)).rejects.toMatchObject({ classified: { kind: "incomplete_ai_output" } });
  expect(msg(a)).toMatchObject({
    urgencyLevel: "high",
    urgencyReason: "Rule-based (assessment unavailable)",
    urgencyStatus: "new",
  });
  expect(msg(a).screening).toMatchObject({ assessed: true, fallback: true, notified: true });
  expect(msg(b).urgencyLevel).toBe("low");
  expect(notifs()).toHaveLength(1);
  expect(notifs()[0]?.title).toBe("High: message from Priya in #payments");
});

test("a non-retryable failure falls back immediately", async () => {
  const a = add({ ruleLevel: "medium" });
  script.throws = new JobError({ kind: "invalid_input", message: "no" });
  await expect(run(1, 3)).rejects.toBeInstanceOf(JobError);
  expect(msg(a).screening).toMatchObject({ assessed: true, fallback: true });
});

test("12 eligible with batchMax 10: 10 oldest assessed, follow-up job enqueued", async () => {
  const ids = Array.from({ length: 12 }, () => add());
  script.entries = ids.slice(0, 10).map((messageId) => ({ messageId }));
  const out = (await run()) as { assessed: number };
  expect(out.assessed).toBe(10);
  expect(msg(ids[9] as string).screening.assessed).toBe(true);
  expect(msg(ids[10] as string).screening.assessed).toBe(false);
  const next = jobsOf("urgency.assess").filter((j) => j.idempotencyKey.endsWith(":next"));
  expect(next).toHaveLength(1);
  expect(next[0]?.priority).toBe(200);
  // second run takes the remaining two
  script.entries = ids.slice(10).map((messageId) => ({ messageId }));
  await run();
  expect(msg(ids[11] as string).screening.assessed).toBe(true);
});

test("denied send tool plus invalid output: high runtime flags and incomplete_ai_output", async () => {
  const a = add();
  script.raw = "not json";
  script.denials = ["mcp__claude_ai_Slack__slack_send_message"];
  await expect(run()).rejects.toMatchObject({ classified: { kind: "incomplete_ai_output" } });
  const f = flags().filter((x) => x.detector === "runtime");
  expect(f).toHaveLength(1);
  expect(f[0]).toMatchObject({ messageId: a, severity: "high" });
});

test("a denied read tool is a warning flag", async () => {
  const a = add();
  script.entries = [{ messageId: a }];
  script.denials = ["mcp__claude_ai_Slack__slack_read_channel"];
  await run();
  expect(flags().filter((x) => x.detector === "runtime")[0]?.severity).toBe("warning");
});

test("urgency.assess jobs share a concurrency group: the second claim waits", async () => {
  add();
  add();
  db.transaction((tx) => {
    queue.enqueue(tx, {
      type: "urgency.assess",
      idempotencyKey: "k1",
      concurrencyGroup: "urgency.assess",
    });
    queue.enqueue(tx, {
      type: "urgency.assess",
      idempotencyKey: "k2",
      concurrencyGroup: "urgency.assess",
    });
  });
  expect(queue.claim("w", 60_000, ["urgency.assess"])).not.toBeNull();
  expect(queue.claim("w", 60_000, ["urgency.assess"])).toBeNull();
});

test("next-batch job carries the concurrency group", async () => {
  const ids = Array.from({ length: 11 }, () => add());
  script.entries = ids.slice(0, 10).map((messageId) => ({ messageId }));
  await run();
  const next = jobsOf("urgency.assess").find((j) => j.idempotencyKey.endsWith(":next"));
  expect(next?.concurrencyGroup).toBe("urgency.assess");
});

test("a non-JobError failure is rethrown as a content-free JobError", async () => {
  add();
  script.throws = new Error(`boom ${SECRET}`);
  const e = await run().catch((x) => x);
  expect(e).toBeInstanceOf(JobError);
  expect(JSON.stringify((e as JobError).classified)).not.toContain(SECRET);
});

test("the stored reason is sanitised and capped", async () => {
  const a = add();
  script.entries = [{ messageId: a, reason: `bad\u202e${"x".repeat(290)}` }];
  await run();
  const r = msg(a).urgencyReason as string;
  expect(r).not.toContain("\u202e");
  expect(r.length).toBeLessThanOrEqual(300);
});

test("R16: a run that records denials and then throws still raises high runtime flags", async () => {
  const a = add();
  const b = add();
  script.runDenials = ["mcp__claude_ai_Slack__slack_send_message"];
  script.throws = new JobError({
    kind: "provider_error",
    message: "claude reported an error result",
  });
  await expect(run(1, 3)).rejects.toMatchObject({ classified: { kind: "provider_error" } });
  const f = flags().filter((x) => x.detector === "runtime");
  expect(f.map((x) => x.messageId).sort()).toEqual([a, b]);
  expect(f.every((x) => x.severity === "high" && x.claudeRunId === "run-1")).toBe(true);
  expect(f[0]?.reason).toBe("denied tools: mcp__claude_ai_Slack__slack_send_message");
  expect(JSON.stringify(f)).not.toContain(SECRET);
  // The retry is still a plain retry: nothing assessed, nothing notified.
  expect(msg(a).screening.assessed).toBe(false);
});

test("R16: a max_turns failure raises a warning runtime flag with a content-free reason", async () => {
  const a = add();
  script.throws = new JobError({
    kind: "provider_error",
    message: "claude reached max turns",
    details: { maxTurns: true },
  });
  await expect(run(1, 3)).rejects.toBeInstanceOf(JobError);
  const f = flags().filter((x) => x.detector === "runtime");
  expect(f).toHaveLength(1);
  expect(f[0]).toMatchObject({ messageId: a, severity: "warning", reason: "max_turns reached" });
});

test("R16: denials plus max_turns: one high flag naming both", async () => {
  add();
  script.runDenials = ["Bash"];
  script.throws = new JobError({
    kind: "provider_error",
    message: "claude reached max turns",
    details: { maxTurns: true },
  });
  await expect(run(1, 3)).rejects.toBeInstanceOf(JobError);
  const f = flags().filter((x) => x.detector === "runtime");
  expect(f).toHaveLength(1);
  expect(f[0]?.severity).toBe("high");
  expect(f[0]?.reason).toBe("denied tools: Bash; max_turns reached");
});

test("R16: a failure before this attempt's run row exists reuses no earlier run's denials", async () => {
  const a = add();
  // Attempt 1: a denial on a run that then fails -> one high flag.
  script.runDenials = ["Bash"];
  script.throws = new JobError({ kind: "provider_error", message: "x" });
  const jobId = db.transaction(
    (tx) => queue.enqueue(tx, { type: "urgency.assess", idempotencyKey: "same-job" }).id,
  );
  const job = (attempts: number) =>
    ({ id: jobId, type: "urgency.assess", attempts, maxAttempts: 3 }) as unknown as Job;
  const h = handlers.get("urgency.assess")?.handler as (j: Job, c: unknown) => Promise<unknown>;
  await expect(h(job(1), ctx)).rejects.toBeInstanceOf(JobError);
  expect(flags().filter((x) => x.detector === "runtime")).toHaveLength(1);
  db.delete(schema.securityFlags).run();
  // Attempt 2: the quota gate rejects before any row: attempt 1's row must not be re-read.
  script.noRow = true;
  script.runDenials = undefined;
  script.throws = new JobError({ kind: "quota_exhausted", message: "q" });
  await expect(h(job(2), ctx)).rejects.toBeInstanceOf(JobError);
  expect(flags().filter((x) => x.detector === "runtime" && x.messageId === a)).toHaveLength(0);
});

// ---- R17: thread coalescing ----

const ROOT = "999.000000";
const suggestJobs = () => jobsOf("urgency.suggest_response");

test("R17: 5 urgent replies in one thread -> 1 notification, 1 suggest; the rest coalesced", async () => {
  const ids = Array.from({ length: 5 }, () => add({ thread: ROOT }));
  script.entries = ids.map((messageId) => ({ messageId, level: "critical" as const }));
  await run();
  expect(notifs()).toHaveLength(1);
  expect(notifs()[0]?.ref).toBe(ids[0]);
  expect(urgentEvents()).toHaveLength(1);
  expect(suggestJobs().map((j) => j.idempotencyKey)).toEqual([`urgency.suggest:${ids[0]}`]);
  for (const id of ids.slice(1)) {
    expect(msg(id)).toMatchObject({ urgencyLevel: "critical", urgencyStatus: "new" });
    expect(msg(id).screening).toMatchObject({ assessed: true, coalesced: true });
    expect(msg(id).screening.notified).toBeUndefined();
  }
  expect(msg(ids[0] as string).screening.coalesced).toBeUndefined();

  // The thread root itself, arriving later as urgent, is coalesced too.
  db.update(schema.slackMessages).set({ ts: ROOT }).where(eq(schema.slackMessages.id, add())).run();
  const rootId = `m${seq}`;
  script.entries = [{ messageId: rootId, level: "high" }];
  await run();
  expect(notifs()).toHaveLength(1);
  expect(msg(rootId).screening.coalesced).toBe(true);

  // After the notified message is resolved, a new urgent reply notifies again.
  db.update(schema.slackMessages)
    .set({ urgencyStatus: "resolved" })
    .where(eq(schema.slackMessages.id, ids[0] as string))
    .run();
  const later = add({ thread: ROOT });
  script.entries = [{ messageId: later, level: "high" }];
  await run();
  expect(notifs()).toHaveLength(2);
  expect(notifs().at(-1)?.ref).toBe(later);
  expect(suggestJobs()).toHaveLength(2);
  expect(msg(later).screening.coalesced).toBeUndefined();
});

test("R17: acknowledged and in_progress anchors still coalesce; dismissed does not", async () => {
  const first = add({ thread: ROOT });
  script.entries = [{ messageId: first, level: "critical" }];
  await run();
  for (const [status, expected] of [
    ["acknowledged", 1],
    ["in_progress", 1],
    ["dismissed", 2],
  ] as const) {
    db.update(schema.slackMessages)
      .set({ urgencyStatus: status })
      .where(eq(schema.slackMessages.id, first))
      .run();
    const reply = add({ thread: ROOT });
    script.entries = [{ messageId: reply, level: "critical" }];
    await run();
    expect(notifs()).toHaveLength(expected);
  }
});

test("R17: separate threads and top-level messages in one channel are not coalesced", async () => {
  const a = add();
  const b = add();
  const c = add({ thread: "1001.000000" }); // reply to a
  script.entries = [
    { messageId: a, level: "critical" },
    { messageId: b, level: "critical" },
    { messageId: c, level: "critical" },
  ];
  await run();
  expect(notifs().map((n) => n.ref)).toEqual([a, b]);
  expect(msg(c).screening.coalesced).toBe(true);
  expect(suggestJobs()).toHaveLength(2);
});

test("R17: medium replies never coalesce or notify; a later urgent reply still coalesces", async () => {
  const first = add({ thread: ROOT });
  const med = add({ thread: ROOT });
  script.entries = [
    { messageId: first, level: "critical" },
    { messageId: med, level: "medium" },
  ];
  await run();
  expect(msg(med).screening.coalesced).toBeUndefined();
  expect(notifs()).toHaveLength(1);
});

test("R17: deferral coalesces too; the later real assessment adds no popup and no draft", async () => {
  const ids = Array.from({ length: 3 }, () => add({ thread: ROOT, ruleLevel: "critical" }));
  script.throws = new JobError({ kind: "quota_exhausted", message: "q" });
  await expect(run()).rejects.toBeInstanceOf(JobError);
  expect(notifs()).toHaveLength(1);
  expect(msg(ids[0] as string).screening.notified).toBe(true);
  for (const id of ids.slice(1)) {
    expect(msg(id).screening).toMatchObject({ assessed: false, coalesced: true });
  }

  script.throws = undefined;
  script.entries = ids.map((messageId) => ({ messageId, level: "critical" as const }));
  await run();
  expect(notifs()).toHaveLength(1);
  expect(urgentEvents()).toHaveLength(1);
  expect(suggestJobs().map((j) => j.idempotencyKey)).toEqual([`urgency.suggest:${ids[0]}`]);
  for (const id of ids.slice(1)) expect(msg(id).screening.coalesced).toBe(true);
});
