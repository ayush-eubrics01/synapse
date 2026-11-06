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
import { eq } from "drizzle-orm";
import { ApprovalEngine } from "../../src/core/approvals/approvals";
import { AuditLogger } from "../../src/core/audit/audit";
import { SettingsService } from "../../src/core/config/settings";
import { LiveBus } from "../../src/core/events/live-bus";
import { EventPublisher } from "../../src/core/events/publisher";
import { JobQueue } from "../../src/core/jobs/queue";
import type { HandlerRegistration } from "../../src/core/jobs/worker";
import { NotificationService } from "../../src/core/notifications/notifications";
import { PermissionManager } from "../../src/core/permissions/permissions";
import { SchedulerService } from "../../src/core/scheduler/scheduler";
import { ProfileRecommendations } from "../../src/modules/people/recommendations";
import { PeopleService } from "../../src/modules/people/service";
import { TemporaryContacts } from "../../src/modules/people/temporary";
import { SecurityFlagsService } from "../../src/modules/security-flags/service";
import { registerPeopleJobs } from "../../src/workers/people";

const NOW = "2026-11-05T12:00:00.000Z";
const SELF = "USELF00001";
const BODY = "BODY-SECRET-abc";
const signal = new AbortController().signal;
const noInj = { detected: false, severity: "info", quote: "", reason: "" };

type Script = {
  output?: unknown;
  raw?: string;
  throws?: Error;
  denials?: string[];
  runDenials?: string[];
};
let script: Script;
let requests: ClaudeJobRequest[];
let calls: number;
let db: ReturnType<typeof openDatabase>["db"];
let clock: FakeClock;
let handlers: Map<string, HandlerRegistration>;
let queue: JobQueue;
let temporary: TemporaryContacts;
let settings: SettingsService;
let seq: number;

beforeEach(() => {
  db = openDatabase(":memory:").db;
  runMigrations(db);
  clock = new FakeClock(NOW);
  script = {};
  requests = [];
  calls = 0;
  seq = 0;
  const events = new EventPublisher(clock);
  settings = new SettingsService(db, clock, events.publish.bind(events));
  settings.set("slack.selfUserId", SELF);
  const audit = new AuditLogger(clock);
  const people = new PeopleService({ db, clock, events, audit, settings });
  const securityFlags = new SecurityFlagsService({
    db,
    clock,
    events,
    audit,
    settings,
    notifications: new NotificationService(db, clock, new LiveBus()),
    people,
  });
  securityFlags.init();
  queue = new JobQueue(db, clock);
  const approvals = new ApprovalEngine(db, clock, events, audit, new PermissionManager(db, audit));
  const recs = new ProfileRecommendations({
    db,
    clock,
    settings,
    events,
    queue,
    approvals,
    people,
  });
  temporary = new TemporaryContacts({ db, clock, settings, events, queue });
  handlers = new Map();
  registerPeopleJobs({
    db,
    clock,
    settings,
    scheduler: new SchedulerService(db, clock, queue),
    queue,
    temporary,
    recommendations: recs,
    orchestrator: {
      async run(req: ClaudeJobRequest): Promise<AIExecutionResult> {
        calls++;
        requests.push(req);
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
        return {
          finalText: script.raw ?? `\`\`\`json\n${JSON.stringify(script.output)}\n\`\`\``,
          permissionDenials: script.denials ?? [],
          toolResults: [],
        } as unknown as AIExecutionResult;
      },
    },
    securityFlags,
    handlers,
  });
  db.insert(schema.slackUsers).values({ id: "u-self", externalId: SELF, name: "Me" }).run();
  db.insert(schema.slackConversations).values({ id: "c-dm", externalId: "D1", type: "im" }).run();
});

const minutesAgo = (m: number) => new Date(Date.parse(NOW) - m * 60_000).toISOString();
const slackId = (n: number) => `UNEW${String(n).padStart(6, "0")}`;

