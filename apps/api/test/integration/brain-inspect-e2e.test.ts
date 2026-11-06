/**
 * Repository inspection end to end through the REAL ClaudeCliProvider and ClaudeOrchestrator, with
 * a fake binary (never the real claude). Proves the run is path-scoped and read-only (the argv the
 * binary sees), that facts are stored only after verification, and that review then works.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Job } from "@synapse/contracts";
import { openDatabase, runMigrations, schema } from "@synapse/database";
import { FakeClock } from "@synapse/shared";
import { eq } from "drizzle-orm";
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
import { ClaudeCliProvider } from "../../src/integrations/claude-code/cli-provider";
import { LocalGitProvider } from "../../src/integrations/repository/local-git";
import { INSPECT_JOB } from "../../src/modules/engineering-brain/inspection";
import { RepositoryRegistry } from "../../src/modules/engineering-brain/registry";
import { BrainService } from "../../src/modules/engineering-brain/service";
import { registerInspectionJobs } from "../../src/workers/brain/inspect";
import { git, makeDemoRepo, tempDir } from "../fixtures/git-repo";

const fakeClaude = resolve(import.meta.dir, "../fixtures/brain-fake-claude.ts");
const tmp = tempDir("brain-e2e-");
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const NOW = "2026-11-06T12:00:00.000Z";
const signal = new AbortController().signal;

async function build(mode?: "no_reads") {
  const credsPath = join(tmp, "creds.json");
  writeFileSync(
    credsPath,
    JSON.stringify({
      claudeAiOauth: { expiresAt: Date.parse(NOW) + 3_600_000, refreshTokenExpiresAt: 1.9e12 },
    }),
  );
  const argvOut = join(tmp, `argv-${Math.random().toString(36).slice(2)}.json`);
  const { db } = openDatabase(":memory:");
  runMigrations(db);
  const clock = new FakeClock(NOW);
  const events = new EventPublisher(clock);
  const audit = new AuditLogger(clock);
  const settings = new SettingsService(db, clock, events.publish.bind(events));
  const provider = new ClaudeCliProvider({
    binary: process.execPath,
    prefixArgs: ["run", fakeClaude],
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      FAKE_BRAIN_OUT: argvOut,
      ...(mode ? { FAKE_BRAIN_MODE: mode } : {}),
    },
    clock,
    killGraceMs: 200,
  });
  const orchestrator = new ClaudeOrchestrator({
    db,
    clock,
    provider,
    settings,
    events,
    audit,
    auth: new AuthMonitor(db, clock, settings, events, credsPath),
    notifications: new NotificationService(db, clock, new LiveBus()),
    scratchDir: tmp,
  });
  const queue = new JobQueue(db, clock);
  const handlers = new Map<string, HandlerRegistration>();
  const git_ = new LocalGitProvider({ home: tempDir("brain-home-") });
  const inspections = registerInspectionJobs({
    db,
    clock,
    settings,
    events,
    audit,
    queue,
    provider: git_,
    orchestrator,
    scheduler: new SchedulerService(db, clock, queue),
    dispatcher: new OutboxDispatcher(db, clock, new LiveBus()),
    handlers,
  });
  const registry = new RepositoryRegistry({ db, clock, audit, events, provider: git_ });
  const brain = new BrainService({ db, clock, settings, audit, events, registry, inspections });

  const repo = makeDemoRepo(tempDir("brain-repo-"));
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "README.md"), "# Demo\n");
  writeFileSync(join(repo, "src", "index.ts"), "export {};\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "seed");
  const view = await registry.register({
    path: repo,
    name: "app",
    trackedBranch: "main",
    environments: [],
    jiraProjectKeys: [],
  });
  const run = () => {
    const r = brain.requestInspection(view.id);
    if (r.status !== "enqueued" && r.status !== "already_queued") throw new Error(r.status);
    const job = queue.get(r.jobId) as Job;
    const h = handlers.get(INSPECT_JOB);
    if (!h) throw new Error("no inspect handler");
    return h.handler(job, {
      signal,
      checkpoint() {},
      getCheckpoint: () => undefined,
    } as never);
  };
  return { db, brain, repo, repoId: view.id, projectId: view.projectId as string, run, argvOut };
}

describe("brain inspection through the real provider", () => {
  test("scoped, read-only run; verified facts stored for review; accepting works", async () => {
    // Registration queued a first inspection; clear it so the manual request is the only one.
    const { db, brain, repo, repoId, projectId, run, argvOut } = await build();
    db.delete(schema.jobs).run();
    await run();

    const seen = JSON.parse(readFileSync(argvOut, "utf8")) as { args: string[]; cwd: string };
    expect(seen.cwd).toBe(repo);
    const allowed = seen.args[seen.args.indexOf("--allowedTools") + 1] ?? "";
    expect(allowed.split(",").sort()).toEqual(
      [`Glob(/${repo}/**)`, `Grep(/${repo}/**)`, `Read(/${repo}/**)`].sort(),
    );
    expect(seen.args[seen.args.indexOf("--permission-mode") + 1]).toBe("default");
    expect(seen.args).not.toContain("--tools");
    expect(seen.args).toContain("--no-session-persistence");

    // The fact citing a missing file was dropped; the other two wait for review.
    const facts = db
      .select()
      .from(schema.projectFacts)
      .where(eq(schema.projectFacts.projectId, projectId))
      .all();
    expect(facts.map((f) => f.content).sort()).toEqual([
      "A demo application.",
      "Written in TypeScript.",
    ]);
    expect(facts.every((f) => f.status === "needs_review" && f.source === "inspection")).toBe(true);
    expect(facts.every((f) => f.claudeRunId !== null)).toBe(true);
    expect(
      db.select().from(schema.repositories).where(eq(schema.repositories.id, repoId)).get()
        ?.inspectedHeadSha,
    ).not.toBeNull();
    expect(brain.reviewCount()).toBe(2);

    const first = facts.find((f) => f.kind === "purpose");
    const accepted = brain.acceptFact(first?.id as string);
    expect(accepted.status).toBe("approved");
    expect(brain.reviewCount()).toBe(1);
    const detail = brain.getProject(projectId);
    expect(detail?.factsNeedingReview).toBe(1);
    expect(detail?.facts.filter((f) => f.status === "approved")).toHaveLength(1);

    // A re-inspection never touches the approved fact and proposes nothing new.
    await run();
    expect(brain.getProject(projectId)?.facts).toHaveLength(2);
  });

  test("ADR-026: a run that read nothing fails as incomplete_ai_output and stores nothing", async () => {
    const { db, repoId, projectId, run } = await build("no_reads");
    db.delete(schema.jobs).run();
    const err = (await run().catch((e) => e)) as { classified?: { kind: string } };
    expect(err.classified?.kind).toBe("incomplete_ai_output");
    expect(
      db
        .select()
        .from(schema.projectFacts)
        .where(eq(schema.projectFacts.projectId, projectId))
        .all(),
    ).toHaveLength(0);
    const repoRow = db
      .select()
      .from(schema.repositories)
      .where(eq(schema.repositories.id, repoId))
      .get();
    expect(repoRow?.inspectedHeadSha).toBeNull();
    const failed = db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, "brain.inspect_failed"))
      .all();
    expect(failed.map((a) => a.details)).toEqual([
      { repositoryId: repoId, kind: "incomplete_ai_output" },
    ]);
  });

  test("while one inspection is live a second request is already_queued", async () => {
    const { db, brain, repoId } = await build();
    db.delete(schema.jobs).run();
    const a = brain.requestInspection(repoId);
    const b = brain.requestInspection(repoId);
    expect(a.status).toBe("enqueued");
    expect(b.status).toBe("already_queued");
  });
});
