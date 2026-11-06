import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AIExecutionRequest,
  type AIExecutionResult,
  type AIProvider,
  type ClaudeJobRequest,
  type Job,
  JobError,
} from "@synapse/contracts";
import { openDatabase, runMigrations, schema } from "@synapse/database";
import { FakeClock } from "@synapse/shared";
import { and, eq } from "drizzle-orm";
import { AuditLogger } from "../../src/core/audit/audit";
import { SettingsService } from "../../src/core/config/settings";
import { OutboxDispatcher } from "../../src/core/events/dispatcher";
import { LiveBus } from "../../src/core/events/live-bus";
import { EventPublisher } from "../../src/core/events/publisher";
import { JobQueue } from "../../src/core/jobs/queue";
import type { HandlerRegistration } from "../../src/core/jobs/worker";
import { NotificationService } from "../../src/core/notifications/notifications";
import { AuthMonitor } from "../../src/core/orchestrator/auth";
import { ClaudeOrchestrator } from "../../src/core/orchestrator/orchestrator";
import { SchedulerService } from "../../src/core/scheduler/scheduler";
import { LocalGitProvider } from "../../src/integrations/repository/local-git";
import { buildInspectRequest } from "../../src/intelligence/brain/inspect-prompt";
import {
  INSPECT_JOB,
  INSPECT_WEEKLY_JOB,
  type InspectionService,
  inspectKey,
} from "../../src/modules/engineering-brain/inspection";
import { RepositoryRegistry } from "../../src/modules/engineering-brain/registry";
import { registerInspectionJobs } from "../../src/workers/brain/inspect";
import { git, makeDemoRepo, tempDir } from "../fixtures/git-repo";