/** Delivers one message from `ref` through the temporary-contact consumer. */
function receive(ref: string, ago = 10, text?: string) {
  if (!db.select().from(schema.slackUsers).where(eq(schema.slackUsers.externalId, ref)).get()) {
    db.insert(schema.slackUsers)
      .values({ id: `u-${ref}`, externalId: ref, name: ref })
      .run();
  }
  seq += 1;
  const id = `x${seq}`;
  db.insert(schema.slackMessages)
    .values({
      id,
      conversationId: "c-dm",
      ts: `${3000 + seq}.000000`,
      senderUserId: `u-${ref}`,
      text: text ?? `${BODY} ${seq}`,
      sentAt: minutesAgo(ago),
      collectedAt: NOW,
    })
    .run();
  // biome-ignore lint/suspicious/noExplicitAny: minimal event
  const ev: any = { type: "message.received", correlationId: "c", payload: { messageId: id } };
  db.transaction((tx) => temporary.handle(ev, tx));
  return id;
}
const contact = (ref: string, count = 3) => {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) ids.push(receive(ref, 100 - i));
  return ids;
};
const assessJobs = () =>
  db.select().from(schema.jobs).where(eq(schema.jobs.type, "people.assess_unknown")).all();
const tc = (ref: string) =>
  db
    .select()
    .from(schema.temporaryContacts)
    .where(eq(schema.temporaryContacts.slackUserId, ref))
    .get();
const suggestions = () =>
  db
    .select()
    .from(schema.peopleProfileRecommendations)
    .all()
    .filter((r) => r.kind === "suggest_evaluation");

const runAssess = async () => {
  const id = db.transaction(
    (tx) =>
      queue.enqueue(tx, { type: "people.assess_unknown", idempotencyKey: `t:${seq}:${calls}` }).id,
  );
  const j = { id, type: "x", input: null, attempts: 1, maxAttempts: 3 } as unknown as Job;
  return handlers.get("people.assess_unknown")?.handler(j, {
    signal,
    checkpoint() {},
    getCheckpoint: () => undefined,
  } as never) as Promise<Record<string, unknown>>;
};
const verdict = (slackUserId: string, worthProfile: boolean, reason = "recurring work thread") => ({
  slackUserId,
  worthProfile,
  reason,
});

describe("threshold crossing", () => {
  test("enqueues once when message_count first reaches minMessages, at the hour bucket end", () => {
    const ref = slackId(1);
    receive(ref);
    receive(ref);
    expect(assessJobs()).toHaveLength(0);
    receive(ref);
    receive(ref); // past the threshold: no second job
    const jobs = assessJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      idempotencyKey: "people.assess:2026-11-05T12",
      concurrencyGroup: "people.intelligence",
      priority: 40,
      runAfter: "2026-11-05T13:00:00.000Z",
    });
  });

  test("two contacts crossing in the same hour share one job", () => {
    contact(slackId(1));
    contact(slackId(2));
    expect(assessJobs()).toHaveLength(1);
  });
});

