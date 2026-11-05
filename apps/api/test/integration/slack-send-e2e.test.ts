/**
 * Slack send end to end through the REAL ClaudeCliProvider, ClaudeOrchestrator and validator, with
 * the fake-claude binary replaying a stream-json fixture (never the real claude, never a real send).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type AIProvider, JobError, type SendMessageCommand } from "@synapse/contracts";
import { openDatabase, runMigrations, schema } from "@synapse/database";
import { FakeClock } from "@synapse/shared";
import { AuditLogger } from "../../src/core/audit/audit";
import { SettingsService } from "../../src/core/config/settings";
import { LiveBus } from "../../src/core/events/live-bus";
import { EventPublisher } from "../../src/core/events/publisher";
import { JobQueue } from "../../src/core/jobs/queue";
import { NotificationService } from "../../src/core/notifications/notifications";
import { AuthMonitor } from "../../src/core/orchestrator/auth";
import { ClaudeOrchestrator } from "../../src/core/orchestrator/orchestrator";
import { ClaudeCliProvider } from "../../src/integrations/claude-code/cli-provider";
import { SlackConnectorSource } from "../../src/integrations/slack/connector-source";
import { buildSendRequest, SEND, SlackSender } from "../../src/integrations/slack/sender";
import { createRunHelpers } from "../../src/workers/intelligence-shared";

const fakeClaude = resolve(import.meta.dir, "../fixtures/fake-claude.ts");
const tmp = mkdtempSync(join(tmpdir(), "slack-send-e2e-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const NOW = "2026-11-05T10:05:00.000Z";
const TEXT = "SYNTH-APPROVED-TEXT: deploy is done";
const signal = new AbortController().signal;
let seq = 0;

/** `beforeExecute` runs inside the real provider call, i.e. while the run is in flight. */
function build(mode: string, beforeExecute?: (settings: SettingsService) => void) {
  const id = `${mode}-${seq++}`;
  const credsPath = join(tmp, `creds-${id}.json`);
  writeFileSync(
    credsPath,
    JSON.stringify({
      claudeAiOauth: { expiresAt: Date.parse(NOW) + 3_600_000, refreshTokenExpiresAt: 1.9e12 },
    }),
  );
  const argvFile = join(tmp, `argv-${id}.json`);
  const { db } = openDatabase(":memory:");
  runMigrations(db);
  const clock = new FakeClock(NOW);
  const events = new EventPublisher(clock);
  const settings = new SettingsService(db, clock, events.publish.bind(events));
  const audit = new AuditLogger(clock);
  const cli = new ClaudeCliProvider({
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
  const provider: AIProvider = {
    execute: (req, sig) => {
      beforeExecute?.(settings);
      return cli.execute(req, sig);
    },
    getHealth: () => cli.getHealth(),
  };
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
  const runHelpers = createRunHelpers(db, {} as never);
  const sender = new SlackSender({
    orchestrator,
    searchSource: new SlackConnectorSource({ orchestrator, clock }),
    selfUserId: () => settings.get("slack.selfUserId"),
    runIdForJob: runHelpers.runIdBefore,
  });
  const queue = new JobQueue(db, clock);
  /** claude_runs.job_id references jobs, so a run's job must exist. */
  const jobId = db.transaction(
    (tx) => queue.enqueue(tx, { type: "approval.execute", idempotencyKey: `send:${id}` }).id,
  );
  const cmd: SendMessageCommand = {
    outgoingId: "out-1",
    approvalId: "appr-1",
    conversationExternalId: "C0SYNTHCHN1",
    threadTs: "1793872900.000300",
    text: TEXT,
    jobId,
  };
  const argv = () => JSON.parse(readFileSync(argvFile, "utf8")) as string[];
  return { db, settings, orchestrator, sender, cmd, argv, argvFile };
}

describe("send through the real provider and validator", () => {
  test("happy path: validator accepts; only the send tool; approved JSON outside UNTRUSTED", async () => {
    const { db, sender, cmd, argv } = build("send_ok");
    const r = await sender.send(cmd, signal);
    const runs = db.select().from(schema.claudeRuns).all();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ jobId: cmd.jobId, workerProfile: "collector" });
    expect(r).toEqual({ status: "sent_unverified", runId: runs[0]?.id as string });

    const a = argv();
    const at = (flag: string) => a[a.indexOf(flag) + 1];
    expect(at("--allowedTools")).toBe(`${SEND},ToolSearch`);
    expect(at("--max-turns")).toBe("3");
    expect(at("--model")).toBe("haiku");
    expect(at("--system-prompt")).not.toMatch(/never send/i);
    const prompt = at("-p") as string;
    expect(prompt).not.toContain("UNTRUSTED");
    expect(prompt).toContain(
      JSON.stringify({ channel_id: "C0SYNTHCHN1", message: TEXT, thread_ts: "1793872900.000300" }),
    );
    const deny = (at("--disallowedTools") ?? "").split(",");
    for (const t of ["Bash", "Write", "Edit", "WebFetch", "WebSearch", "Read"]) {
      expect(deny).toContain(t);
    }
    // no content in the run row or audit
    expect(JSON.stringify(runs)).not.toContain("SYNTH-APPROVED");
    expect(JSON.stringify(db.select().from(schema.auditEvents).all())).not.toContain(
      "SYNTH-APPROVED",
    );
  });

  test("the validator rejects the same request with an untrusted part; nothing spawns", async () => {
    const { db, orchestrator, cmd, argvFile } = build("send_ok");
    const req = buildSendRequest(cmd);
    const err = await orchestrator
      .run(
        {
          ...req,
          parts: [...(req.parts ?? []), { provenance: "untrusted", source: "x", content: "hi" }],
        },
        signal,
      )
      .catch((e) => e);
    expect(err).toBeInstanceOf(JobError);
    expect((err as JobError).classified.kind).toBe("invalid_input");
    expect((err as JobError).classified.details?.uncertain).toBeUndefined();
    expect(existsSync(argvFile)).toBe(false);
    expect(db.select().from(schema.claudeRuns).all()).toHaveLength(0);
  });

  const failures: [string, Record<string, unknown>][] = [
    ["send_mismatch_channel", { status: "failed", failure: "argument_mismatch", mismatch: true }],
    ["send_dropped_thread", { status: "failed", failure: "argument_mismatch", mismatch: true }],
    ["send_altered_text", { status: "failed", failure: "argument_mismatch", mismatch: true }],
    ["send_reply_broadcast", { status: "failed", failure: "argument_mismatch", mismatch: true }],
    ["send_tool_error", { status: "failed", failure: "tool_error" }],
    ["send_tool_error_transport", { status: "uncertain", failure: "uncertain_outcome" }],
    ["send_none", { status: "failed", failure: "no_send" }],
    ["send_two", { status: "uncertain", failure: "uncertain_outcome" }],
  ];
  for (const [mode, expected] of failures) {
    test(`${mode} -> ${expected.failure}`, async () => {
      const { db, sender, cmd } = build(mode);
      const r = await sender.send(cmd, signal);
      const runId = db.select().from(schema.claudeRuns).all()[0]?.id as string;
      expect(r).toEqual({ ...expected, runId } as never);
    });
  }

  test("a crash after spawn -> uncertain (never rethrown, so never retried blindly)", async () => {
    const { db, sender, cmd } = build("crash");
    const r = await sender.send(cmd, signal);
    const runs = db.select().from(schema.claudeRuns).all();
    expect(runs[0]?.status).toBe("failed");
    expect(r).toEqual({
      status: "uncertain",
      failure: "uncertain_outcome",
      runId: runs[0]?.id as string,
    });
  });

  test("R4: an auth failure while another run set the pause mid-flight -> uncertain", async () => {
    const { db, sender, cmd, settings } = build("auth_error", (s) =>
      s.set("auth.pausedAt", NOW, { emit: false }),
    );
    const r = await sender.send(cmd, signal);
    expect(settings.get("auth.pausedAt")).toBe(NOW);
    const runs = db.select().from(schema.claudeRuns).all();
    expect(r).toEqual({
      status: "uncertain",
      failure: "uncertain_outcome",
      runId: runs[0]?.id as string,
    });
  });

  test("a quota stop before spawn is rethrown; nothing spawns", async () => {
    const { db, sender, cmd, argvFile } = build("send_ok");
    db.insert(schema.quotaSnapshots)
      .values({
        id: "q1",
        observedAt: NOW,
        fiveHourUtilization: 1,
        fiveHourResetsAt: "2026-11-05T12:00:00.000Z",
        sevenDayUtilization: 0.1,
        sevenDayResetsAt: "2026-11-10T00:00:00.000Z",
        status: "rejected",
        fiveHourStatus: "rejected",
        sevenDayStatus: "allowed",
      })
      .run();
    const err = await sender.send(cmd, signal).catch((e) => e);
    expect(err).toBeInstanceOf(JobError);
    expect((err as JobError).classified.kind).toBe("quota_exhausted");
    expect(existsSync(argvFile)).toBe(false);
  });
});

