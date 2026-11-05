/**
 * Slack collector end to end through the REAL ClaudeCliProvider and ClaudeOrchestrator, with the
 * fake-claude binary replaying a stream-json fixture (never the real claude). Proves the R57
 * classification: what the provider really returns for error/no tool results reaches the source.
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
import { SlackConnectorSource } from "../../src/integrations/slack/connector-source";
import { InboxStore } from "../../src/modules/inbox/store";
import { SyncStateService } from "../../src/modules/inbox/sync-state";
import { registerSlackJobs } from "../../src/workers/slack";

const fakeClaude = resolve(import.meta.dir, "../fixtures/fake-claude.ts");
const tmp = mkdtempSync(join(tmpdir(), "slack-e2e-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const NOW = "2026-11-05T10:05:00.000Z"; // 1793873100, just after the fixture timestamps
const AFTER = "1793872800.000000";
const PARENT = "1793872920.000500";
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
  const audit = new AuditLogger(clock);
  const provider = new ClaudeCliProvider({
    binary: process.execPath,
    prefixArgs: ["run", fakeClaude],
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", FAKE_CLAUDE_MODE: mode },
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
  const source = new SlackConnectorSource({ orchestrator, clock });
  const queue = new JobQueue(db, clock);
  /** claude_runs.job_id references jobs, so a run's job must exist. */
  const jobRow = (type: string, input: unknown = null) =>
    db.transaction((tx) => queue.enqueue(tx, { type, input, idempotencyKey: type })).id;
  return { db, clock, events, settings, audit, source, queue, jobRow };
}

async function failure(p: Promise<unknown>): Promise<JobError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(JobError);
    return e as JobError;
  }
  throw new Error("expected rejection");
}

describe("collect through the real provider", () => {
  test("happy path: one page accepted, run row carries the job id", async () => {
    const { source, db, jobRow } = build("slack_search_page");
    const jobId = jobRow("slack.collect_incremental");
    const r = await source.collect({ afterTs: AFTER, maxPages: 5, jobId }, signal);
    expect(r.pages).toHaveLength(1);
    expect(r.pages[0]?.messages.map((m) => m.ts)).toEqual([
      "1793872900.000300",
      "1793872910.000400",
    ]);
    expect(r.complete).toBe(true);
    expect(r.searches).toBe(1);
    const runs = db.select().from(schema.claudeRuns).all();
    expect(runs.map((x) => [x.jobId, x.status])).toEqual([[jobId, "succeeded"]]);
  });

  test("search rate-limit error -> rate_limited with retryAfter", async () => {
    const { source } = build("slack_search_ratelimit");
    const e = await failure(source.collect({ afterTs: AFTER, maxPages: 5 }, signal));
    expect(e.classified.kind).toBe("rate_limited");
    expect(e.classified.retryAfter).toBe(new Date(Date.parse(NOW) + 30_000).toISOString());
  });

  test("only a non-rate search error -> provider_error", async () => {
    const { source } = build("slack_search_error");
    const e = await failure(source.collect({ afterTs: AFTER, maxPages: 5 }, signal));
    expect(e.classified.kind).toBe("provider_error");
  });

  test("no search tool_result at all -> incomplete_ai_output", async () => {
    const { source } = build("slack_search_none");
    const e = await failure(source.collect({ afterTs: AFTER, maxPages: 5 }, signal));
    expect(e.classified.kind).toBe("incomplete_ai_output");
  });
});

describe("fetchThreads through the real provider", () => {
  const req = { conversationId: "D0SYNTHDM01", parentTs: PARENT };

  test("thread rate-limit error -> rate_limited", async () => {
    const { source } = build("slack_thread_ratelimit");
    const e = await failure(source.fetchThreads([req], signal));
    expect(e.classified.kind).toBe("rate_limited");
    expect(e.classified.retryAfter).toBe(new Date(Date.parse(NOW) + 45_000).toISOString());
  });

  test("thread non-rate error -> pair unavailable; handler completes with an audit row (R46)", async () => {
    const { source, db, clock, events, settings, audit, queue, jobRow } =
      build("slack_thread_error");
    expect(await source.fetchThreads([req], signal)).toEqual([]);

    const sync = new SyncStateService(db, clock);
    const handlers = new Map<string, HandlerRegistration>();
    registerSlackJobs({
      db,
      clock,
      source,
      store: new InboxStore({ db, clock, events, queue, sync }),
      sync,
      queue,
      settings,
      events,
      audit,
      scheduler: new SchedulerService(db, clock, queue),
      handlers,
    });
    const id = jobRow("slack.fetch_thread", req);
    const job = { id, type: "slack.fetch_thread", input: req, attempts: 1, maxAttempts: 3 };
    const out = await handlers.get("slack.fetch_thread")?.handler(
      job as unknown as Job,
      {
        signal,
        checkpoint() {},
        getCheckpoint: () => undefined,
      } as never,
    );
    expect(out).toEqual({ unavailable: true });
    const rows = db.select().from(schema.auditEvents).all();
    expect(rows.filter((r) => r.action === "slack.thread_unavailable")).toHaveLength(1);
    const runs = db.select().from(schema.claudeRuns).all();
    expect(runs.map((r) => r.jobId)).toContain(id);
  });

  test("R62: a thread error whose input does not match the pair -> incomplete_ai_output", async () => {
    const { source } = build("slack_thread_error_mismatch"); // message_ts sent as a number
    const e = await failure(source.fetchThreads([req], signal));
    expect(e.classified.kind).toBe("incomplete_ai_output");
  });

  test("no thread tool_result at all -> incomplete_ai_output (never unavailable)", async () => {
    const { source } = build("slack_thread_none");
    const e = await failure(source.fetchThreads([req], signal));
    expect(e.classified.kind).toBe("incomplete_ai_output");
  });
});