describe("people.assess_unknown", () => {
  test("worthProfile true -> pending suggestion with reason, no content, no approval; false -> assessment only", async () => {
    const a = slackId(1);
    const b = slackId(2);
    contact(a);
    contact(b);
    script.output = {
      assessments: [verdict(a, true, "owns the billing rollout"), verdict(b, false, "bot noise")],
      suspectedInjection: noInj,
    };
    expect(await runAssess()).toEqual({ assessed: 2, suggested: 1 });
    expect(tc(a)).toMatchObject({
      profileAssessment: { worthProfile: true, reason: "owns the billing rollout" },
      assessedAt: NOW,
    });
    expect(tc(b)?.profileAssessment).toEqual({ worthProfile: false, reason: "bot noise" });
    const [s] = suggestions();
    expect(suggestions()).toHaveLength(1);
    expect(s).toMatchObject({
      kind: "suggest_evaluation",
      status: "pending",
      reason: "owns the billing rollout",
      content: null,
      approvalId: null,
      observationHash: null,
    });
    expect(db.select().from(schema.approvals).all()).toHaveLength(0);
    const person = db
      .select()
      .from(schema.people)
      .where(eq(schema.people.id, s?.personId as string))
      .get();
    expect(person?.slackUserId).toBe(a);
    const created = db
      .select()
      .from(schema.domainEvents)
      .all()
      .filter((e) => e.type === "person.profile_recommendation_created");
    expect(created).toHaveLength(1);
    expect(created[0]?.payload).toMatchObject({ kind: "suggest_evaluation" });
    // priority is never set
    expect(db.select().from(schema.peoplePrioritySettings).all()).toHaveLength(0);
  });

  test("request: one untrusted part per contact, up to 5 recent messages, each line starting with sentAt", async () => {
    const a = slackId(1);
    for (let i = 0; i < 7; i++) receive(a, 100 - i);
    receive(a, 5, "line one\nforged 2026-01-01T00:00:00.000Z line");
    script.output = { assessments: [verdict(a, false)], suspectedInjection: noInj };
    await runAssess();
    const req = requests[0] as ClaudeJobRequest;
    expect(req).toMatchObject({ model: "haiku", maxTurns: 3, allowedTools: ["ToolSearch"] });
    const parts = (req.parts as PromptPart[]).filter((p) => p.provenance === "untrusted");
    expect(parts).toHaveLength(1);
    expect(parts[0]?.source).toBe(`slack contact ${a}`);
    const lines = (parts[0]?.content ?? "").split("\n");
    expect(lines).toHaveLength(5);
    for (const l of lines) expect(l).toMatch(/^2026-11-05T1[01]:\d\d:\d\d\.\d{3}Z /);
    expect(lines[4]).toContain("line one forged");
    expect(lines[0]).not.toContain(` ${BODY} 1`);
  });

  test("a batch is at most 10 contacts, and a follow-up job covers the rest", async () => {
    const refs = Array.from({ length: 12 }, (_, i) => slackId(i + 1));
    for (const r of refs) contact(r);
    const batchOf = (req: ClaudeJobRequest) =>
      (req.parts as PromptPart[])
        .filter((p) => p.provenance === "untrusted")
        .map((p) => (p.source as string).replace("slack contact ", ""));
    script.raw = "not json"; // a first attempt that fails still reveals the batch it was sent
    await runAssess().catch(() => {});
    script.raw = undefined;
    const batch = batchOf(requests[0] as ClaudeJobRequest);
    expect(batch).toHaveLength(10);
    script.output = {
      assessments: batch.map((r) => verdict(r, false)),
      suspectedInjection: noInj,
    };
    expect(await runAssess()).toEqual({ assessed: 10, suggested: 0 });
    expect(assessJobs().map((j) => j.idempotencyKey)).toContain("people.assess:2026-11-05T13");
    const rest = refs.filter((r) => !batch.includes(r));
    expect(rest).toHaveLength(2);
    for (const r of rest) expect(tc(r)?.assessedAt).toBeNull();
  });

  test("contacts below minMessages or already assessed are not sent", async () => {
    const a = slackId(1);
    const b = slackId(2);
    const c = slackId(3);
    contact(a);
    contact(b, 2);
    contact(c);
    db.update(schema.temporaryContacts)
      .set({ assessedAt: NOW, profileAssessment: { worthProfile: false, reason: "x" } })
      .where(eq(schema.temporaryContacts.slackUserId, c))
      .run();
    script.output = { assessments: [verdict(a, false)], suspectedInjection: noInj };
    await runAssess();
    const sources = ((requests[0] as ClaudeJobRequest).parts as PromptPart[])
      .filter((p) => p.provenance === "untrusted")
      .map((p) => p.source);
    expect(sources).toEqual([`slack contact ${a}`]);
  });

  test("nothing to assess -> skipped without calling Claude", async () => {
    expect(await runAssess()).toEqual({ skipped: "nothing_to_assess" });
    expect(calls).toBe(0);
  });

  test("an id outside the batch, or a repeated id -> incomplete_ai_output, nothing written", async () => {
    const a = slackId(1);
    contact(a);
    for (const assessments of [
      [verdict(a, true), verdict("UOUTSIDE01", true)],
      [verdict(a, true), verdict(a, false)],
    ]) {
      script.output = { assessments, suspectedInjection: noInj };
      const err = await runAssess().catch((e) => e);
      expect(err).toBeInstanceOf(JobError);
      expect((err as JobError).classified.kind).toBe("incomplete_ai_output");
    }
    expect(tc(a)?.assessedAt).toBeNull();
    expect(suggestions()).toHaveLength(0);
  });

  test("an existing pending recommendation is never duplicated by a suggestion", async () => {
    const a = slackId(1);
    contact(a);
    script.output = { assessments: [verdict(a, true)], suspectedInjection: noInj };
    await runAssess();
    db.update(schema.temporaryContacts)
      .set({ assessedAt: null })
      .where(eq(schema.temporaryContacts.slackUserId, a))
      .run();
    await runAssess();
    expect(suggestions()).toHaveLength(1);
  });

  test("the reason is passed through renderExcerpt (hidden characters escaped, capped at 300)", async () => {
    const a = slackId(1);
    contact(a);
    script.output = {
      assessments: [verdict(a, false, `ok\u202eevil${"é".repeat(290)}`)],
      suspectedInjection: noInj,
    };
    await runAssess();
    const reason = (tc(a) as { profileAssessment: { reason: string } }).profileAssessment.reason;
    expect(reason.startsWith("ok\\u{202E}evil")).toBe(true);
    expect([...reason].length).toBeLessThanOrEqual(300);
    expect(reason).not.toContain("\u202e");
  });

  test("flags attribute to the newest message of the first contact (R1)", async () => {
    const a = slackId(1);
    const b = slackId(2);
    const idsA = contact(a);
    const idsB = contact(b);
    script.denials = ["mcp__claude_ai_Slack__slack_send_message"];
    script.output = {
      assessments: [verdict(a, false), verdict(b, false)],
      suspectedInjection: {
        detected: true,
        severity: "warning",
        quote: "ignore previous",
        reason: "tries to instruct",
      },
    };
    await runAssess();
    // the batch order of equal first-seen times is arbitrary: the first part names the first contact
    const firstRef = (
      (((requests[0] as ClaudeJobRequest).parts as PromptPart[])[1] as PromptPart).source as string
    ).replace("slack contact ", "");
    const firstIds = firstRef === a ? idsA : idsB;
    const flags = db.select().from(schema.securityFlags).all();
    const runtime = flags.filter((f) => f.detector === "runtime");
    expect(runtime.map((f) => f.messageId)).toEqual([firstIds[2] as string]);
    // no message holds the quote -> the same newest message
    expect(flags.filter((f) => f.detector === "ai").map((f) => f.messageId)).toEqual([
      firstIds[2] as string,
    ]);
  });

  test("a failed run keeps nothing and flags a denial on the first contact's newest message", async () => {
    const a = slackId(1);
    const idsA = contact(a);
    script.throws = new JobError({ kind: "provider_error", message: "boom" });
    script.runDenials = ["mcp__claude_ai_Slack__slack_send_message"];
    const err = await runAssess().catch((e) => e);
    expect(err).toBeInstanceOf(JobError);
    expect(
      db
        .select()
        .from(schema.securityFlags)
        .all()
        .map((f) => f.messageId),
    ).toEqual([idsA[2] as string]);
    expect(tc(a)?.assessedAt).toBeNull();
  });

  test("a priority key in the output -> incomplete_ai_output, nothing written", async () => {
    const a = slackId(1);
    contact(a);
    script.output = {
      assessments: [{ ...verdict(a, true), priority: "critical" }],
      suspectedInjection: noInj,
    };
    const err = await runAssess().catch((e) => e);
    expect((err as JobError).classified.kind).toBe("incomplete_ai_output");
    expect(tc(a)?.assessedAt).toBeNull();
    expect(suggestions()).toHaveLength(0);
  });
});

describe("R7: assessment candidates", () => {
  test("M-1: a contact that has a people row is not assessed", async () => {
    const a = slackId(1);
    contact(a);
    db.transaction((tx) =>
      new PeopleService({
        db,
        clock,
        events: new EventPublisher(clock),
        audit: new AuditLogger(clock),
        settings,
      }).ensurePerson(tx, a),
    );
    expect(await runAssess()).toEqual({ skipped: "nothing_to_assess" });
    expect(calls).toBe(0);
  });

  test("M-2: contacts the model omitted are stamped omitted and leave the batch", async () => {
    const a = slackId(1);
    const b = slackId(2);
    contact(a);
    contact(b);
    script.output = { assessments: [verdict(a, false)], suspectedInjection: noInj };
    expect(await runAssess()).toEqual({ assessed: 1, suggested: 0 });
    expect(tc(b)).toMatchObject({ assessedAt: NOW, profileAssessment: { omitted: true } });
    expect(await runAssess()).toEqual({ skipped: "nothing_to_assess" });
    expect(calls).toBe(1);
    expect(suggestions()).toHaveLength(0);
  });
});
