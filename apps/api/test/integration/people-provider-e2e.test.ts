/**
 * Initial profile recommendation end to end through the REAL ClaudeCliProvider and
 * ClaudeOrchestrator, with the fake-claude binary replaying a stream-json fixture (never the real
 * claude).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Job, JobError, type ProfileContent } from "@synapse/contracts";
import { openDatabase, runMigrations, schema } from "@synapse/database";
import { FakeClock } from "@synapse/shared";
import { ApprovalEngine } from "../../src/core/approvals/approvals";
import { AuditLogger } from "../../src/core/audit/audit";
import { SettingsService } from "../../src/core/config/settings";
import { LiveBus } from "../../src/core/events/live-bus";
import { EventPublisher } from "../../src/core/events/publisher";
import { JobQueue } from "../../src/core/jobs/queue";
import type { HandlerRegistration } from "../../src/core/jobs/worker";
import { NotificationService } from "../../src/core/notifications/notifications";
import { AuthMonitor } from "../../src/core/orchestrator/auth";
import { ClaudeOrchestrator } from "../../src/core/orchestrator/orchestrator";
import { PermissionManager } from "../../src/core/permissions/permissions";
import { SchedulerService } from "../../src/core/scheduler/scheduler";
import { ClaudeCliProvider } from "../../src/integrations/claude-code/cli-provider";
import { ProfileRecommendations } from "../../src/modules/people/recommendations";
import { PeopleService } from "../../src/modules/people/service";
import { TemporaryContacts } from "../../src/modules/people/temporary";
import { SecurityFlagsService } from "../../src/modules/security-flags/service";
import { registerPeopleJobs } from "../../src/workers/people";

const fakeClaude = resolve(import.meta.dir, "../fixtures/fake-claude.ts");
const tmp = mkdtempSync(join(tmpdir(), "people-e2e-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const NOW = "2026-11-05T10:05:00.000Z";
const signal = new AbortController().signal;
const BODY = "BODY-SECRET-abc";

function build(mode: string, texts: string[] = [1, 2, 3, 4].map((n) => `${BODY} ${n}`)) {
  const credsPath = join(tmp, `creds-${mode}.json`);
  writeFileSync(
    credsPath,
    JSON.stringify({
      claudeAiOauth: { expiresAt: Date.parse(NOW) + 3_600_000, refreshTokenExpiresAt: 1.9e12 },
    }),
  );
  const argvFile = join(tmp, `argv-${mode}-${texts.length}.json`);
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
  const approvals = new ApprovalEngine(db, clock, events, audit, new PermissionManager(db, audit));
  const recommendations = new ProfileRecommendations({
    db,
    clock,
    settings,
    events,
    queue,
    approvals,
    people,
  });
  const handlers = new Map<string, HandlerRegistration>();
  registerPeopleJobs({
    db,
    clock,
    settings,
    scheduler: new SchedulerService(db, clock, queue),
    temporary: new TemporaryContacts({ db, clock, settings, events }),
    recommendations,
    orchestrator,
    securityFlags,
    handlers,
  });
  db.insert(schema.slackUsers).values({ id: "su1", externalId: "UPRIYA0001", name: "Priya" }).run();
  db.insert(schema.slackConversations)
    .values({ id: "c1", externalId: "C1", type: "channel", name: "payments" })
    .run();
  texts.forEach((text, i) => {
    db.insert(schema.slackMessages)
      .values({
        id: `m-p-${i + 1}`,
        conversationId: "c1",
        ts: `${1000 + i}.000000`,
        senderUserId: "su1",
        text,
        sentAt: new Date(Date.parse(NOW) - 3_600_000 + i * 1000).toISOString(),
        collectedAt: NOW,
      })
      .run();
  });
  const run = () => {
    const personId = db.transaction((tx) => people.ensurePerson(tx, "UPRIYA0001"));
    const id = db.transaction(
      (tx) =>
        queue.enqueue(tx, {
          type: "people.generate_initial_profile",
          idempotencyKey: `people.initial:${personId}:t`,
          input: { personId },
        }).id,
    );
    const job = {
      id,
      type: "people.generate_initial_profile",
      input: { personId },
      attempts: 1,
      maxAttempts: 3,
    } as unknown as Job;
    return handlers.get("people.generate_initial_profile")?.handler(job, {
      signal,
      checkpoint() {},
      getCheckpoint: () => undefined,
    } as never) as Promise<unknown>;
  };
  return { db, run, argvFile };
}

describe("people.generate_initial_profile through the real provider", () => {
  test("happy path: validated recommendation, ToolSearch only, text only inside UNTRUSTED blocks", async () => {
    const { db, run, argvFile } = build("people_ok");
    await run();
    const recs = db.select().from(schema.peopleProfileRecommendations).all();
    expect(recs).toHaveLength(1);
    const content = recs[0]?.content as ProfileContent;
    // the forged id and the uncited observation are gone
    expect(content.professionalContext[0]?.evidence).toEqual(["m-p-1"]);
    expect(content.communication.map((o) => o.key)).toEqual(["prefers-async"]);
    expect(db.select().from(schema.peopleProfileEvidence).all()).toHaveLength(2);
    expect(db.select().from(schema.approvals).all()[0]).toMatchObject({
      action: "records.update",
      status: "pending",
    });
    const runs = db.select().from(schema.claudeRuns).all();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ workerProfile: "intelligence", status: "succeeded" });
    expect(recs[0]?.claudeRunId).toBe(runs[0]?.id as string);

    const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
    const at = (flag: string) => argv[argv.indexOf(flag) + 1];
    expect(at("--allowedTools")).toBe("ToolSearch");
    expect(at("--model")).toBe("sonnet");
    expect(at("--max-turns")).toBe("3");
    const prompt = at("-p") as string;
    expect(prompt).toContain("UNTRUSTED");
    expect(prompt).toContain("slack message m-p-1 by them in #payments");
    const deny = (at("--disallowedTools") ?? "").split(",");
    for (const t of ["mcp__claude_ai_Slack", "WebFetch", "WebSearch", "Bash", "Write"]) {
      expect(deny).toContain(t);
    }
    const outside = prompt.replace(/<<<UNTRUSTED[\s\S]*?<<<END \w+>>>/g, "");
    expect(outside).not.toContain(BODY);
  });

  test("invalid JSON output -> incomplete_ai_output and nothing stored", async () => {
    const { db, run } = build("people_invalid");
    const err = await run().catch((e) => e);
    expect(err).toBeInstanceOf(JobError);
    expect((err as JobError).classified.kind).toBe("incomplete_ai_output");
    expect(db.select().from(schema.peopleProfileRecommendations).all()).toHaveLength(0);
    expect(db.select().from(schema.approvals).all()).toHaveLength(0);
  });

  test("5,000 long CJK messages: one request of the newest 150 passes the real validator", async () => {
    const texts = Array.from({ length: 5000 }, () => "漢".repeat(8000));
    const { db, run, argvFile } = build("people_ok", texts);
    await run();
    expect(db.select().from(schema.claudeRuns).all()[0]?.status).toBe("succeeded");
    const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
    const prompt = argv[argv.indexOf("-p") + 1] as string;
    expect(prompt.match(/<<<UNTRUSTED /g)).toHaveLength(150);
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThan(100 * 1024);
  });
});
