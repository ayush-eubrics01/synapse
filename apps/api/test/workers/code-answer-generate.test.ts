import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AIExecutionResult,
  type ClaudeJobRequest,
  type Job,
  JobError,
  type RawToolResult,
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
import {
  CODE_ANSWER_JOB,
  CodeAnswerError,
  CodeAnswerService,
} from "../../src/modules/code-answers/service";
import { PeopleService } from "../../src/modules/people/service";
import { SecurityFlagsService } from "../../src/modules/security-flags/service";
import { registerCodeAnswerJob } from "../../src/workers/code-answer/generate";
import { makeDemoRepo, tempDir } from "../fixtures/git-repo";

const NOW = "2026-11-06T09:00:00.000Z";
const QUESTION = "QUESTION-TEXT-MARKER where is config loaded?";
const ANSWER = "ANSWER-TEXT-MARKER it lives in src/a.ts";
const roots: string[] = [];
afterAll(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});
const ctx = {
  signal: new AbortController().signal,
  checkpoint() {},
  getCheckpoint: () => undefined,
} as never;

const tool = (
  toolName: string,
  input: unknown,
  content: string,
  isError = false,
): RawToolResult => ({
  toolUseId: `t-${Math.random()}`,
  toolName,
  input,
  isError,
  content,
});

function result(finalText: string, over: Partial<AIExecutionResult> = {}): AIExecutionResult {
  return {
    status: "succeeded",
    toolResults: [tool("Read", { file_path: join(repo, "src/a.ts") }, "1\tx")],
    finalText,
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
    ...over,
  };
}

const NO_INJECTION = { detected: false, severity: "warning", quote: "", reason: "" };
const answerOf = (over: Record<string, unknown> = {}) =>
  `\`\`\`json\n${JSON.stringify({
    answerable: true,
    answer: ANSWER,
    confidence: 0.8,
    evidence: [{ path: "src/a.ts", line: 1 }],
    suspectedInjection: NO_INJECTION,
    ...over,
  })}\n\`\`\``;

let db: ReturnType<typeof openDatabase>["db"];
let queue: JobQueue;
let service: CodeAnswerService;
let settings: SettingsService;
let handlers: Map<string, HandlerRegistration>;
let repo: string;
let repoId: string;
let messageId: string;
let requests: ClaudeJobRequest[];
let reply: () => AIExecutionResult;
let attempt: (req: ClaudeJobRequest) => void;
let clock: FakeClock;

beforeEach(() => {
  db = openDatabase(":memory:").db;
  runMigrations(db);
  clock = new FakeClock(NOW);
  const events = new EventPublisher(clock);
  settings = new SettingsService(db, clock, events.publish.bind(events));
  const audit = new AuditLogger(clock);
  queue = new JobQueue(db, clock);
  handlers = new Map();
  const securityFlags = new SecurityFlagsService({
    db,
    clock,
    events,
    audit,
    settings,
    notifications: new NotificationService(db, clock, new LiveBus()),
    people: new PeopleService({ db, clock, events, audit, settings }),
  });
  securityFlags.init();
  service = new CodeAnswerService({
    db,
    clock,
    events,
    audit,
    queue,
    settings,
    securityFlags,
    outgoing: {
      requestSend: () => {
        throw new Error("never sends");
      },
    },
  });
  const parent = tempDir();
  roots.push(parent);
  repo = makeDemoRepo(parent, "demo-app");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src/a.ts"), "export {};\n");
  writeFileSync(join(repo, "src/b.ts"), "export {};\n");
  requests = [];
  reply = () => result(answerOf());
  attempt = () => {};
  registerCodeAnswerJob({
    db,
    settings,
    orchestrator: {
      run: async (req: ClaudeJobRequest) => {
        requests.push(req);
        attempt(req);
        db.insert(schema.claudeRuns)
          .values({
            id: `run-${requests.length}`,
            jobId: req.jobId ?? null,
            workerProfile: "reader",
            status: "ok",
            startedAt: clock.now().toISOString(),
          })
          .run();
        return reply();
      },
    },
    service,
    handlers,
  });
  repoId = "repo-1";
  insertRepo();
  db.insert(schema.slackUsers).values({ id: "su-1", externalId: "UPRIO00001", name: "Pat" }).run();
  db.insert(schema.slackConversations)
    .values({ id: "c-1", externalId: "C0CHAN0001", type: "channel", name: "dev" })
    .run();
  messageId = addMessage({ text: QUESTION });
});

