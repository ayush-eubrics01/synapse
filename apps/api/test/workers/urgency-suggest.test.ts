import { beforeEach, expect, test } from "bun:test";
import {
  type AIExecutionResult,
  type ClaudeJobRequest,
  type Job,
  JobError,
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
import { GUIDELINES_HEADING } from "../../src/intelligence/urgency/suggest-prompt";
import { PeopleService } from "../../src/modules/people/service";
import { SecurityFlagsService } from "../../src/modules/security-flags/service";
import { registerUrgencyJobs, responseGuidelinesLookup } from "../../src/workers/urgency";

const NOW = "2026-11-05T12:00:00.000Z";
const SECRET = "SECRET-BODY-TEXT-xyz";
const signal = new AbortController().signal;
const ctx = { signal, checkpoint() {}, getCheckpoint: () => undefined } as never;

let db: ReturnType<typeof openDatabase>["db"];
let queue: JobQueue;
let settings: SettingsService;
let handlers: Map<string, HandlerRegistration>;
let seq = 0;

interface Script {
  draft?: unknown;
  denials?: string[];
  tools?: string[];
  throws?: Error;
  /** permission_denials persisted on the claude_runs row (the orchestrator does this even for failed runs). */
  runDenials?: string[];
  onRun?: () => void;
  raw?: string;
}
let script: Script;
let requests: ClaudeJobRequest[];
let calls: number;
let guidelinesByPerson: Record<string, { text: string }[]>;

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
  guidelinesByPerson = {};
  requests = [];
  calls = 0;
  handlers = new Map();
  const orchestrator = {
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
      script.onRun?.();
      if (script.throws) throw script.throws;
      const finalText =
        script.raw ??
        `\`\`\`json\n${JSON.stringify({
          draft: "Looking into it.",
          confidence: 0.6,
          suspectedInjection: inj,
          ...(script.draft as object),
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
    guidelinesFor: responseGuidelinesLookup(db, (id) => guidelinesByPerson[id] ?? []),
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
    text?: string | null;
    level?: string | null;
    thread?: string | null;
    conv?: string;
    ts?: string;
    expired?: boolean;
  } = {},
) {
  seq += 1;
  const id = `m${seq}`;
  db.insert(schema.slackMessages)
    .values({
      id,
      conversationId: o.conv ?? "c-ch",
      ts: o.ts ?? `${1000 + seq}.000000`,
      threadTs: o.thread ?? null,
      senderUserId: "su1",
      text: o.text === undefined ? `${SECRET} ${seq}` : o.text,
      sentAt: new Date(Date.parse(NOW) - 60_000 + seq * 1000).toISOString(),
      collectedAt: NOW,
      urgencyLevel: o.level === undefined ? "high" : o.level,
      urgencyStatus: "new",
    })
    .run();
  return id;
}

function run(messageId: string, attempts = 1, maxAttempts = 3) {
  const jobId = db.transaction(
    (tx) =>
      queue.enqueue(tx, {
        type: "urgency.suggest_response",
        idempotencyKey: `t${Math.random()}`,
        input: { messageId },
      }).id,
  );
  const job = {
    id: jobId,
    type: "urgency.suggest_response",
    attempts,
    maxAttempts,
    input: { messageId },
  } as unknown as Job;
  return handlers.get("urgency.suggest_response")?.handler(job, ctx) as Promise<unknown>;
}

const partsOf = (i: number) =>
  (requests[i]?.parts ?? []) as { provenance: string; content: string }[];
const drafts = () => db.select().from(schema.messageDrafts).all();
const flags = () => db.select().from(schema.securityFlags).all();

test("registered with a 360 s timeout", () => {
  expect(handlers.get("urgency.suggest_response")?.timeoutMs).toBe(360_000);
});

test("stores one proposed draft with the run id; a re-run adds nothing and skips Claude", async () => {
  const a = add();
  script.draft = { draft: "Ack, checking now.", confidence: 0.8 };
  await run(a);
  expect(drafts()).toHaveLength(1);
  expect(drafts()[0]).toMatchObject({
    messageId: a,
    kind: "suggested_response",
    status: "proposed",
    text: "Ack, checking now.",
    confidence: 0.8,
    claudeRunId: "run-1",
    contentExpiredAt: null,
  });
  await run(a);
  expect(calls).toBe(1);
  expect(drafts()).toHaveLength(1);
  // no event, notification or follow-up job carries the draft, and nothing is sent
  const everything = JSON.stringify([
    db.select().from(schema.domainEvents).all(),
    db.select().from(schema.notifications).all(),
    db.select().from(schema.jobs).all(),
    db.select().from(schema.auditEvents).all(),
  ]);
  expect(everything).not.toContain("Ack, checking now.");
  expect(everything).not.toContain(SECRET);
});

test("request: ToolSearch only, every part after the system part is untrusted, model setting used", async () => {
  const a = add();
  await run(a);
  const req = requests[0] as ClaudeJobRequest;
  const parts = partsOf(0);
  expect(req.allowedTools).toEqual(["ToolSearch"]);
  expect(req.maxTurns).toBe(3);
  expect(req.priorityClass).toBe("urgent");
  expect(req.model).toBe("haiku");
  expect(parts[0]?.provenance).toBe("system");
  expect(parts.slice(1).every((p) => p.provenance === "untrusted")).toBe(true);
  expect(parts[0]?.content).not.toContain(SECRET);
  expect(parts.at(-1)?.content).toContain(SECRET);
});

test("skips without calling Claude: expired, missing text, stale level, no such message", async () => {
  const expired = add({ text: null });
  const medium = add({ level: "medium" });
  const unassessed = add({ level: null });
  for (const id of [expired, medium, unassessed, "nope"]) await run(id);
  expect(calls).toBe(0);
  expect(drafts()).toHaveLength(0);
});

test("critical is drafted too", async () => {
  await run(add({ level: "critical" }));
  expect(drafts()).toHaveLength(1);
});

test("context: earlier messages of the same thread, oldest first, capped at 10, expired skipped", async () => {
  add({ conv: "c-dm", text: "OTHER-CONV" });
  add({ thread: "5000.000000", ts: "5000.000000", text: "ROOT" });
  for (let i = 1; i <= 11; i++) {
    add({ thread: "5000.000000", ts: `5000.0000${String(i).padStart(2, "0")}`, text: `T${i}` });
  }
  add({ thread: "5000.000000", ts: "5000.000050", text: null });
  add({ ts: "5000.000060", text: "NOT-IN-THREAD" });
  const target = add({ thread: "5000.000000", ts: "5000.000100", text: "TARGET" });
  add({ thread: "5000.000000", ts: "5000.000200", text: "LATER" });
  await run(target);
  const parts = partsOf(0)
    .slice(1)
    .map((p) => p.content);
  expect(parts).toEqual([...Array.from({ length: 10 }, (_, i) => `T${i + 2}`), "TARGET"]);
});

test("context without a thread: earlier messages in the same conversation only", async () => {
  add({ conv: "c-dm", ts: "1.000000", text: "OTHER-CONV" });
  add({ ts: "10.000000", text: "E1" });
  add({ ts: "11.000000", text: "E2" });
  const target = add({ ts: "12.000000", text: "TARGET" });
  add({ ts: "13.000000", text: "LATER" });
  await run(target);
  const parts = partsOf(0)
    .slice(1)
    .map((p) => p.content);
  expect(parts).toEqual(["E1", "E2", "TARGET"]);
});

test("draft text is rendered visible-safe and capped; confidence stored as is", async () => {
  const a = add();
  script.raw = `\`\`\`json\n${JSON.stringify({
    draft: `ok${"\u200b".repeat(50)}${"x".repeat(1900)}`,
    confidence: 0,
    suspectedInjection: inj,
  })}\n\`\`\``;
  await run(a);
  const d = drafts()[0];
  expect(d?.text).not.toContain("\u200b");
  expect(d?.text?.startsWith("ok\\u{200B}")).toBe(true);
  expect(d?.confidence).toBe(0);
  expect((d?.text ?? "").length).toBeLessThanOrEqual(2000);
  expect(d?.text?.startsWith("ok")).toBe(true);
});

