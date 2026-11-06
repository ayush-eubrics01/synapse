/**
 * Commitment extraction end to end through the REAL ClaudeCliProvider and ClaudeOrchestrator (the
 * request validator included), with the fake-claude binary replaying a stream-json fixture (never
 * the real claude).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Job, JobError } from "@synapse/contracts";
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
import { AuthMonitor } from "../../src/core/orchestrator/auth";
import { ClaudeOrchestrator } from "../../src/core/orchestrator/orchestrator";
import { SchedulerService } from "../../src/core/scheduler/scheduler";
import { ClaudeCliProvider } from "../../src/integrations/claude-code/cli-provider";
import { StallService } from "../../src/modules/commitments/stall";
import { CommitmentStore } from "../../src/modules/commitments/store";
import { PeopleService } from "../../src/modules/people/service";
import { SecurityFlagsService } from "../../src/modules/security-flags/service";
import { registerCommitmentJobs } from "../../src/workers/commitments";

const fakeClaude = resolve(import.meta.dir, "../fixtures/fake-claude.ts");
const tmp = mkdtempSync(join(tmpdir(), "commitments-e2e-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const NOW = "2026-11-05T12:00:00.000Z";
const signal = new AbortController().signal;
const BODY = "BODY-SECRET-abc";

function build(mode: string, count = 2) {
  const credsPath = join(tmp, `creds-${mode}.json`);
  writeFileSync(
    credsPath,
    JSON.stringify({
      claudeAiOauth: { expiresAt: Date.parse(NOW) + 3_600_000, refreshTokenExpiresAt: 1.9e12 },
    }),
  );
  const argvFile = join(tmp, `argv-${mode}-${count}.json`);
  const { db } = openDatabase(":memory:");
  runMigrations(db);
  const clock = new FakeClock(NOW);
  const events = new EventPublisher(clock);
  const settings = new SettingsService(db, clock, events.publish.bind(events));
  settings.set("slack.selfUserId", "USELF00001");
  const audit = new AuditLogger(clock);
  const notifications = new NotificationService(db, clock, new LiveBus());
  const provider = new ClaudeCliProvider({
    binary: process.execPath,
    prefixArgs: ["run", fakeClaude],
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      FAKE_CLAUDE_MODE: mode,
      FAKE_CLAUDE_ARGV_FILE: argvFile,
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
    notifications,
    scratchDir: tmp,
  });
  const queue = new JobQueue(db, clock);
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
  const handlers = new Map<string, HandlerRegistration>();
  registerCommitmentJobs({
    db,
    clock,
    settings,
    scheduler: new SchedulerService(db, clock, queue),
    audit,
    queue,
    orchestrator,
    securityFlags,
    store: new CommitmentStore({ db, clock, settings, events }),
    guidelinesFor: () => ({ name: "Priya GUIDENAME", texts: ["GUIDELINE-SECRET-abc"] }),
    events,
    stall: new StallService({ db, clock, settings, events, queue, notifications }),
    handlers,
  });
  db.insert(schema.slackUsers)
    .values({ id: "su-self", externalId: "USELF00001", name: "Me" })
    .run();
  db.insert(schema.slackUsers)
    .values({ id: "su-priya", externalId: "UPRIYA0001", name: "Priya" })
    .run();
  db.insert(schema.slackConversations).values({ id: "c-dm", externalId: "D1", type: "im" }).run();
  for (let i = 1; i <= count; i++) {
    db.insert(schema.slackMessages)
      .values({
        id: `m-c-${i}`,
        conversationId: "c-dm",
        ts: `${1000 + i}.000000`,
        senderUserId: i % 2 === 1 ? "su-self" : "su-priya",
        text: `${BODY} ${i}`,
        sentAt: new Date(Date.parse(NOW) - 3_600_000 + i * 1000).toISOString(),
        collectedAt: NOW,
      })
      .run();
  }
  const run = () => {
    const id = db.transaction(
      (tx) => queue.enqueue(tx, { type: "commitments.extract", idempotencyKey: "t" }).id,
    );
    const job = { id, type: "commitments.extract", attempts: 1, maxAttempts: 3 } as unknown as Job;
    return handlers.get("commitments.extract")?.handler(job, {
      signal,
      checkpoint() {},
      getCheckpoint: () => undefined,
    } as never) as Promise<unknown>;
  };
  return { db, run, argvFile, handlers, queue, clock };
}

describe("commitments.extract through the real provider and validator", () => {
  test("happy path: only the evidenced candidate is stored; ToolSearch only; text only inside UNTRUSTED blocks", async () => {
    const { db, run, argvFile } = build("commitments_ok");
    await run();
    const rows = db.select().from(schema.commitments).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ownerSlackUserId: "USELF00001",
      counterpartySlackUserId: "UPRIYA0001",
      direction: "mine",
      reviewStatus: "pending_review",
      dueAt: "2026-11-06T09:00:00.000Z",
    });
    const sources = db.select().from(schema.commitmentSources).all();
    expect(sources.map((s) => s.messageId).sort()).toEqual(["m-c-1", "m-c-2"]);
    const runs = db.select().from(schema.claudeRuns).all();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ workerProfile: "intelligence", status: "succeeded" });
    expect(sources[0]?.claudeRunId).toBe(runs[0]?.id as string);
    expect(
      db
        .select()
        .from(schema.slackMessages)
        .all()
        .every((m) => m.commitmentsExtractedAt !== null),
    ).toBe(true);

    const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
    const at = (flag: string) => argv[argv.indexOf(flag) + 1];
    expect(at("--allowedTools")).toBe("ToolSearch");
    expect(at("--model")).toBe("haiku");
    const prompt = at("-p") as string;
    expect(prompt).toContain("UNTRUSTED");
    expect(prompt).toContain("slack message m-c-1 by you:USELF00001 in a DM");
    expect(prompt).toContain("The engineering lead's Slack id is USELF00001.");
    expect(prompt).toContain("slack message m-c-2 by them:UPRIYA0001 in a DM");
    const deny = (at("--disallowedTools") ?? "").split(",");
    for (const t of ["mcp__claude_ai_Slack", "WebFetch", "Bash", "Write"]) {
      expect(deny).toContain(t);
    }
    const outside = prompt.replace(/<<<UNTRUSTED[\s\S]*?<<<END \w+>>>/g, "");
    expect(outside).not.toContain(BODY);
  });

  test("invalid output -> incomplete_ai_output and nothing stored or marked", async () => {
    const { db, run } = build("commitments_invalid");
    const err = await run().catch((e) => e);
    expect(err).toBeInstanceOf(JobError);
    expect((err as JobError).classified.kind).toBe("incomplete_ai_output");
    expect(db.select().from(schema.commitments).all()).toHaveLength(0);
    expect(
      db
        .select()
        .from(schema.slackMessages)
        .all()
        .every((m) => m.commitmentsExtractedAt === null),
    ).toBe(true);
  });

  test("a full batch (40) of long CJK messages passes the real validator (100 KiB cap)", async () => {
    const { db, run, argvFile } = build("commitments_ok", 45);
    db.update(schema.slackMessages)
      .set({ text: "漢".repeat(20000) })
      .run();
    await run();
    expect(db.select().from(schema.claudeRuns).all()[0]?.status).toBe("succeeded");
    const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
    const prompt = argv[argv.indexOf("-p") + 1] as string;
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThan(100 * 1024);
  });
});

describe("commitments.draft_followup through the real provider and validator", () => {
  test("stalled commitment: draft stored; trusted parts hold the description and guidelines only; text only inside UNTRUSTED blocks", async () => {
    const { db, argvFile, handlers } = build("followup_ok", 2);
    db.insert(schema.commitments)
      .values({
        id: "c1",
        description: "DESCRIPTION-SECRET-xyz",
        ownerSlackUserId: "UPRIYA0001",
        counterpartySlackUserId: "USELF00001",
        direction: "theirs",
        status: "open",
        reviewStatus: "accepted",
        dedupKey: "k1",
        dueAt: new Date(Date.parse(NOW) - 60_000).toISOString(),
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
    db.insert(schema.commitmentSources)
      .values({
        id: "s1",
        commitmentId: "c1",
        messageId: "m-c-2",
        sourceExternalRef: "D1:1001.000000",
        conversationId: "c-dm",
        createdAt: NOW,
      })
      .run();
    db.insert(schema.commitmentUpdates)
      .values({
        id: "u1",
        commitmentId: "c1",
        actor: "user",
        field: "review_status",
        fromValue: "pending_review",
        toValue: "accepted",
        createdAt: NOW,
      })
      .run();
    // Past due, so the deterministic check stalls it.
    await handlers.get("commitments.check_stalled")?.handler({} as Job, ctxOf());
    const job = db
      .select()
      .from(schema.jobs)
      .all()
      .find((j) => j.type === "commitments.draft_followup");
    expect(job).toBeDefined();
    const run = handlers.get("commitments.draft_followup")?.handler(
      {
        id: job?.id,
        type: job?.type,
        attempts: 1,
        maxAttempts: 3,
        input: job?.input,
      } as unknown as Job,
      ctxOf(),
    ) as Promise<unknown>;
    expect(await run).toMatchObject({ drafted: true });
    const f = db.select().from(schema.followups).all();
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({
      origin: "stalled",
      status: "draft",
      recipientSlackUserId: "UPRIYA0001",
    });
    expect(f[0]?.draftText).toContain("checking in");
    const runs = db.select().from(schema.claudeRuns).all();
    expect(runs[0]).toMatchObject({ workerProfile: "intelligence", status: "succeeded" });
    expect(f[0]?.claudeRunId).toBe(runs[0]?.id as string);

    const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
    const at = (flag: string) => argv[argv.indexOf(flag) + 1];
    expect(at("--allowedTools")).toBe("ToolSearch");
    const prompt = at("-p") as string;
    expect(prompt).toContain("DESCRIPTION-SECRET-xyz");
    expect(prompt).toContain("UNTRUSTED");
    const outside = prompt.replace(/<<<UNTRUSTED[\s\S]*?<<<END \w+>>>/g, "");
    expect(outside).not.toContain(BODY);
    expect(outside).toContain("DESCRIPTION-SECRET-xyz");
    // Guidelines reach the real provider as trusted text, without the Slack name.
    expect(outside).toContain("GUIDELINE-SECRET-abc");
    expect(prompt).not.toContain("GUIDENAME");
  });
});

const ctxOf = () => ({ signal, checkpoint() {}, getCheckpoint: () => undefined }) as never;

describe("commitments.check_spec_clarity through the real provider and validator", () => {
  test("unclear bug report: numbered draft in the DM, ToolSearch only, text only inside UNTRUSTED blocks", async () => {
    const { db, argvFile, handlers, queue } = build("spec_clarity_ok", 2);
    db.update(schema.slackMessages)
      .set({ text: `${BODY} the export is broken again, can you take a look at it soon` })
      .where(eq(schema.slackMessages.id, "m-c-2"))
      .run();
    const jobId = db.transaction(
      (tx) =>
        queue.enqueue(tx, {
          type: "commitments.check_spec_clarity",
          idempotencyKey: "spec",
          input: { messageId: "m-c-2" },
        }).id,
    );
    const r = await (handlers.get("commitments.check_spec_clarity")?.handler(
      {
        id: jobId,
        type: "commitments.check_spec_clarity",
        attempts: 1,
        maxAttempts: 3,
        input: { messageId: "m-c-2" },
      } as unknown as Job,
      ctxOf(),
    ) as Promise<unknown>);
    expect(r).toMatchObject({ drafted: true, questions: 2 });
    const f = db.select().from(schema.followups).all();
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({
      origin: "spec_clarity",
      originMessageId: "m-c-2",
      status: "draft",
      recipientSlackUserId: "UPRIYA0001",
      threadTs: null,
      confidence: 0.8,
    });
    expect(f[0]?.draftText).toBe(
      "A few questions so I can pick this up:\n1. What steps reproduce the crash?\n2. Which environment and version does it happen on?",
    );
    const h = db.select().from(schema.followupHistory).all();
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ event: "clarity_missing", detail: "steps,environment" });
    const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
    const at = (flag: string) => argv[argv.indexOf(flag) + 1];
    expect(at("--allowedTools")).toBe("ToolSearch");
    const prompt = at("-p") as string;
    expect(prompt).toContain("UNTRUSTED");
    expect(prompt).toContain("slack message m-c-2 by them:UPRIYA0001");
    const outside = prompt.replace(/<<<UNTRUSTED[\s\S]*?<<<END \w+>>>/g, "");
    expect(outside).not.toContain(BODY);
    expect(
      db
        .select()
        .from(schema.claudeRuns)
        .all()
        .map((x) => x.status),
    ).toEqual(["succeeded"]);
  });
});