let seq = 0;
function addMessage(o: {
  text?: string | null;
  thread?: string | null;
  sentAt?: string;
  ts?: string;
}) {
  seq += 1;
  const id = `m${seq}`;
  db.insert(schema.slackMessages)
    .values({
      id,
      conversationId: "c-1",
      ts: o.ts ?? `${1000 + seq}.000000`,
      threadTs: o.thread ?? null,
      senderUserId: "su-1",
      text: o.text === undefined ? "hi" : o.text,
      sentAt: o.sentAt ?? new Date(Date.parse(NOW) - 600_000 + seq * 1000).toISOString(),
      collectedAt: NOW,
    })
    .run();
  return id;
}

const insertRepo = () =>
  db
    .insert(schema.repositories)
    .values({
      id: repoId,
      name: "demo-app",
      localPath: repo,
      upstreamPushDisabled: true,
      trackedBranch: "main",
      jiraProjectKeys: [],
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run();

const create = (trigger: "user" | "away" = "user") =>
  db.transaction((tx) => service.create(tx, { messageId, repositoryId: repoId, trigger }));
const run = (id: string) => {
  const jobRow = db
    .select()
    .from(schema.jobs)
    .where(eq(schema.jobs.type, CODE_ANSWER_JOB))
    .all()
    .find((j) => (j.input as { codeAnswerId?: string } | null)?.codeAnswerId === id);
  const job = { id: jobRow?.id ?? "j", type: CODE_ANSWER_JOB, input: { codeAnswerId: id } } as Job;
  return (handlers.get(CODE_ANSWER_JOB) as HandlerRegistration).handler(job, ctx);
};
const rowOf = (id: string) =>
  db.select().from(schema.codeAnswers).where(eq(schema.codeAnswers.id, id)).get();
const events = () =>
  db
    .select()
    .from(schema.domainEvents)
    .where(eq(schema.domainEvents.type, "code_answer.status_changed"))
    .all();
const flags = () => db.select().from(schema.securityFlags).all();

describe("create", () => {
  test("queues one row and one job with the row id in the key; a live duplicate is refused", () => {
    const id = create();
    expect(rowOf(id)?.status).toBe("queued");
    const job = db.select().from(schema.jobs).where(eq(schema.jobs.type, CODE_ANSWER_JOB)).get();
    expect(job?.idempotencyKey).toBe(`code-answer:${messageId}:${repoId}:${id}`);
    expect(job?.maxAttempts).toBe(1);
    expect(job?.priority).toBe(150);
    expect(() => create()).toThrow(CodeAnswerError);
  });

  test("a failed row can be retried with a new row and job", async () => {
    const id = create();
    db.delete(schema.repositories).where(eq(schema.repositories.id, repoId)).run();
    await run(id);
    expect(rowOf(id)?.status).toBe("failed");
    insertRepo();
    expect(create()).not.toBe(id);
  });
});

describe("code_answer.generate", () => {
  test("ready: only observed, existing citations are kept; one status event per transition", async () => {
    settings.set("codeAnswer.model", "haiku");
    const id = create();
    reply = () =>
      result(
        answerOf({
          evidence: [{ path: "src/a.ts" }, { path: "src/ghost.ts" }],
        }),
      );
    await run(id);
    const row = rowOf(id);
    expect(row?.status).toBe("ready");
    expect(row?.answer).toBe(ANSWER);
    expect(row?.evidence).toEqual([{ path: "src/a.ts" }]);
    expect(row?.droppedEvidenceCount).toBe(1);
    expect(row?.claudeRunId).toBe("run-1");
    const req = requests[0] as ClaudeJobRequest;
    expect(req.workerProfile).toBe("reader");
    expect(req.workingDirectory).toBe(repo);
    expect(req.model).toBe("haiku");
    expect(events().map((e) => (e.payload as { status: string }).status)).toEqual([
      "queued",
      "running",
      "ready",
    ]);
  });

  test("the request carries approved facts and earlier thread messages as the right parts", async () => {
    db.insert(schema.projects)
      .values({ id: "p1", name: "Demo Project", createdAt: NOW, updatedAt: NOW })
      .run();
    db.insert(schema.projectRepositories).values({ projectId: "p1", repositoryId: repoId }).run();
    const fact = (id: string, status: "approved" | "needs_review", content: string) =>
      db
        .insert(schema.projectFacts)
        .values({
          id,
          projectId: "p1",
          kind: "note",
          content,
          evidence: [],
          status,
          source: "user",
          createdAt: NOW,
        })
        .run();
    fact("f1", "approved", "Uses Bun.");
    fact("f2", "needs_review", "Unreviewed claim.");
    const root = addMessage({ text: "thread root", ts: "500.000000" });
    void root;
    const q = addMessage({ text: "thread question", thread: "500.000000", ts: "501.000000" });
    messageId = q;
    const id = create();
    await run(id);
    const parts = (requests[0] as ClaudeJobRequest).parts ?? [];
    expect(parts.map((p) => p.provenance)).toEqual([
      "system",
      "system",
      "user_approved",
      "untrusted",
    ]);
    expect(parts[2]?.content).toContain("Uses Bun.");
    expect(parts[2]?.content).not.toContain("Unreviewed");
    expect(parts[3]?.content).toContain("thread question");
  });

  test("unverified: every citation unread leaves no answer", async () => {
    const id = create();
    reply = () => result(answerOf({ evidence: [{ path: "src/b.ts" }] }));
    await run(id);
    const row = rowOf(id);
    expect(row?.status).toBe("unverified");
    expect(row?.answer).toBeNull();
    expect(row?.failure).toBe("evidence_unverified");
  });

  test("no tool result fails the row and the job", async () => {
    const id = create();
    reply = () => result(answerOf(), { toolResults: [] });
    let err: unknown;
    await run(id).catch((e) => {
      err = e;
    });
    expect((err as JobError).classified.kind).toBe("incomplete_ai_output");
    expect(rowOf(id)).toMatchObject({ status: "failed", failure: "no_tool_result" });
  });

  test("a failed Read alone is not a tool result", async () => {
    const id = create();
    reply = () =>
      result(answerOf(), {
        toolResults: [tool("Read", { file_path: join(repo, "src/a.ts") }, "nope", true)],
      });
    await run(id).catch(() => {});
    expect(rowOf(id)?.failure).toBe("no_tool_result");
  });

  test("not answerable stores its reason and no answer", async () => {
    const id = create();
    reply = () =>
      result(
        answerOf({
          answerable: false,
          answer: "",
          evidence: [],
          notAnswerableReason: "Not in this repo",
        }),
      );
    await run(id);
    expect(rowOf(id)).toMatchObject({
      status: "not_answerable",
      answer: null,
      notAnswerableReason: "Not in this repo",
    });
  });

  test("unparseable output is parse_failed", async () => {
    const id = create();
    reply = () => result("just prose");
    await run(id).catch(() => {});
    expect(rowOf(id)).toMatchObject({ status: "failed", failure: "parse_failed" });
  });

  test("suspected injection raises an AI flag for the message and is stored", async () => {
    const id = create();
    reply = () =>
      result(
        answerOf({
          suspectedInjection: {
            detected: true,
            severity: "high",
            quote: "do x",
            reason: "tries to instruct",
          },
        }),
      );
    await run(id);
    expect(rowOf(id)?.suspectedInjection).toMatchObject({ detected: true, severity: "high" });
    const f = flags();
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ messageId, detector: "ai" });
  });

  test("a denied Bash raises a high runtime flag; a denied Read only a warning", async () => {
    const id = create();
    reply = () => result(answerOf(), { permissionDenials: ["Bash"] });
    await run(id);
    expect(flags().find((f) => f.detector === "runtime")?.severity).toBe("high");

    db.delete(schema.securityFlags).run();
    messageId = addMessage({ text: "another" });
    const id2 = create();
    reply = () => result(answerOf(), { permissionDenials: ["Read(//etc/**)"] });
    await run(id2);
    expect(flags().find((f) => f.detector === "runtime")?.severity).toBe("warning");
  });

  test("quota_exhausted goes back to queued and rethrows", async () => {
    const id = create();
    attempt = () => {
      throw new JobError({ kind: "rate_limited", message: "quota", details: {} } as never);
    };
    // rate_limited retries; use a deferring kind instead
    attempt = () => {
      throw new JobError({ kind: "quota_exhausted", message: "quota" } as never);
    };
    await expect(run(id)).rejects.toBeInstanceOf(JobError);
    expect(rowOf(id)?.status).toBe("queued");
  });

  test("timeout is stored as timeout", async () => {
    const id = create();
    attempt = () => {
      throw new JobError({ kind: "timeout", message: "t" });
    };
    await expect(run(id)).rejects.toBeInstanceOf(JobError);
    expect(rowOf(id)).toMatchObject({ status: "failed", failure: "timeout" });
  });

  test("a boundary collision (invalid_input) fails the row and does not retry", async () => {
    const id = create();
    attempt = () => {
      throw new JobError({ kind: "invalid_input", message: "boundary collision" });
    };
    let err: unknown;
    await run(id).catch((e) => {
      err = e;
    });
    expect((err as JobError).classified.kind).toBe("invalid_input");
    expect(rowOf(id)).toMatchObject({ status: "failed", failure: "invalid_input" });
    const job = db.select().from(schema.jobs).where(eq(schema.jobs.type, CODE_ANSWER_JOB)).get();
    expect(job?.maxAttempts).toBe(1);
  });

  test("an unregistered repository ends repository_unavailable without spawning", async () => {
    const id = create();
    db.delete(schema.repositories).where(eq(schema.repositories.id, repoId)).run();
    expect(rowOf(id)?.repositoryId).toBeNull();
    const out = await run(id);
    expect(out).toEqual({ skipped: "repository_unavailable" });
    expect(rowOf(id)).toMatchObject({ status: "failed", failure: "repository_unavailable" });
    expect(requests).toHaveLength(0);
  });

  test("a registered path that no longer exists ends path_unavailable without spawning", async () => {
    const id = create();
    rmSync(repo, { recursive: true, force: true });
    expect(await run(id)).toEqual({ skipped: "path_unavailable" });
    expect(rowOf(id)).toMatchObject({ status: "failed", failure: "path_unavailable" });
    expect(requests).toHaveLength(0);
  });

  test("a registered path that is a symlink (not its own realpath) is refused", async () => {
    const link = join(tempDir(), "link");
    roots.push(link);
    symlinkSync(repo, link);
    db.update(schema.repositories)
      .set({ localPath: link })
      .where(eq(schema.repositories.id, repoId))
      .run();
    const id = create();
    expect(await run(id)).toEqual({ skipped: "path_unavailable" });
    expect(requests).toHaveLength(0);
  });

  test("expired message content ends content_expired without spawning", async () => {
    const id = create();
    db.update(schema.slackMessages)
      .set({ text: null, contentExpiredAt: NOW })
      .where(eq(schema.slackMessages.id, messageId))
      .run();
    expect(await run(id)).toEqual({ skipped: "content_expired" });
    expect(requests).toHaveLength(0);
  });

  test("onFinished runs in the settling transaction", async () => {
    const seen: string[] = [];
    handlers.clear();
    registerCodeAnswerJob({
      db,
      settings,
      orchestrator: { run: async () => result(answerOf()) },
      service,
      handlers,
      onFinished: (_tx, row) => {
        seen.push(`${row.trigger}:${row.status}`);
      },
    });
    await run(create("away"));
    expect(seen).toEqual(["away:ready"]);
  });

  test("no question text, answer text or path reaches audit, events, jobs or job errors", async () => {
    const id = create();
    await run(id);
    messageId = addMessage({ text: QUESTION });
    const id2 = create();
    reply = () => result("no json");
    let err: unknown;
    await run(id2).catch((e) => {
      err = e;
    });
    const blob = JSON.stringify([
      db.select().from(schema.auditEvents).all(),
      db.select().from(schema.domainEvents).all(),
      db.select().from(schema.jobs).all(),
      (err as Error).message,
    ]);
    expect(blob).not.toContain("MARKER");
    expect(blob).not.toContain(repo);
    expect(blob).not.toContain("src/a.ts");
  });
});

describe("retention", () => {
  test("expireAnswers nulls the answers of old rows only", async () => {
    const old = create();
    await run(old);
    clock.advance(200 * 86_400_000);
    messageId = addMessage({ text: "fresh" });
    const fresh = create();
    await run(fresh);
    expect(service.expireAnswers(180)).toBe(1);
    expect(rowOf(old)?.answer).toBeNull();
    expect(rowOf(fresh)?.answer).toBe(ANSWER);
    expect(service.get(old)).toMatchObject({ status: "ready", repositoryName: "demo-app" });
  });
});