describe("findSent through the real provider", () => {
  // slack_search_page: message 1793872910.000400 in C0SYNTHCHN1 from U0SYNTH0001,
  // text "synthetic channel message two", top level; the request args match afterTs 1793872800.
  const since = "1793872801.000000";
  const topLevel = (cmd: SendMessageCommand, text: string): SendMessageCommand => {
    const { threadTs: _t, ...rest } = cmd;
    return { ...rest, text };
  };

  test("true when the self-authored message is found", async () => {
    const { sender, cmd, settings } = build("slack_search_page");
    settings.set("slack.selfUserId", "U0SYNTH0001");
    const found = await sender.findSent(topLevel(cmd, " synthetic channel\nmessage  two "), since);
    expect(found).toBe(true);
  });

  test("false for a different text", async () => {
    const { sender, cmd, settings } = build("slack_search_page");
    settings.set("slack.selfUserId", "U0SYNTH0001");
    expect(await sender.findSent(topLevel(cmd, "something else"), since)).toBe(false);
  });

  test("false for the same text when a thread reply was intended", async () => {
    const { sender, cmd, settings } = build("slack_search_page");
    settings.set("slack.selfUserId", "U0SYNTH0001");
    expect(await sender.findSent({ ...cmd, text: "synthetic channel message two" }, since)).toBe(
      false,
    );
  });

  test("null on a search error", async () => {
    const { sender, cmd, settings } = build("slack_search_error");
    settings.set("slack.selfUserId", "U0SYNTH0001");
    expect(await sender.findSent(cmd, since)).toBeNull();
  });
});