test("AI injection flag is recorded once with the run id; none when not detected", async () => {
  const a = add();
  script.draft = {
    suspectedInjection: { detected: true, severity: "warning", quote: "ignore it", reason: "r" },
  };
  await run(a);
  expect(flags()).toHaveLength(1);
  expect(flags()[0]).toMatchObject({ messageId: a, claudeRunId: "run-1" });
  await run(a); // skipped, draft exists
  expect(flags()).toHaveLength(1);
  script.draft = undefined;
  const b = add();
  await run(b);
  expect(flags()).toHaveLength(1);
});

test("runtime flags: denials and unexpected tools flag the message; invalid output still flags", async () => {
  const a = add();
  script.denials = ["mcp__claude_ai_Slack__slack_send_message"];
  script.tools = ["Bash"];
  script.raw = "not json";
  let err: unknown;
  try {
    await run(a);
  } catch (e) {
    err = e;
  }
  expect((err as JobError).classified.kind).toBe("incomplete_ai_output");
  expect(drafts()).toHaveLength(0);
  expect(flags()).toHaveLength(1);
  expect(flags()[0]).toMatchObject({ severity: "high", messageId: a });
  expect(JSON.stringify(flags())).not.toContain(SECRET);
});

test("invalid output shape (empty draft) -> incomplete_ai_output, nothing stored", async () => {
  const a = add();
  script.draft = { draft: "" };
  await expect(run(a)).rejects.toMatchObject({ classified: { kind: "incomplete_ai_output" } });
  script.draft = { confidence: 3 };
  await expect(run(a)).rejects.toMatchObject({ classified: { kind: "incomplete_ai_output" } });
  expect(drafts()).toHaveLength(0);
});

