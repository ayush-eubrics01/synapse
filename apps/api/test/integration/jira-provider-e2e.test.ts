/**
 * Jira sync end to end through the REAL ClaudeCliProvider and ClaudeOrchestrator, with a fake
 * binary (never the real claude). Proves the argument check: a search whose JQL differs from the
 * requested one is rejected as incomplete_ai_output and stores nothing.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Job, JobError } from "@synapse/contracts";
import { openDatabase, runMigrations, schema } from "@synapse/database";
import { FakeClock } from "@synapse/shared";
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
import { JiraConnectorSource } from "../../src/integrations/jira/connector-source";
import { SyncStateService } from "../../src/modules/inbox/sync-state";
import { JIRA_JOB } from "../../src/modules/jira-tracking/service";
import { JiraStore } from "../../src/modules/jira-tracking/store";
import { registerJiraJobs } from "../../src/workers/jira";

const fakeClaude = resolve(import.meta.dir, "../fixtures/jira-fake-claude.ts");
const tmp = mkdtempSync(join(tmpdir(), "jira-e2e-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const NOW = "2026-11-06T12:00:00.000Z";
const CLOUD = "00000000-0000-4000-8000-000000000000";
const signal = new AbortController().signal;

function build(mode: string) {
  const credsPath = join(tmp, `creds-${mode}.json`);
  writeFileSync(
    credsPath,
    JSON.stringify({
      claudeAiOauth: { expiresAt: Date.parse(NOW) + 3_600_000, refreshTokenExpiresAt: 1.9e12 },
    }),
  );
  const { db } = openDatabase(":memory:");
  runMigrations(db);
  const clock = new FakeClock(NOW);
  const events = new EventPublisher(clock);
  const settings = new SettingsService(db, clock, events.publish.bind(events));
  const provider = new ClaudeCliProvider({
    binary: process.execPath,
    prefixArgs: ["run", fakeClaude],
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", FAKE_JIRA_MODE: mode },
    clock,
    killGraceMs: 200,
  });
  const orchestrator = new ClaudeOrchestrator({
    db,
    clock,
    provider,
    settings,
    events,
    audit: new AuditLogger(clock),
    auth: new AuthMonitor(db, clock, settings, events, credsPath),
    notifications: new NotificationService(db, clock, new LiveBus()),
    scratchDir: tmp,
  });
  const queue = new JobQueue(db, clock);
  const sync = new SyncStateService(db, clock);
  const handlers = new Map<string, HandlerRegistration>();
  registerJiraJobs({
    db,
    clock,
    settings,
    sync,
    store: new JiraStore({ db, clock, events, settings, timeZone: "UTC" }),
    queue,
    events,
    scheduler: new SchedulerService(db, clock, queue),
    handlers,
    source: new JiraConnectorSource({ orchestrator, clock }),
  });
  settings.set("jira.enabled", true);
  settings.set("jira.cloudId", CLOUD);
  const runSync = () => {
    const h = handlers.get(JIRA_JOB.sync);
    if (!h) throw new Error("no sync handler");
    return h.handler(
      { id: "j1", type: JIRA_JOB.sync, input: null, attempts: 1, maxAttempts: 3 } as unknown as Job,
      { signal, checkpoint() {}, getCheckpoint: () => undefined } as never,
    );
  };
  return { db, sync, runSync };
}

describe("jira sync through the real provider", () => {
  test("matching arguments: issues stored and the checkpoint advances", async () => {
    const { db, sync, runSync } = build("ok");
    await runSync();
    const rows = db.select().from(schema.jiraIssues).all();
    expect(rows.map((r) => r.key).sort()).toEqual(["DEMO-1", "DEMO-2"]);
    expect(rows.every((r) => r.inScope)).toBe(true);
    expect(sync.get("jira.issues").checkpoint).toBe("2026-11-06T10:30:00.000Z");
    expect(
      db
        .select()
        .from(schema.claudeRuns)
        .all()
        .map((r) => r.status),
    ).toEqual(["succeeded"]);
  });

  test("altered JQL: nothing stored, incomplete_ai_output, checkpoint unchanged", async () => {
    const { db, sync, runSync } = build("altered_jql");
    let err: unknown;
    try {
      await runSync();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(JobError);
    expect((err as JobError).classified.kind).toBe("incomplete_ai_output");
    expect(db.select().from(schema.jiraIssues).all()).toHaveLength(0);
    expect(sync.get("jira.issues").checkpoint).toBeNull();
  });
});