const NOW = "2026-11-06T09:00:00.000Z";
const roots: string[] = [];
const scratch = () => {
  const d = tempDir();
  roots.push(d);
  return d;
};
afterAll(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

const ctx = {
  signal: new AbortController().signal,
  checkpoint() {},
  getCheckpoint: () => undefined,
} as never;

function result(finalText: string, over: Partial<AIExecutionResult> = {}): AIExecutionResult {
  return {
    status: "succeeded",
    toolResults: [],
    finalText,
    numTurns: 4,
    durationMs: 50,
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

const fenced = (v: unknown) => `Here you go.\n\`\`\`json\n${JSON.stringify(v)}\n\`\`\``;

const FACTS = [
  { kind: "purpose", content: "A demo application.", evidence: [{ path: "README.md", line: 1 }] },
  { kind: "stack", content: "Written in TypeScript.", evidence: [{ path: "src/index.ts" }] },
  { kind: "risk", content: "No tests exist yet.", evidence: [{ path: "package.json" }] },
];

let db: ReturnType<typeof openDatabase>["db"];
let clock: FakeClock;
let settings: SettingsService;
let queue: JobQueue;
let dispatcher: OutboxDispatcher;
let handlers: Map<string, HandlerRegistration>;
let registry: RepositoryRegistry;
let inspections: InspectionService;
let repo: string;
let repoId: string;
let projectId: string;
let requests: ClaudeJobRequest[];
let reply: () => AIExecutionResult;

const commitFile = (path: string, body: string) => {
  writeFileSync(join(repo, path), body);
  git(repo, "add", path);
  git(repo, "commit", "-q", "-m", `add ${path}`);
  return git(repo, "rev-parse", "HEAD");
};

const repoRow = () =>
  db.select().from(schema.repositories).where(eq(schema.repositories.id, repoId)).get();
const facts = () =>
  db.select().from(schema.projectFacts).where(eq(schema.projectFacts.projectId, projectId)).all();
const inspectJobs = () =>
  db.select().from(schema.jobs).where(eq(schema.jobs.type, INSPECT_JOB)).all();
const proposedEvents = () =>
  db
    .select()
    .from(schema.domainEvents)
    .where(eq(schema.domainEvents.type, "brain.facts_proposed"))
    .all();

function newJob(): Job {
  const { id } = queue.enqueue(db, {
    type: INSPECT_JOB,
    input: { repositoryId: repoId },
    idempotencyKey: `test:${Math.random()}`,
  });
  const job = queue.get(id);
  if (!job) throw new Error("job vanished");
  return job;
}

const runInspect = (job = newJob()) => {
  const h = handlers.get(INSPECT_JOB);
  if (!h) throw new Error("inspect handler not registered");
  return h.handler(job, ctx);
};
const runWeekly = () => {
  const h = handlers.get(INSPECT_WEEKLY_JOB);
  if (!h) throw new Error("weekly handler not registered");
  return h.handler({} as never, ctx);
};

beforeEach(async () => {
  db = openDatabase(":memory:").db;
  runMigrations(db);
  clock = new FakeClock(NOW);
  settings = new SettingsService(db, clock, () => "e");
  const events = new EventPublisher(clock);
  const audit = new AuditLogger(clock);
  queue = new JobQueue(db, clock);
  dispatcher = new OutboxDispatcher(db, clock, new LiveBus());
  handlers = new Map();
  repo = makeDemoRepo(scratch());
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "README.md"), "# Demo\n");
  writeFileSync(join(repo, "package.json"), '{"name":"demo"}\n');
  writeFileSync(join(repo, "src", "index.ts"), "export {};\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "seed");
  const provider = new LocalGitProvider({ home: scratch() });
  registry = new RepositoryRegistry({ db, clock, audit, events, provider });
  requests = [];
  reply = () => result(fenced({ facts: FACTS, unknowns: ["Deployment target"] }));
  inspections = registerInspectionJobs({
    db,
    clock,
    settings,
    events,
    audit,
    queue,
    provider,
    orchestrator: {
      run: async (req: ClaudeJobRequest) => {
        requests.push(req);
        return reply();
      },
    },
    scheduler: new SchedulerService(db, clock, queue),
    dispatcher,
    handlers,
  });
  const view = await registry.register({
    path: repo,
    name: "app",
    trackedBranch: "main",
    environments: [],
    jiraProjectKeys: [],
  });
  repoId = view.id;
  projectId = view.projectId as string;
});

describe("buildInspectRequest", () => {
  test("engineering, scoped to the repo realpath, system parts only, model from settings", async () => {
    settings.set("brain.inspect.model", "opus");
    await runInspect();
    const req = requests[0] as ClaudeJobRequest;
    expect(req.workerProfile).toBe("engineering");
    expect(req.workingDirectory).toBe(repo);
    expect(req.allowedTools).toEqual([`Read(${repo}/**)`, `Grep(${repo}/**)`, `Glob(${repo}/**)`]);
    expect(req.parts?.length).toBeGreaterThan(0);
    expect(req.parts?.every((p) => p.provenance === "system")).toBe(true);
    expect(req.model).toBe("opus");
    expect(req.maxTurns).toBe(30);
    expect(req.timeoutMs).toBe(10 * 60_000);
    expect(req.jobId).toBeDefined();
    const text = [req.instructions, ...(req.parts ?? []).map((p) => p.content)].join("\n");
    expect(text).toContain(".env");
    expect(text).toContain("relative to the repository root");
    expect(text).toContain("40");
    expect(text).toContain("You have about 30 tool turns.");
    expect(text).toContain("reply with the JSON before you run out");
  });

  test("maxTurns is capped at the request limit of 50", () => {
    const req = buildInspectRequest({ name: "app", localPath: repo }, "j1", {
      model: "sonnet",
      maxTurns: 100,
      timeoutMinutes: 10,
    });
    expect(req.maxTurns).toBe(50);
  });

  test("the real orchestrator accepts it and denies write, shell and network built-ins", async () => {
    const credsDir = mkdtempSync(join(tmpdir(), "synapse-creds-"));
    roots.push(credsDir);
    const credsPath = join(credsDir, "creds.json");
    writeFileSync(
      credsPath,
      JSON.stringify({
        claudeAiOauth: { expiresAt: Date.now() + 3_600_000, refreshTokenExpiresAt: 1.9e12 },
      }),
    );
    const seen: AIExecutionRequest[] = [];
    const provider: AIProvider = {
      async execute(r) {
        seen.push(r);
        return result(fenced({ facts: [], unknowns: [] }));
      },
      async getHealth() {
        return { status: "ok" as const };
      },
    };
    const events = new EventPublisher(clock);
    const orch = new ClaudeOrchestrator({
      db,
      clock,
      provider,
      settings,
      events,
      audit: new AuditLogger(clock),
      auth: new AuthMonitor(db, clock, settings, events, credsPath),
      notifications: new NotificationService(db, clock, new LiveBus()),
      scratchDir: "/scratch",
    });
    const req = buildInspectRequest({ name: "app", localPath: repo }, newJob().id, {
      model: "sonnet",
      maxTurns: 30,
      timeoutMinutes: 10,
    });
    await orch.run(req, new AbortController().signal);
    const exec = seen[0] as AIExecutionRequest;
    expect(exec.workingDirectory).toBe(repo);
    expect(exec.allowedTools).toEqual(req.allowedTools);
    expect(exec.allowedTools).not.toContain("ToolSearch");
    for (const t of ["Bash", "Edit", "Write", "NotebookEdit", "MultiEdit", "Monitor", "WebFetch"]) {
      expect(exec.disallowedTools).toContain(t);
    }
    for (const t of ["Read", "Grep", "Glob"]) expect(exec.disallowedTools).not.toContain(t);
  });
});

describe("brain.inspect_repository", () => {
  test("inserts verified facts as needs_review and records the inspected head", async () => {
    const head = git(repo, "rev-parse", "HEAD");
    const out = await runInspect();
    expect(out).toMatchObject({ proposed: 3, inserted: 3, duplicates: 0, unknowns: 1 });
    const rows = facts();
    expect(rows.map((f) => f.content).sort()).toEqual(
      ["A demo application.", "No tests exist yet.", "Written in TypeScript."].sort(),
    );
    for (const f of rows) {
      expect(f.status).toBe("needs_review");
      expect(f.source).toBe("inspection");
      expect(f.headSha).toBe(head);
      expect(f.decidedAt).toBeNull();
    }
    expect(rows.find((f) => f.kind === "purpose")?.evidence).toEqual([
      { path: "README.md", line: 1 },
    ]);
    expect(repoRow()?.inspectedHeadSha).toBe(head);
    expect(proposedEvents().map((e) => e.payload)).toEqual([{ projectId, count: 3 }]);
  });

  test("audit and job output carry counts only, never fact text", async () => {
    const out = await runInspect();
    const audits = db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, "brain.inspected"))
      .all();
    expect(audits).toHaveLength(1);
    const blob = JSON.stringify([audits, out, proposedEvents()]);
    for (const f of FACTS) expect(blob).not.toContain(f.content);
    expect(blob).not.toContain("Deployment target");
    expect(blob).not.toContain("README.md");
  });

  test("permission denials are audited as tool names", async () => {
    reply = () =>
      result(fenced({ facts: FACTS, unknowns: [] }), {
        permissionDenials: ["Read", "Bash", "Read"],
      });
    await runInspect();
    const audit = db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, "brain.inspected"))
      .get();
    expect(audit?.details).toMatchObject({ permissionDenials: ["Bash", "Read"], inserted: 3 });
  });

  test("drops facts with bad evidence or secrets and counts them", async () => {
    reply = () =>
      result(
        fenced({
          facts: [
            ...FACTS,
            { kind: "note", content: "Reads passwd.", evidence: [{ path: "../../etc/passwd" }] },
            {
              kind: "note",
              content: "Key AKIAABCDEFGHIJKLMNOP.",
              evidence: [{ path: "README.md" }],
            },
          ],
          unknowns: [],
        }),
      );
    const out = await runInspect();
    expect(out).toMatchObject({
      proposed: 5,
      inserted: 3,
      dropped: { unsafe_path: 1, content_secret: 1 },
    });
    expect(facts()).toHaveLength(3);
  });

  test("re-running at the same head is idempotent", async () => {
    await runInspect();
    const out = await runInspect();
    expect(out).toMatchObject({ inserted: 0, duplicates: 3 });
    expect(facts()).toHaveLength(3);
    expect(proposedEvents()).toHaveLength(1);
  });

  test("a new head never changes approved facts nor re-proposes approved or rejected ones", async () => {
    await runInspect();
    const byKind = (k: string) => facts().find((f) => f.kind === k);
    const approved = byKind("purpose");
    const rejected = byKind("risk");
    if (!approved || !rejected) throw new Error("seed facts missing");
    db.update(schema.projectFacts)
      .set({ status: "approved", decidedAt: NOW })
      .where(eq(schema.projectFacts.id, approved.id))
      .run();
    db.update(schema.projectFacts)
      .set({ status: "rejected", decidedAt: NOW })
      .where(eq(schema.projectFacts.id, rejected.id))
      .run();
    const approvedBefore = db
      .select()
      .from(schema.projectFacts)
      .where(eq(schema.projectFacts.id, approved.id))
      .get();
    const head2 = commitFile("CONTRIBUTING.md", "Use conventional commits.\n");
    reply = () =>
      result(
        fenced({
          facts: [
            // Same normalised content as the approved and rejected facts.
            { kind: "purpose", content: "a demo  APPLICATION", evidence: [{ path: "README.md" }] },
            { kind: "risk", content: "No tests exist yet!", evidence: [{ path: "package.json" }] },
            // Same text but another kind is a different fact.
            { kind: "note", content: "A demo application.", evidence: [{ path: "README.md" }] },
            {
              kind: "convention",
              content: "Commits follow conventional commits.",
              evidence: [{ path: "CONTRIBUTING.md", line: 1 }],
            },
          ],
          unknowns: [],
        }),
      );
    const out = await runInspect();
    expect(out).toMatchObject({ inserted: 2, duplicates: 2 });
    const after = db
      .select()
      .from(schema.projectFacts)
      .where(eq(schema.projectFacts.id, approved.id))
      .get();
    expect(after).toEqual(approvedBefore as never);
    const pending = facts().filter((f) => f.status === "needs_review");
    expect(pending.map((f) => [f.kind, f.headSha]).sort()).toEqual(
      [
        ["convention", head2],
        ["note", head2],
        ["stack", git(repo, "rev-parse", "HEAD~1")],
      ].sort(),
    );
    expect(repoRow()?.inspectedHeadSha).toBe(head2);
  });

  test("invalid output inserts nothing and fails as parse_failed", async () => {
    reply = () => result(fenced({ facts: [{ kind: "vibe", content: "x", evidence: [] }] }));
    const err = await runInspect().catch((e) => e);
    expect(err).toBeInstanceOf(JobError);
    expect((err as JobError).classified.kind).toBe("parse_failed");
    expect((err as JobError).message).not.toContain("vibe");
    expect(facts()).toHaveLength(0);
    expect(repoRow()?.inspectedHeadSha).toBeNull();
    expect(proposedEvents()).toHaveLength(0);
  });

  test("output with no JSON at all also fails as parse_failed", async () => {
    reply = () => result("I could not finish.");
    const err = await runInspect().catch((e) => e);
    expect((err as JobError).classified.kind).toBe("parse_failed");
    expect(facts()).toHaveLength(0);
  });

  test("more than 40 kept facts are truncated; over-long content is dropped, not cut", async () => {
    const many = Array.from({ length: 45 }, (_, i) => ({
      kind: "note",
      content: `Fact number ${i}.`,
      evidence: [{ path: "README.md" }],
    }));
    const long = {
      kind: "note",
      content: `Long ${"word ".repeat(100)}`,
      evidence: [{ path: "README.md" }],
    };
    reply = () => result(fenced({ facts: [long, ...many], unknowns: [] }));
    const out = await runInspect();
    expect(out).toMatchObject({ proposed: 46, inserted: 40, dropped: { too_long: 1 } });
    expect(facts().some((f) => f.content.startsWith("Long"))).toBe(false);
  });

  test("a missing unknowns key defaults to none; an over-long evidence path drops only its fact", async () => {
    reply = () =>
      result(
        fenced({
          facts: [
            ...FACTS,
            {
              kind: "note",
              content: "Deep file.",
              evidence: [{ path: `${"a/".repeat(300)}x.ts` }],
            },
          ],
        }),
      );
    const out = await runInspect();
    expect(out).toMatchObject({ inserted: 3, unknowns: 0, dropped: { unsafe_path: 1 } });
  });

  test("a max-turns stop is not retried and is recorded with its kind only", async () => {
    reply = () => {
      throw new JobError({
        kind: "provider_error",
        message: "claude run failed (provider_error)",
        details: { maxTurns: true },
      });
    };
    const err = (await runInspect().catch((e) => e)) as JobError;
    expect(err).toBeInstanceOf(JobError);
    expect(err.classified.kind).toBe("needs_attention");
    expect(err.message).toBe("inspection run stopped (max_turns)");
    expect(facts()).toHaveLength(0);
    const audit = db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, "brain.inspect_failed"))
      .get();
    expect(audit?.details).toEqual({ repositoryId: repoId, kind: "max_turns" });
  });

  test("a timeout is not retried either", async () => {
    reply = () => {
      throw new JobError({ kind: "timeout", message: "claude run failed (timeout)" });
    };
    const err = (await runInspect().catch((e) => e)) as JobError;
    expect(err.classified.kind).toBe("needs_attention");
    expect(err.message).toBe("inspection run stopped (timeout)");
  });

  test("a quota deferral passes through unchanged", async () => {
    reply = () => {
      throw new JobError({ kind: "quota_exhausted", message: "deferred" });
    };
    const err = (await runInspect().catch((e) => e)) as JobError;
    expect(err.classified.kind).toBe("quota_exhausted");
  });

  test("unregistered while the run was in flight: nothing is inserted", async () => {
    reply = () => {
      registry.unregister(repoId);
      return result(fenced({ facts: FACTS, unknowns: [] }));
    };
    const out = await runInspect();
    expect(out).toEqual({ skipped: "unregistered" });
    expect(facts()).toHaveLength(0);
    expect(proposedEvents()).toHaveLength(0);
  });

  test("skips without running Claude when the repository path is gone", async () => {
    renameSync(repo, `${repo}-moved`);
    roots.push(`${repo}-moved`);
    const out = await runInspect();
    expect(out).toEqual({ skipped: "path_unavailable" });
    expect(requests).toHaveLength(0);
  });

  test("an unknown repository is skipped", async () => {
    registry.unregister(repoId);
    expect(await runInspect()).toEqual({ skipped: "not_found" });
    expect(requests).toHaveLength(0);
  });
});