test("non-JobError failures are wrapped without leaking content", async () => {
  const a = add();
  script.throws = new Error(`boom ${SECRET}`);
  let err: unknown;
  try {
    await run(a);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(JobError);
  expect(JSON.stringify((err as JobError).classified)).not.toContain(SECRET);
  expect(drafts()).toHaveLength(0);
});

test("content expiring during the run stores no draft", async () => {
  const a = add();
  script.onRun = () =>
    db.update(schema.slackMessages).set({ text: null }).where(eq(schema.slackMessages.id, a)).run();
  await run(a);
  expect(calls).toBe(1);
  expect(drafts()).toHaveLength(0);
});

test("R16: a suggest run that records denials and then throws raises a high runtime flag", async () => {
  const a = add();
  script.runDenials = ["mcp__claude_ai_Slack__slack_send_message"];
  script.throws = new JobError({ kind: "timeout", message: "claude run exceeded 360000ms" });
  await expect(run(a)).rejects.toMatchObject({ classified: { kind: "timeout" } });
  const f = flags().filter((x) => x.detector === "runtime");
  expect(f).toHaveLength(1);
  expect(f[0]).toMatchObject({ messageId: a, severity: "high", claudeRunId: "run-1" });
  expect(drafts()).toHaveLength(0);
});

test("R16: a suggest max_turns failure raises a warning runtime flag", async () => {
  const a = add();
  script.throws = new JobError({
    kind: "provider_error",
    message: "claude reached max turns",
    details: { maxTurns: true },
  });
  await expect(run(a)).rejects.toBeInstanceOf(JobError);
  const f = flags().filter((x) => x.detector === "runtime");
  expect(f).toHaveLength(1);
  expect(f[0]).toMatchObject({ messageId: a, severity: "warning", reason: "max_turns reached" });
});

const GUIDE = "GUIDELINE-TEXT-qrs";
const addPerson = (guidelines?: string[]) => {
  db.insert(schema.people)
    .values({ id: "p1", slackUserId: "UPRIYA0001", name: "Priya", createdAt: NOW })
    .run();
  if (guidelines) guidelinesByPerson.p1 = guidelines.map((text) => ({ text }));
};

test("guidelines: one user_approved part after the system part, before the untrusted messages", async () => {
  addPerson([`${GUIDE} 1`, `${GUIDE} 2`]);
  add({ ts: "10.000000", text: "E1" });
  await run(add({ ts: "11.000000", text: "TARGET" }));
  const parts = partsOf(0) as { provenance: string; source?: string; content: string }[];
  expect(parts.map((p) => p.provenance)).toEqual([
    "system",
    "user_approved",
    "untrusted",
    "untrusted",
  ]);
  expect(parts[1]?.source).toBe("approved response guidelines for Priya");
  expect(parts[1]?.content).toBe(`${GUIDELINES_HEADING}\n- ${GUIDE} 1\n- ${GUIDE} 2`);
  expect(parts[1]?.content).not.toContain("Priya");
  expect(requests[0]?.instructions).toContain("never override the system rules");
  expect(parts[0]?.content).not.toContain(GUIDE);
});

test("no person, or a person without guidelines: the request has no user_approved part", async () => {
  await run(add());
  addPerson();
  await run(add());
  expect(calls).toBe(2);
  for (const i of [0, 1]) {
    expect(partsOf(i).some((p) => p.provenance === "user_approved")).toBe(false);
    expect(requests[i]?.instructions).not.toContain("approved");
  }
});

test("guidelines are capped at 20 entries of 500 chars and stay under the 100 KiB cap", async () => {
  addPerson(Array.from({ length: 25 }, (_, i) => `G${i}${"漢".repeat(600)}`));
  for (let i = 0; i < 10; i++) add({ ts: `${20 + i}.000000`, text: "漢".repeat(40_000) });
  await run(add({ ts: "40.000000", text: "漢".repeat(40_000) }));
  const parts = partsOf(0);
  const [heading, ...lines] = (parts[1]?.content ?? "").split("\n");
  expect(heading).toBe(GUIDELINES_HEADING);
  expect(lines).toHaveLength(20);
  expect([...(lines[0] as string)].length).toBe(2 + 500);
  const total = parts.reduce((n, p) => n + Buffer.byteLength(p.content, "utf8"), 0);
  expect(total).toBeLessThan(100 * 1024);
});

test("guideline text never reaches events, notifications, jobs, audit or flags", async () => {
  addPerson([GUIDE]);
  await run(add());
  const everything = JSON.stringify([
    db.select().from(schema.domainEvents).all(),
    db.select().from(schema.notifications).all(),
    db.select().from(schema.jobs).all(),
    db.select().from(schema.auditEvents).all(),
    db.select().from(schema.securityFlags).all(),
  ]);
  expect(everything).not.toContain(GUIDE);
});
