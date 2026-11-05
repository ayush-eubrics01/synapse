/**
 * Urgency assessment end to end through the REAL ClaudeCliProvider and ClaudeOrchestrator, with
 * the fake-claude binary replaying a stream-json fixture (never the real claude).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Job, JobError, type ScreeningRecord } from "@synapse/contracts";
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
import { ClaudeCliProvider } from "../../src/integrations/claude-code/cli-provider";
import { PeopleService } from "../../src/modules/people/service";
import { SecurityFlagsService } from "../../src/modules/security-flags/service";
import { registerUrgencyJobs } from "../../src/workers/urgency";

const fakeClaude = resolve(import.meta.dir, "../fixtures/fake-claude.ts");
const tmp = mkdtempSync(join(tmpdir(), "urgency-e2e-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const NOW = "2026-11-05T10:05:00.000Z";
const signal = new AbortController().signal;
const BODY = "BODY-SECRET-abc";

function build(mode: string, texts: string[] = [`${BODY} 1`, `${BODY} 2`]) {
  const credsPath = join(tmp, `creds-${mode}.json`);
  writeFileSync(
    credsPath,
    JSON.stringify({
      claudeAiOauth: { expiresAt: Date.parse(NOW) + 3_600_000, refreshTokenExpiresAt: 1.9e12 },
    }),
  );
  const argvFile = join(tmp, `argv-${mode}.json`);
  const { db } = openDatabase(":memory:");
  runMigrations(db);
  const clock = new FakeClock(NOW);
  const events = new EventPublisher(clock);
  const settings = new SettingsService(db, clock, events.publish.bind(events));
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
  registerUrgencyJobs({
    db,
    clock,
    settings,
    events,
    queue,
    notifications,
    orchestrator,
    securityFlags,
    handlers,
  });
  db.insert(schema.slackUsers).values({ id: "su1", externalId: "UPRIYA0001", name: "Priya" }).run();
  db.insert(schema.slackConversations)
    .values({ id: "c1", externalId: "C1", type: "channel", name: "payments" })
    .run();
  for (const n of texts.map((_, i) => i + 1)) {
    db.insert(schema.slackMessages)
      .values({
        id: `m-urg-${n}`,
        conversationId: "c1",
        ts: `${1000 + n}.000000`,
        senderUserId: "su1",
        text: texts[n - 1] as string,
        sentAt: new Date(Date.parse(NOW) - 60_000 + n * 1000).toISOString(),
        collectedAt: NOW,
        screening: {
          version: 1,
          candidate: true,
          score: 3,
          ruleLevel: "high",
          matchedRules: ["kw:prod"],
          urgencySignals: [],
          route: "assess",
          assessed: false,
        } satisfies ScreeningRecord,
      })
      .run();
  }
  const run = () => {
    const id = db.transaction(
      (tx) => queue.enqueue(tx, { type: "urgency.assess", idempotencyKey: "urgency.batch:1" }).id,
    );
    const job = { id, type: "urgency.assess", attempts: 1, maxAttempts: 3 } as unknown as Job;
    return handlers.get("urgency.assess")?.handler(job, {
      signal,
      checkpoint() {},
      getCheckpoint: () => undefined,
    } as never) as Promise<unknown>;
  };
  const runSuggest = (messageId: string) => {
    const id = db.transaction(
      (tx) =>
        queue.enqueue(tx, {
          type: "urgency.suggest_response",
          idempotencyKey: `urgency.suggest:${messageId}`,
          input: { messageId },
        }).id,
    );
    const job = {
      id,
      type: "urgency.suggest_response",
      attempts: 1,
      maxAttempts: 3,
      input: { messageId },
    } as unknown as Job;
    return handlers.get("urgency.suggest_response")?.handler(job, {
      signal,
      checkpoint() {},
      getCheckpoint: () => undefined,
    } as never) as Promise<unknown>;
  };
  return { db, run, runSuggest, argvFile };
}

const msg = (db: ReturnType<typeof build>["db"], id: string) =>
  db.select().from(schema.slackMessages).where(eq(schema.slackMessages.id, id)).get();

describe("urgency.assess through the real provider", () => {
  test("happy path: levels written, ToolSearch only, untrusted text in the prompt only", async () => {
    const { db, run, argvFile } = build("urgency_ok");
    await run();
    expect(msg(db, "m-urg-1")).toMatchObject({ urgencyLevel: "critical", urgencyStatus: "new" });
    expect(msg(db, "m-urg-2")).toMatchObject({ urgencyLevel: "low" });
    const n = db.select().from(schema.notifications).all();
    expect(n.map((x) => x.title)).toEqual(["Critical: message from Priya in #payments"]);
    expect(JSON.stringify(n)).not.toContain(BODY);
    const runs = db.select().from(schema.claudeRuns).all();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ workerProfile: "intelligence", status: "succeeded" });

    const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
    const at = (flag: string) => argv[argv.indexOf(flag) + 1];
    expect(at("--allowedTools")).toBe("ToolSearch");
    const prompt = at("-p") as string;
    expect(prompt).toContain("UNTRUSTED");
    expect(prompt).toContain(`${BODY} 1`);
    expect(at("--model")).toBe("haiku");
    expect(at("--max-turns")).toBe("3");
    const deny = (at("--disallowedTools") ?? "").split(",");
    for (const t of ["mcp__claude_ai_Slack", "WebFetch", "WebSearch", "Bash", "Write"]) {
      expect(deny).toContain(t);
    }
    // message text appears only inside an UNTRUSTED block
    const outside = prompt.replace(/<<<UNTRUSTED[\s\S]*?<<<END \w+>>>/g, "");
    expect(outside).not.toContain(BODY);
  });

  test("invalid JSON output -> incomplete_ai_output and nothing written", async () => {
    const { db, run } = build("urgency_invalid");
    let err: unknown;
    try {
      await run();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(JobError);
    expect((err as JobError).classified.kind).toBe("incomplete_ai_output");
    expect(msg(db, "m-urg-1")?.urgencyLevel).toBeNull();
    expect(db.select().from(schema.notifications).all()).toHaveLength(0);
  });

  test("R16: a max_turns run with a denied send tool -> high runtime flags, run row failed", async () => {
    const { db, run } = build("max_turns");
    const err = await run().catch((e) => e);
    expect(err).toBeInstanceOf(JobError);
    expect((err as JobError).classified).toMatchObject({
      kind: "provider_error",
      details: { maxTurns: true },
    });
    const runs = db.select().from(schema.claudeRuns).all();
    expect(runs[0]).toMatchObject({
      status: "failed",
      permissionDenials: ["mcp__claude_ai_Slack__slack_send_message"],
    });
    const f = db.select().from(schema.securityFlags).all();
    expect(f.map((x) => x.messageId).sort()).toEqual(["m-urg-1", "m-urg-2"]);
    for (const x of f) {
      expect(x).toMatchObject({ detector: "runtime", severity: "high", claudeRunId: runs[0]?.id });
      expect(x.reason).toBe(
        "denied tools: mcp__claude_ai_Slack__slack_send_message; max_turns reached",
      );
    }
    expect(JSON.stringify(f)).not.toContain(BODY);
  });

  test("10 messages of 8000 CJK chars pass the real validator", async () => {
    const texts = Array.from({ length: 10 }, () => "漢".repeat(8000));
    const { db, run } = build("urgency_ok", texts);
    // the fixture answers for m-urg-1 and m-urg-2 only; the other eight fall back
    await run();
    expect(db.select().from(schema.claudeRuns).all()[0]?.status).toBe("succeeded");
    expect(msg(db, "m-urg-1")?.urgencyLevel).toBe("critical");
  });
});

describe("urgency.suggest_response through the real provider", () => {
  test("happy path: draft stored, ToolSearch only, text only inside UNTRUSTED blocks", async () => {
    const { db, runSuggest, argvFile } = build("suggest_ok");
    db.update(schema.slackMessages).set({ urgencyLevel: "high" }).run();
    await runSuggest("m-urg-2");
    const drafts = db.select().from(schema.messageDrafts).all();
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      messageId: "m-urg-2",
      status: "proposed",
      text: "Thanks, looking into it now.",
      confidence: 0.7,
    });
    const run = db.select().from(schema.claudeRuns).all();
    expect(run).toHaveLength(1);
    expect(drafts[0]?.claudeRunId).toBe(run[0]?.id as string);
    expect(db.select().from(schema.securityFlags).all()).toHaveLength(0);

    const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
    const at = (flag: string) => argv[argv.indexOf(flag) + 1];
    expect(at("--allowedTools")).toBe("ToolSearch");
    const prompt = at("-p") as string;
    expect(prompt).toContain(`${BODY} 2`);
    expect(prompt).toContain(`${BODY} 1`); // earlier message in the conversation as context
    const outside = prompt.replace(/<<<UNTRUSTED[\s\S]*?<<<END \w+>>>/g, "");
    expect(outside).not.toContain(BODY);
    const deny = (at("--disallowedTools") ?? "").split(",");
    for (const t of ["mcp__claude_ai_Slack", "WebFetch", "Bash", "Write"]) {
      expect(deny).toContain(t);
    }
  });

  test("target plus 10 long CJK context messages pass the real validator", async () => {
    const texts = Array.from({ length: 11 }, () => "漢".repeat(8000));
    const { db, runSuggest } = build("suggest_ok", texts);
    db.update(schema.slackMessages).set({ urgencyLevel: "critical" }).run();
    await runSuggest("m-urg-11");
    expect(db.select().from(schema.claudeRuns).all()[0]?.status).toBe("succeeded");
    expect(db.select().from(schema.messageDrafts).all()).toHaveLength(1);
  });
});