describe("enqueueing", () => {
  test("registration enqueues the first inspection", () => {
    dispatcher.dispatchOnce();
    const jobs = inspectJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.idempotencyKey).toBe(inspectKey(repoId, git(repo, "rev-parse", "HEAD")));
    expect(jobs[0]?.input).toEqual({ repositoryId: repoId });
  });

  test("the weekly check is scheduled weekly and coalesced", () => {
    const task = db
      .select()
      .from(schema.scheduledTasks)
      .where(eq(schema.scheduledTasks.name, INSPECT_WEEKLY_JOB))
      .get();
    expect(task).toMatchObject({ jobType: INSPECT_WEEKLY_JOB, intervalSeconds: 7 * 86_400 });
  });

  test("weekly: refreshes head_sha and enqueues only when the head moved since inspection", async () => {
    await runInspect(); // inspected at the registered head
    db.update(schema.jobs).set({ status: "COMPLETED" }).run();
    expect(await runWeekly()).toMatchObject({ checked: 1, enqueued: 0 });
    expect(inspectJobs()).toHaveLength(1); // the test job only

    const head2 = commitFile("NOTES.md", "notes\n");
    expect(await runWeekly()).toMatchObject({ checked: 1, enqueued: 1 });
    expect(repoRow()?.headSha).toBe(head2);
    const queued = db
      .select()
      .from(schema.jobs)
      .where(
        and(
          eq(schema.jobs.type, INSPECT_JOB),
          eq(schema.jobs.idempotencyKey, inspectKey(repoId, head2)),
        ),
      )
      .all();
    expect(queued).toHaveLength(1);
    // Same head again: the idempotency key holds.
    expect(await runWeekly()).toMatchObject({ enqueued: 0 });
  });

  test("weekly: a repository whose path is missing is not inspected", async () => {
    commitFile("NOTES.md", "notes\n");
    db.update(schema.repositories)
      .set({ drift: { pathMissing: true, detectedAt: NOW } })
      .where(eq(schema.repositories.id, repoId))
      .run();
    expect(await runWeekly()).toMatchObject({ checked: 1, enqueued: 0 });
    expect(inspectJobs()).toHaveLength(0);
  });

  test("inspection jobs are enqueued with a single attempt", () => {
    dispatcher.dispatchOnce();
    inspections.requestInspection(repoId);
    db.update(schema.jobs).set({ status: "COMPLETED" }).run();
    inspections.requestInspection(repoId);
    const jobs = inspectJobs();
    expect(jobs.length).toBe(2);
    expect(jobs.every((j) => j.maxAttempts === 1)).toBe(true);
  });

  test("weekly and registration skip the enqueue while an inspection is live", async () => {
    const live = inspections.requestInspection(repoId);
    expect(live.status).toBe("enqueued");
    dispatcher.dispatchOnce(); // repo.registered: a live job exists, so nothing more
    commitFile("NOTES.md", "notes\n");
    expect(await runWeekly()).toMatchObject({ checked: 1, enqueued: 0 });
    expect(inspectJobs()).toHaveLength(1);
  });

  test("requestInspection: reports a queued run, and forces a new one once it finished", () => {
    const first = inspections.requestInspection(repoId);
    expect(first.status).toBe("enqueued");
    expect(inspections.requestInspection(repoId).status).toBe("already_queued");
    db.update(schema.jobs)
      .set({ status: "COMPLETED" })
      .where(eq(schema.jobs.type, INSPECT_JOB))
      .run();
    const again = inspections.requestInspection(repoId);
    expect(again.status).toBe("enqueued");
    expect(inspectJobs()).toHaveLength(2);
    expect(inspections.requestInspection("nope").status).toBe("not_found");
  });
});
