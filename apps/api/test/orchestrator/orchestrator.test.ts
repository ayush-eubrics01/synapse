import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type AIExecutionRequest,
  type AIExecutionResult,
  type AIProvider,
  type ClaudeJobRequest,
  JobError,
  type QuotaWindow,
  type UserActivitySignal,
} from "@synapse/contracts";
import { openDatabase, runMigrations, schema } from "@synapse/database";
import { FakeClock } from "@synapse/shared";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { AuditLogger } from "../../src/core/audit/audit";
import { SettingsService } from "../../src/core/config/settings";
import { LiveBus } from "../../src/core/events/live-bus";
import { EventPublisher } from "../../src/core/events/publisher";
import { NotificationService } from "../../src/core/notifications/notifications";
import { AuthMonitor } from "../../src/core/orchestrator/auth";
import { buildClaudeArgs } from "../../src/core/orchestrator/cli-args";
import {
  ClaudeOrchestrator,
  DEFAULT_SYSTEM_PROMPTS,
  UNSAFE_USER_SETTINGS_MESSAGE,
} from "../../src/core/orchestrator/orchestrator";
import { SANDBOX_REQUIRED_REASON } from "../../src/core/orchestrator/validator";
import { recoverOrphanRuns } from "../../src/core/recovery/recovery";

const START = "2026-11-05T12:00:00.000Z";
const SEARCH = "mcp__claude_ai_Slack__slack_search_public";
const SECRET = "UNTRUSTED-SECRET-CONTENT-42";

function result(over: Partial<AIExecutionResult> = {}): AIExecutionResult {
  return {
    status: "succeeded",
    toolResults: [],
    finalText: "",
    numTurns: 2,
    durationMs: 50,
    usage: {
      inputTokens: 10,
      outputTokens: 20,
      cacheCreationInputTokens: 3,
      cacheReadInputTokens: 4,
      costUsdEquivalent: 0.01,
    },
    permissionDenials: [],
    connectors: [],
    availableTools: [],
    exitCode: 0,
    ...over,
  };
}

function quota(five: number, resetsAt = "2026-11-05T15:00:00.000Z", status = "allowed") {
  return {
    observedAt: START,
    fiveHour: { utilization: five, status, resetsAt } as QuotaWindow,
    sevenDay: { utilization: 0.1, status: "allowed", resetsAt: "2026-11-10T00:00:00.000Z" },
  };
}

class FakeProvider implements AIProvider {
  requests: AIExecutionRequest[] = [];
  next: () => AIExecutionResult | Promise<AIExecutionResult> = () => result();
  active = 0;
  peak = 0;
  async execute(r: AIExecutionRequest, _signal: AbortSignal): Promise<AIExecutionResult> {
    this.requests.push(r);
    this.active++;
    this.peak = Math.max(this.peak, this.active);
    try {
      return await this.next();
    } finally {
      this.active--;
    }
  }
  async getHealth() {
    return { status: "ok" as const };
  }
}

let db: ReturnType<typeof openDatabase>["db"];
let sqlite: ReturnType<typeof openDatabase>["sqlite"];
let clock: FakeClock;
let settings: SettingsService;
let provider: FakeProvider;
let orch: ClaudeOrchestrator;
let credsPath: string;

function writeCreds(refreshExpiresAt: number) {
  writeFileSync(
    credsPath,
    JSON.stringify({
      claudeAiOauth: { expiresAt: Date.now() + 3_600_000, refreshTokenExpiresAt: refreshExpiresAt },
    }),
  );
}

afterEach(() => {
  rmSync(dirname(credsPath), { recursive: true, force: true });
});

beforeEach(() => {
  credsPath = join(mkdtempSync(join(tmpdir(), "synapse-creds-")), "creds.json");
  writeCreds(1_900_000_000_000);
  ({ db, sqlite } = openDatabase(":memory:"));
  runMigrations(db);
  clock = new FakeClock(START);
  settings = new SettingsService(db, clock, () => "e");
  provider = new FakeProvider();
  orch = new ClaudeOrchestrator({
    db,
    clock,
    provider,
    settings,
    events: new EventPublisher(clock),
    audit: new AuditLogger(clock),
    auth: new AuthMonitor(db, clock, settings, new EventPublisher(clock), credsPath),
    notifications: new NotificationService(db, clock, new LiveBus()),
    scratchDir: "/scratch",
    random: () => "0123456789abcdef",
  });
});

function req(over: Partial<ClaudeJobRequest> = {}): ClaudeJobRequest {
  return {
    workerProfile: "collector",
    priorityClass: "collection",
    instructions: "collect",
    allowedTools: [SEARCH],
    maxTurns: 3,
    ...over,
  };
}
const S = () => new AbortController().signal;
const run = (r: ClaudeJobRequest, signal: AbortSignal = S()) => orch.run(r, signal);
const runs = () => db.select().from(schema.claudeRuns).all();
const events = (type: string) =>
  db.select().from(schema.domainEvents).where(eq(schema.domainEvents.type, type)).all();
function snap2(o: {
  five: number | null;
  seven: number | null;
  fiveStatus: string | null;
  sevenStatus: string | null;
  fiveResets?: string;
  sevenResets?: string;
}) {
  db.insert(schema.quotaSnapshots)
    .values({
      id: crypto.randomUUID(),
      observedAt: START,
      fiveHourUtilization: o.five,
      fiveHourResetsAt: o.fiveResets ?? "2026-11-05T15:00:00.000Z",
      sevenDayUtilization: o.seven,
      sevenDayResetsAt: o.sevenResets ?? "2026-11-10T00:00:00.000Z",
      status: "rejected",
      fiveHourStatus: o.fiveStatus,
      sevenDayStatus: o.sevenStatus,
    })
    .run();
}
function snap(five: number, status = "allowed", resetsAt = "2026-11-05T15:00:00.000Z") {
  db.insert(schema.quotaSnapshots)
    .values({
      id: crypto.randomUUID(),
      observedAt: START,
      fiveHourUtilization: five,
      fiveHourResetsAt: resetsAt,
      sevenDayUtilization: 0.1,
      sevenDayResetsAt: "2026-11-10T00:00:00.000Z",
      status,
    })
    .run();
}
async function fails(p: Promise<unknown>): Promise<JobError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof JobError) return e;
    throw e;
  }
  throw new Error("expected JobError");
}

describe("run", () => {
  test("success logs the run, events and quota", async () => {
    provider.next = () => result({ quota: quota(0.3) });
    await run(req());
    const r = runs()[0];
    expect(r?.status).toBe("succeeded");
    expect(r?.inputTokens).toBe(10);
    expect(r?.outputTokens).toBe(20);
    expect(r?.error).toBeNull();
    expect(events("claude.job_started")).toHaveLength(1);
    expect(events("claude.job_completed")).toHaveLength(1);
    const q = db.select().from(schema.quotaSnapshots).all();
    expect(q).toHaveLength(1);
    expect(q[0]?.claudeRunId).toBe(r?.id ?? "");
    expect(q[0]?.fiveHourUtilization).toBe(0.3);
  });

  test("validation failure never reaches the provider or stores content", async () => {
    const e = await fails(
      run(
        req({
          workerProfile: "engineering",
          priorityClass: "engineering",
          allowedTools: ["Read"],
          parts: [{ provenance: "untrusted", source: "slack", content: SECRET }],
        }),
      ),
    );
    expect(e.classified.kind).toBe("invalid_input");
    expect(provider.requests).toHaveLength(0);
    const audit = db.select().from(schema.auditEvents).all();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.action).toBe("claude.request_rejected");
    expect(JSON.stringify(audit)).not.toContain(SECRET);
    expect(JSON.stringify(e.classified)).not.toContain(SECRET);
  });

  test("untrusted content never lands in runs, audit or events", async () => {
    await run(req({ parts: [{ provenance: "untrusted", source: "slack", content: SECRET }] }));
    expect(provider.requests[0]?.prompt).toContain(SECRET);
    const dump = JSON.stringify([
      runs(),
      db.select().from(schema.auditEvents).all(),
      db.select().from(schema.domainEvents).all(),
    ]);
    expect(dump).not.toContain(SECRET);
  });

  test("quota gate by level and priority", async () => {
    snap(0.9, "allowed", "2026-11-05T14:00:00.000Z");
    const e = await fails(run(req({ priorityClass: "batch" })));
    expect(e.classified.kind).toBe("quota_exhausted");
    expect(e.classified.retryAfter).toBe("2026-11-05T14:00:00.000Z");
    await run(req({ priorityClass: "collection" }));
    expect(provider.requests).toHaveLength(1);
  });

  test("rejected snapshot blocks urgent", async () => {
    snap(0.5, "rejected");
    const e = await fails(run(req({ priorityClass: "urgent" })));
    expect(e.classified.kind).toBe("quota_exhausted");
    expect(provider.requests).toHaveLength(0);
  });

  test("seven-day rejection with higher five-hour utilization stops until seven-day reset", async () => {
    snap2({ five: 0.5, seven: 0.1, fiveStatus: "allowed", sevenStatus: "rejected" });
    const e = await fails(run(req({ priorityClass: "urgent" })));
    expect(e.classified.retryAfter).toBe("2026-11-10T00:00:00.000Z");
  });

  test("five-hour rejection with zero utilization stops only until five-hour reset", async () => {
    snap2({ five: 0, seven: 0.06, fiveStatus: "rejected", sevenStatus: "allowed" });
    const e = await fails(run(req({ priorityClass: "urgent" })));
    expect(e.classified.retryAfter).toBe("2026-11-05T15:00:00.000Z");
  });

  test("previous level uses per-window statuses", async () => {
    snap2({ five: 0, seven: 0.06, fiveStatus: "rejected", sevenStatus: "allowed" });
    clock.advance(4 * 3_600_000); // five-hour window reset: gate open again
    provider.next = () => result({ quota: quota(0.9, "2026-11-05T20:00:00.000Z") });
    await run(req({ priorityClass: "collection" }));
    const ev = events("quota.threshold_reached");
    expect(ev).toHaveLength(1);
    const stored = db.select().from(schema.quotaSnapshots).all();
    expect(stored.at(-1)?.fiveHourStatus).toBe("allowed");
    expect(stored.at(-1)?.sevenDayStatus).toBe("allowed");
  });

  test("null resetsAt expires one hour after observation", async () => {
    db.insert(schema.quotaSnapshots)
      .values({
        id: "q",
        observedAt: START,
        fiveHourUtilization: 0,
        fiveHourResetsAt: null,
        sevenDayUtilization: 0,
        sevenDayResetsAt: null,
        status: "rejected",
        fiveHourStatus: "rejected",
        sevenDayStatus: "allowed",
      })
      .run();
    clock.advance(2 * 3_600_000);
    await run(req({ priorityClass: "urgent" }));
    expect(provider.requests).toHaveLength(1);
  });

  test("invalid connector names are skipped", async () => {
    provider.next = () =>
      result({
        connectors: [
          { name: "", status: "connected" },
          { name: "  ", status: "connected" },
          { name: "..", status: "connected" },
        ],
      });
    const before = settings.get("orchestrator.knownServers");
    await run(req());
    expect(settings.get("orchestrator.knownServers")).toEqual(before);
    provider.next = () => result();
    await run(req());
    expect(runs().every((r) => r.status === "succeeded")).toBe(true);
  });

  test("threshold event fires once on rising level", async () => {
    snap(0.5);
    provider.next = () => result({ quota: quota(0.9) });
    await run(req());
    const ev = events("quota.threshold_reached");
    expect(ev).toHaveLength(1);
    expect((ev[0]?.payload as { level: string } | undefined)?.level).toBe("hard");
    await run(req());
    expect(events("quota.threshold_reached")).toHaveLength(1);
  });

  test("maxConcurrent 1 serialises provider calls", async () => {
    settings.set("orchestrator.maxConcurrent", 1);
    provider.next = async () => {
      await new Promise((r) => setTimeout(r, 10));
      return result();
    };
    await Promise.all([run(req()), run(req()), run(req())]);
    expect(provider.peak).toBe(1);
    expect(runs()).toHaveLength(3);
  });

  test("a throwing provider maps to provider_error and releases the semaphore", async () => {
    settings.set("orchestrator.maxConcurrent", 1);
    provider.next = () => {
      throw new Error(`boom ${SECRET}`);
    };
    const e = await fails(run(req()));
    expect(e.classified.kind).toBe("provider_error");
    expect(runs()[0]?.status).toBe("failed");
    expect(JSON.stringify(runs())).not.toContain(SECRET);
    provider.next = () => result();
    await run(req());
    expect(runs()).toHaveLength(2);
    expect(events("claude.job_failed")).toHaveLength(1);
  });

  test("timed_out and auth_failed", async () => {
    provider.next = () =>
      result({ status: "timed_out", error: { kind: "timeout", message: "timed out" } });
    expect((await fails(run(req()))).classified.kind).toBe("timeout");
    expect(runs()[0]?.status).toBe("timed_out");
    provider.next = () =>
      result({ status: "failed", error: { kind: "auth_failed", message: "login needed" } });
    expect((await fails(run(req()))).classified.kind).toBe("auth_failed");
  });

  test("failure messages from non-generic kinds never echo content", async () => {
    provider.next = () =>
      result({ status: "failed", error: { kind: "parse_failed", message: SECRET } });
    const e = await fails(run(req()));
    expect(e.message).not.toContain(SECRET);
    expect(JSON.stringify(runs())).not.toContain(SECRET);
  });

  test("learns connectors", async () => {
    provider.next = () =>
      result({
        connectors: [
          { name: "claude.ai Notion", status: "connected" },
          { name: "claude.ai Atlassian MCP", status: "connected" },
          { name: "plugin:postman:postman", status: "connected" },
        ],
      });
    await run(req());
    const known = settings.get("orchestrator.knownServers");
    expect(known).toContain("mcp__claude_ai_Notion");
    expect(known).toContain("mcp__claude_ai_Atlassian_MCP");
    expect(known).toContain("mcp__plugin_postman_postman");
    const before = known.length;
    await run(req());
    expect(settings.get("orchestrator.knownServers")).toHaveLength(before);
  });

  test("request shape", async () => {
    await run(req({ parts: [{ provenance: "untrusted", source: "slack", content: "hello" }] }));
    const r = provider.requests[0];
    expect(r?.allowedTools).toEqual([SEARCH, "ToolSearch"]);
    expect(r?.disallowedTools).toContain("Bash");
    expect(r?.disallowedTools).toContain("mcp__claude_ai_Slack__slack_send_message");
    expect(r?.prompt).toContain("<<<UNTRUSTED 0123456789abcdef");
    expect(r?.model).toBe("haiku");
    expect(r?.timeoutMs).toBe(180_000);
    expect(r?.workingDirectory).toBe("/scratch");
    expect(r?.systemPrompt).toContain("read-only data collection worker");
  });

  test("invalid request is invalid_input", async () => {
    const e = await fails(run(req({ maxTurns: 0 })));
    expect(e.classified.kind).toBe("invalid_input");
  });

  test("J2: sendGuard passes through to the provider; absent stays absent", async () => {
    const guard = {
      toolName: "mcp__claude_ai_Slack__slack_send_message",
      expectedInputSha256: "b".repeat(64),
    };
    await run(
      req({
        priorityClass: "send",
        allowedTools: ["mcp__claude_ai_Slack__slack_send_message"],
        parts: [{ provenance: "policy_approved", content: "{}" }],
        sendGuard: guard,
      }),
    );
    expect(provider.requests[0]?.sendGuard).toEqual(guard);
    expect(provider.requests[0]?.promptParts[0]?.provenance).toBe("policy_approved");
    await run(req());
    expect("sendGuard" in (provider.requests[1] ?? {})).toBe(false);
  });

  test("J2: a send run without a guard is rejected before the provider", async () => {
    const e = await fails(
      run(
        req({
          priorityClass: "send",
          allowedTools: ["mcp__claude_ai_Slack__slack_send_message"],
          parts: [{ provenance: "user_approved", content: "{}" }],
        }),
      ),
    );
    expect(e.classified.kind).toBe("invalid_input");
    expect(e.classified.message).toBe("send run without a matching send guard");
    expect(provider.requests).toHaveLength(0);
  });

  test("J2: a malformed sendGuard is invalid_input and never reaches the provider", async () => {
    const e = await fails(
      run(
        req({
          sendGuard: {
            toolName: "mcp__claude_ai_Slack__slack_send_message",
            expectedInputSha256: "x; rm -rf ~",
          },
        }),
      ),
    );
    expect(e.classified.kind).toBe("invalid_input");
    expect(provider.requests).toHaveLength(0);
  });
});

const SEND = "mcp__claude_ai_Slack__slack_send_message";
const sendReq = () =>
  req({
    priorityClass: "send",
    allowedTools: [SEND],
    parts: [{ provenance: "user_approved", content: "reply text" }],
    sendGuard: { toolName: SEND, expectedInputSha256: "e".repeat(64) },
  });
const deferred = () => {
  let release: () => void = () => {};
  const p = new Promise<void>((r) => {
    release = r;
  });
  return { p, release };
};
const tick = () => new Promise((r) => setTimeout(r, 5));

describe("final-review fixes", () => {
  test("I1b: provider quota_exhausted with a 1970 or missing retryAfter is clamped to now + 15 min", async () => {
    provider.next = () =>
      result({
        status: "failed",
        error: {
          kind: "quota_exhausted",
          message: "Claude usage quota exhausted",
          retryAfter: "1970-01-01T00:00:00.000Z",
        },
      });
    expect((await fails(run(req()))).classified.retryAfter).toBe("2026-11-05T12:15:00.000Z");
    provider.next = () =>
      result({ status: "failed", error: { kind: "quota_exhausted", message: "q" } });
    expect((await fails(run(req()))).classified.retryAfter).toBe("2026-11-05T12:15:00.000Z");
  });

  test("I1: a rejected snapshot with no resetsAt blocks for an hour, retryAfter >= now + 15 min", async () => {
    snap2({ five: 0, seven: null, fiveStatus: "rejected", sevenStatus: null });
    db.update(schema.quotaSnapshots).set({ fiveHourResetsAt: null, sevenDayResetsAt: null }).run();
    clock.advance(50 * 60_000);
    const e = await fails(run(req({ priorityClass: "urgent" })));
    expect(e.classified.kind).toBe("quota_exhausted");
    expect(e.classified.retryAfter).toBe("2026-11-05T13:05:00.000Z");
    expect(provider.requests).toHaveLength(0);
  });

  test("I1: a five-hour-only snapshot is stored and read back without a seven-day window", async () => {
    provider.next = () =>
      result({
        quota: {
          observedAt: START,
          fiveHour: { utilization: 0.97, status: "allowed", resetsAt: "2026-11-05T15:00:00.000Z" },
        },
      });
    await run(req());
    const s = orch.latestSnapshot();
    expect(s?.fiveHour?.utilization).toBe(0.97);
    expect(s?.sevenDay).toBeUndefined();
    expect(events("quota.threshold_reached")).toHaveLength(1);
    expect((await fails(run(req({ priorityClass: "urgent" })))).classified.kind).toBe(
      "quota_exhausted",
    );
  });

  test("I3a: a run-row update failure after a successful run still returns success; row not running", async () => {
    sqlite.run(
      "CREATE TRIGGER fail_full_update BEFORE UPDATE ON claude_runs WHEN NEW.num_turns IS NOT NULL BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const r = await run(req());
      expect(r.status).toBe("succeeded");
      expect(runs()[0]?.status).toBe("succeeded");
      expect(runs()[0]?.finishedAt).not.toBeNull();
      expect(spy.mock.calls.length).toBeGreaterThan(0);
      for (const call of spy.mock.calls) expect(call).toHaveLength(3);
    } finally {
      spy.mockRestore();
    }
  });

  test("I3a: bookkeeping failures never change the outcome or the thrown error", async () => {
    sqlite.run(
      "CREATE TRIGGER fail_quota BEFORE INSERT ON quota_snapshots BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    sqlite.run(
      "CREATE TRIGGER fail_events BEFORE INSERT ON domain_events WHEN NEW.type <> 'claude.job_started' BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    const auth = spyOn(AuthMonitor.prototype, "record").mockImplementation(() => {
      throw new Error("auth boom");
    });
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      provider.next = () => result({ quota: quota(0.3) });
      expect((await run(req())).status).toBe("succeeded");
      provider.next = () =>
        result({ status: "failed", error: { kind: "auth_failed", message: "login" } });
      expect((await fails(run(req()))).classified.kind).toBe("auth_failed");
      expect(runs().map((r) => r.status)).toEqual(["succeeded", "failed"]);
    } finally {
      auth.mockRestore();
      spy.mockRestore();
    }
  });

  test("I3b: a send-run failure after spawn carries uncertain", async () => {
    provider.next = () =>
      result({ status: "failed", error: { kind: "provider_error", message: "crash" } });
    const e = await fails(run(sendReq()));
    expect(e.classified.kind).toBe("provider_error");
    expect(e.classified.details).toEqual({ uncertain: true });
    provider.next = () => result({ status: "timed_out", error: { kind: "timeout", message: "t" } });
    expect((await fails(run(sendReq()))).classified.details).toEqual({ uncertain: true });
    provider.next = () => {
      throw new Error("provider threw");
    };
    expect((await fails(run(sendReq()))).classified.details).toEqual({ uncertain: true });
  });

  test("I3b: no uncertain when the process never spawned or no write tool is allowed", async () => {
    provider.next = () =>
      result({
        status: "failed",
        error: { kind: "provider_error", message: "x", details: { notSpawned: true } },
      });
    expect((await fails(run(sendReq()))).classified.details).toBeUndefined();
    provider.next = () =>
      result({
        status: "cancelled",
        error: { kind: "timeout", message: "x", details: { notSpawned: true } },
      });
    expect((await fails(run(sendReq()))).classified.details).toBeUndefined();
    provider.next = () =>
      result({ status: "failed", error: { kind: "provider_error", message: "crash" } });
    expect((await fails(run(req()))).classified.details).toBeUndefined();
  });

  test("R16: a max_turns failure keeps details.maxTurns and the row keeps the denials", async () => {
    provider.next = () =>
      result({
        status: "failed",
        permissionDenials: ["Bash"],
        error: {
          kind: "provider_error",
          message: "claude reached max turns",
          details: { maxTurns: true, stderrBytes: 12 },
        },
      });
    const e = await fails(run(req()));
    expect(e.classified).toEqual({
      kind: "provider_error",
      message: "claude reached max turns",
      details: { maxTurns: true },
    });
    const row = runs().at(-1);
    expect(row?.permissionDenials).toEqual(["Bash"]);
    expect(row?.error).toEqual({ kind: "provider_error", message: "claude reached max turns" });
    // Send runs keep both markers.
    provider.next = () =>
      result({
        status: "failed",
        error: { kind: "provider_error", message: "m", details: { maxTurns: true } },
      });
    expect((await fails(run(sendReq()))).classified.details).toEqual({
      maxTurns: true,
      uncertain: true,
    });
  });

  test("ADR-040: a sandbox-unavailable failure keeps details.sandboxUnavailable", async () => {
    provider.next = () =>
      result({
        status: "failed",
        error: {
          kind: "provider_error",
          message: "sandbox unavailable",
          details: { sandboxUnavailable: true, stderrBytes: 40 },
        },
      });
    const e = await fails(run(req()));
    expect(e.classified).toEqual({
      kind: "provider_error",
      message: "sandbox unavailable",
      details: { sandboxUnavailable: true },
    });
    expect(e.classified.details?.sandboxUnavailable).toBe(true);
    // Only a boolean true survives, and only for the same kind.
    provider.next = () =>
      result({
        status: "failed",
        error: { kind: "provider_error", message: "m", details: { sandboxUnavailable: "yes" } },
      });
    expect((await fails(run(req()))).classified.details).toBeUndefined();
    provider.next = () =>
      result({
        status: "timed_out",
        error: { kind: "provider_error", message: "m", details: { sandboxUnavailable: true } },
      });
    expect((await fails(run(req()))).classified.details).toBeUndefined();
  });

  test("I6: an aborted waiter frees its queue spot and writes no run row", async () => {
    settings.set("orchestrator.maxConcurrent", 1);
    const gate = deferred();
    provider.next = async () => {
      await gate.p;
      return result();
    };
    const first = run(req());
    await tick();
    const ac = new AbortController();
    const waiting = fails(run(req(), ac.signal));
    const third = run(req());
    await tick();
    ac.abort();
    const e = await waiting;
    expect(e.classified).toEqual({
      kind: "timeout",
      message: "cancelled while waiting for a Claude slot",
    });
    expect(runs()).toHaveLength(1);
    gate.release();
    await first;
    await third;
    expect(runs()).toHaveLength(2);
    expect(provider.requests).toHaveLength(2);
    // An already-aborted signal never takes a slot either.
    const pre = new AbortController();
    pre.abort();
    expect((await fails(run(req(), pre.signal))).classified.kind).toBe("timeout");
    expect(runs()).toHaveLength(2);
  });

  test("I6: quota rising to hard while a batch request waits blocks it after acquire", async () => {
    settings.set("orchestrator.maxConcurrent", 1);
    const gate = deferred();
    provider.next = async () => {
      await gate.p;
      return result({ quota: quota(0.9) });
    };
    const first = run(req({ priorityClass: "collection" }));
    await tick();
    const batch = fails(run(req({ priorityClass: "batch" })));
    await tick();
    gate.release();
    await first;
    const e = await batch;
    expect(e.classified.kind).toBe("quota_exhausted");
    expect(provider.requests).toHaveLength(1);
    expect(runs()).toHaveLength(1);
    // The slot was released.
    provider.next = () => result();
    await run(req({ priorityClass: "collection" }));
    expect(provider.requests).toHaveLength(2);
  });

  test("the provider receives the caller's signal", async () => {
    let got: AbortSignal | undefined;
    provider.next = () => result();
    const exec = provider.execute.bind(provider);
    provider.execute = (r, signal) => {
      got = signal;
      return exec(r, signal);
    };
    const ac = new AbortController();
    await run(req(), ac.signal);
    expect(got).toBe(ac.signal);
  });
});

describe("runStructured", () => {
  const schemaT = z.object({ n: z.number() });
  test("parses a fenced block", async () => {
    provider.next = () => result({ finalText: 'ok\n```json\n{"n":7}\n```' });
    const r = await orch.runStructured(req(), schemaT, S());
    expect(r.value).toEqual({ n: 7 });
  });
  test("schema mismatch is incomplete_ai_output", async () => {
    provider.next = () => result({ finalText: '{"n":"x"}' });
    const e = await fails(orch.runStructured(req(), schemaT, S()));
    expect(e.classified.kind).toBe("incomplete_ai_output");
  });
});

describe("auth pause (ADR-037 §4)", () => {
  const authFailed = () =>
    result({ status: "failed", error: { kind: "auth_failed", message: "login needed" } });
  const notes = () => db.select().from(schema.notifications).all();

  test("auth_failed sets the pause, notifies once, and the next run defers without a provider call", async () => {
    provider.next = authFailed;
    expect((await fails(run(req()))).classified.kind).toBe("auth_failed");
    expect(settings.get("auth.pausedAt")).toBe(START);
    expect(settings.get("auth.pausedRefreshExpiresAt")).toBe(
      new Date(1_900_000_000_000).toISOString(),
    );
    expect(notes()).toHaveLength(1);
    expect(notes()[0]).toMatchObject({ kind: "claude.auth_paused", severity: "high" });
    const calls = provider.requests.length;
    const e = await fails(run(req()));
    expect(e.classified.kind).toBe("auth_paused");
    expect(e.classified.retryAfter).toBe("2026-11-05T12:15:00.000Z");
    expect(provider.requests.length).toBe(calls);
    expect(notes()).toHaveLength(1);
  });

  test("after 30 min one probe goes through; success clears the pause", async () => {
    provider.next = authFailed;
    await fails(run(req()));
    provider.next = () => result();
    clock.advance(29 * 60_000);
    expect((await fails(run(req()))).classified.kind).toBe("auth_paused");
    clock.advance(60_000);
    await run(req());
    expect(settings.get("auth.pausedAt")).toBeNull();
    expect(settings.get("auth.pausedRefreshExpiresAt")).toBeNull();
    await run(req());
  });

  test("a changed refresh expiry lets a probe through immediately", async () => {
    provider.next = authFailed;
    await fails(run(req()));
    provider.next = () => result();
    expect((await fails(run(req()))).classified.kind).toBe("auth_paused");
    writeCreds(1_950_000_000_000);
    await run(req());
    expect(settings.get("auth.pausedAt")).toBeNull();
  });

  test("only one concurrent run probes", async () => {
    provider.next = authFailed;
    await fails(run(req()));
    writeCreds(1_950_000_000_000);
    let release!: () => void;
    provider.next = () => new Promise((r) => (release = () => r(result())));
    const first = run(req());
    const second = await fails(run(req()));
    expect(second.classified.kind).toBe("auth_paused");
    await Promise.resolve();
    release();
    await first;
  });

  test("a failed probe throws auth_paused (not auth_failed), keeps the pause and restarts the timer", async () => {
    provider.next = authFailed;
    await fails(run(req()));
    clock.advance(31 * 60_000);
    const e = await fails(run(req()));
    expect(e.classified.kind).toBe("auth_paused");
    expect(e.classified.retryAfter).toBe("2026-11-05T12:46:00.000Z");
    expect(settings.get("auth.pausedAt")).toBe("2026-11-05T12:31:00.000Z");
    expect(notes()).toHaveLength(1);
    expect((await fails(run(req()))).classified.kind).toBe("auth_paused");
  });

  test("R4: a send run whose auth failure is replaced by auth_paused stays uncertain", async () => {
    provider.next = () => {
      // the pause is set by another run while this send run is in flight
      settings.set("auth.pausedAt", START, { emit: false });
      return authFailed();
    };
    const e = await fails(
      run(
        req({
          priorityClass: "send",
          allowedTools: ["mcp__claude_ai_Slack__slack_send_message"],
          parts: [{ provenance: "user_approved", content: "reply text" }],
          sendGuard: {
            toolName: "mcp__claude_ai_Slack__slack_send_message",
            expectedInputSha256: "e".repeat(64),
          },
        }),
      ),
    );
    expect(e.classified.kind).toBe("auth_paused");
    expect(e.classified.details).toEqual({ uncertain: true });
    // a read-only run gets no details
    provider.next = authFailed;
    clock.advance(31 * 60_000);
    expect((await fails(run(req()))).classified.details).toBeUndefined();
  });
});

describe("recoverOrphanRuns", () => {
  test("marks running rows failed and leaves other rows untouched", () => {
    const row = (id: string, status: string) =>
      db
        .insert(schema.claudeRuns)
        .values({ id, workerProfile: "collector", model: "haiku", status, startedAt: START })
        .run();
    row("r1", "running");
    row("r2", "succeeded");
    expect(recoverOrphanRuns(db, clock)).toBe(1);
    const byId = Object.fromEntries(runs().map((r) => [r.id, r]));
    expect(byId.r1?.status).toBe("failed");
    expect(byId.r1?.error).toEqual({ kind: "unknown", message: "interrupted by restart" });
    expect(byId.r1?.finishedAt).toBe(START);
    expect(byId.r2?.status).toBe("succeeded");
    expect(byId.r2?.error).toBeNull();
  });
});

describe("beforeSpawn (Phase 6b I2)", () => {
  test("false: the provider is never called and the error is not-spawned cancelled_before_spawn", async () => {
    let calls = 0;
    const e = await fails(
      orch.run(req(), S(), {
        beforeSpawn: () => {
          calls++;
          return false;
        },
      }),
    );
    expect(calls).toBe(1);
    expect(e.classified.kind).toBe("cancelled_before_spawn");
    expect(e.classified.details?.notSpawned).toBe(true);
    expect(e.classified.details?.uncertain).toBeUndefined();
    expect(provider.requests).toHaveLength(0);
    expect(runs()).toHaveLength(0);
    // The slot was released.
    settings.set("orchestrator.maxConcurrent", 1);
    await run(req());
    expect(provider.requests).toHaveLength(1);
  });

  test("a throwing callback cancels the same way", async () => {
    const e = await fails(
      orch.run(req(), S(), {
        beforeSpawn: () => {
          throw new Error("boom");
        },
      }),
    );
    expect(e.classified.kind).toBe("cancelled_before_spawn");
    expect(provider.requests).toHaveLength(0);
  });

  test("true: the run proceeds", async () => {
    await orch.run(req(), S(), { beforeSpawn: () => true });
    expect(provider.requests).toHaveLength(1);
    expect(runs()[0]?.status).toBe("succeeded");
  });

  test("it is called only after the slot is acquired", async () => {
    settings.set("orchestrator.maxConcurrent", 1);
    let release: (r: AIExecutionResult) => void = () => {};
    provider.next = () =>
      new Promise<AIExecutionResult>((r) => {
        release = r;
      });
    const first = run(req());
    await new Promise((r) => setTimeout(r, 0));
    let calls = 0;
    const second = orch.run(req(), S(), {
      beforeSpawn: () => {
        calls++;
        return true;
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(0);
    provider.next = () => result();
    release(result());
    await first;
    await second;
    expect(calls).toBe(1);
  });

  test("it is not called when the quota re-check after the slot fails", async () => {
    settings.set("orchestrator.maxConcurrent", 1);
    let release: (r: AIExecutionResult) => void = () => {};
    provider.next = () =>
      new Promise<AIExecutionResult>((r) => {
        release = r;
      });
    const first = run(req());
    await new Promise((r) => setTimeout(r, 0));
    let calls = 0;
    const second = fails(
      orch.run(req({ priorityClass: "batch" }), S(), {
        beforeSpawn: () => {
          calls++;
          return true;
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    snap(0.9, "allowed", "2026-11-05T14:00:00.000Z");
    release(result());
    await first;
    expect((await second).classified.kind).toBe("quota_exhausted");
    expect(calls).toBe(0);
  });
});

describe("sandbox (ADR-040, rule M)", () => {
  const WD = "/home/u/projects/demo";
  const SANDBOX = {
    tmpDir: "/home/u/.local/share/synapse/scratch/runs/j1/tmp",
    denyRead: ["/home/u/.ssh", "/home/u/.local/share/synapse"],
  };
  const develop = (over: Partial<ClaudeJobRequest> = {}) =>
    req({
      workerProfile: "engineering",
      priorityClass: "engineering",
      allowedTools: [`Read(/${WD}/**)`, `Edit(/${WD}/**)`, "Bash(bun test:*)"],
      parts: [{ provenance: "user_approved", content: "Fix add" }],
      workingDirectory: WD,
      ...over,
    });

  test("a request's sandbox reaches the provider unchanged; absent stays absent", async () => {
    await run(develop({ sandbox: SANDBOX }));
    expect(provider.requests[0]?.sandbox).toEqual(SANDBOX);
    await run(req());
    expect("sandbox" in (provider.requests[1] ?? {})).toBe(false);
  });

  test("engineering Bash without a sandbox is refused before the provider", async () => {
    const e = await fails(run(develop()));
    expect(e.classified.kind).toBe("invalid_input");
    expect(e.classified.message).toBe(SANDBOX_REQUIRED_REASON);
    expect(provider.requests).toHaveLength(0);
    const audit = db.select().from(schema.auditEvents).all();
    expect(audit.map((a) => [a.action, a.details])).toEqual([
      ["claude.request_rejected", { reason: SANDBOX_REQUIRED_REASON }],
    ]);
  });
});

describe("user settings that widen engineering scope (Phase 9 guard)", () => {
  const engineering = () =>
    req({
      workerProfile: "engineering",
      priorityClass: "batch",
      allowedTools: ["Read(//tmp/demo-repo/**)"],
      workingDirectory: "/tmp/demo-repo",
    });

  test("an engineering run is refused before spawn; the provider is never called", async () => {
    (provider as { userPermissionsWidenScope?: boolean }).userPermissionsWidenScope = true;
    const e = await fails(run(engineering()));
    expect(e.classified.kind).toBe("needs_attention");
    expect(e.message).toBe(
      "Claude Code user settings widen file or shell permissions; engineering and code-answer runs are refused until they are removed and the API is restarted",
    );
    expect(e.classified.details).toEqual({ notSpawned: true });
    expect(provider.requests).toHaveLength(0);
    expect(runs()).toHaveLength(0);
    const audit = db.select().from(schema.auditEvents).all();
    expect(audit.map((a) => [a.action, a.details])).toEqual([
      ["claude.request_rejected", { reason: "unsafe_user_settings" }],
    ]);
  });

  test("collector and intelligence runs are unaffected", async () => {
    (provider as { userPermissionsWidenScope?: boolean }).userPermissionsWidenScope = true;
    await run(req());
    await run(
      req({ workerProfile: "intelligence", priorityClass: "batch", allowedTools: ["ToolSearch"] }),
    );
    expect(provider.requests).toHaveLength(2);
  });

  test("clean settings let the engineering run through", async () => {
    (provider as { userPermissionsWidenScope?: boolean }).userPermissionsWidenScope = false;
    await run(engineering());
    expect(provider.requests).toHaveLength(1);
  });
});

describe("reader profile (C1)", () => {
  const WD = "/tmp/demo-repo";
  const reader = () =>
    req({
      workerProfile: "reader",
      priorityClass: "urgent",
      instructions: "answer",
      parts: [{ provenance: "untrusted", source: "slack", content: "where is the config?" }],
      allowedTools: [`Read(/${WD}/**)`, `Grep(/${WD}/**)`, `Glob(/${WD}/**)`],
      workingDirectory: WD,
    });

  test("a valid reader request runs with the reader defaults and a hermetic argv", async () => {
    await run(reader());
    expect(provider.requests).toHaveLength(1);
    const r = provider.requests[0] as AIExecutionRequest;
    expect(r.workerProfile).toBe("reader");
    expect(r.systemPrompt).toBe(
      "You answer one question about one local repository by reading its files. You cannot change anything.",
    );
    expect(DEFAULT_SYSTEM_PROMPTS.reader).toBe(r.systemPrompt);
    expect(r.model).toBe("sonnet");
    expect(r.timeoutMs).toBe(300_000);
    expect(r.workingDirectory).toBe(WD);
    expect(r.allowedTools).toEqual([`Read(/${WD}/**)`, `Grep(/${WD}/**)`, `Glob(/${WD}/**)`]);
    for (const t of [
      "Bash",
      "Edit",
      "Write",
      "MultiEdit",
      "NotebookEdit",
      "WebFetch",
      "Agent",
      "ToolSearch",
    ]) {
      expect(r.disallowedTools).toContain(t);
    }
    expect(r.disallowedTools).toContain("mcp__claude_ai_Slack");
    const argv = buildClaudeArgs(r, "{}");
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("default");
    expect(argv).toContain("--no-session-persistence");
  });

  test("a reader request with a forbidden tool is rejected before spawn", async () => {
    const e = await fails(run({ ...reader(), allowedTools: [`Read(/${WD}/**)`, "Bash"] }));
    expect(e.classified.kind).toBe("invalid_input");
    expect(e.message).toBe("profile reader may not use Bash");
    expect(provider.requests).toHaveLength(0);
  });

  test("a reader request with a connector is rejected; ToolSearch is not added for it", async () => {
    const e = await fails(run({ ...reader(), allowedTools: [`Read(/${WD}/**)`, SEARCH] }));
    expect(e.message).toBe(`profile reader may not use connector tool ${SEARCH}`);
    expect(provider.requests).toHaveLength(0);
    const audit = db.select().from(schema.auditEvents).all();
    expect(audit.map((a) => a.details)).toEqual([
      { reason: `profile reader may not use connector tool ${SEARCH}` },
    ]);
  });

  test("other profiles still get ToolSearch added for a connector", async () => {
    await run(req());
    expect(provider.requests[0]?.allowedTools).toEqual([SEARCH, "ToolSearch"]);
    expect(provider.requests[0]?.disallowedTools).not.toContain("ToolSearch");
  });

  test("a user-level allow for an unknown connector server refuses a reader run", async () => {
    const p = provider as { userAllowedConnectorServers?: readonly string[] };
    p.userAllowedConnectorServers = ["mcp__claude_ai_Slack", "mcp__demo_unknown"];
    const e = await fails(run(reader()));
    expect(e.classified.kind).toBe("needs_attention");
    expect(e.message).toBe(UNSAFE_USER_SETTINGS_MESSAGE);
    expect(e.classified.details).toEqual({ notSpawned: true });
    expect(provider.requests).toHaveLength(0);
    expect(runs()).toHaveLength(0);
    const audit = db.select().from(schema.auditEvents).all();
    expect(audit.map((a) => [a.action, a.workerProfile, a.details])).toEqual([
      ["claude.request_rejected", "reader", { reason: "unsafe_user_settings" }],
    ]);
  });

  test("a user-level allow for a known server lets a reader run, with that server denied", async () => {
    const p = provider as { userAllowedConnectorServers?: readonly string[] };
    p.userAllowedConnectorServers = ["mcp__claude_ai_Slack"];
    await run(reader());
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.disallowedTools).toContain("mcp__claude_ai_Slack");
  });

  test("an unknown user-allowed connector server does not affect other profiles", async () => {
    const p = provider as { userAllowedConnectorServers?: readonly string[] };
    p.userAllowedConnectorServers = ["mcp__demo_unknown"];
    await run(req());
    await run(
      req({ workerProfile: "intelligence", priorityClass: "batch", allowedTools: ["ToolSearch"] }),
    );
    await run(
      req({
        workerProfile: "engineering",
        priorityClass: "batch",
        allowedTools: [`Read(/${WD}/**)`],
        workingDirectory: WD,
      }),
    );
    expect(provider.requests).toHaveLength(3);
  });

  test("user settings that widen scope refuse a reader run before spawn", async () => {
    (provider as { userPermissionsWidenScope?: boolean }).userPermissionsWidenScope = true;
    const e = await fails(run(reader()));
    expect(e.classified.kind).toBe("needs_attention");
    expect(e.message).toBe(UNSAFE_USER_SETTINGS_MESSAGE);
    expect(e.classified.details).toEqual({ notSpawned: true });
    expect(provider.requests).toHaveLength(0);
    expect(runs()).toHaveLength(0);
    const audit = db.select().from(schema.auditEvents).all();
    expect(audit.map((a) => [a.action, a.workerProfile, a.details])).toEqual([
      ["claude.request_rejected", "reader", { reason: "unsafe_user_settings" }],
    ]);
  });
});

describe("user activity yield (ADR-036)", () => {
  const UNTIL = "2026-11-05T12:09:00.000Z";
  let sig: { active: boolean; until: string | null };
  let yielding: ClaudeOrchestrator;
  beforeEach(() => {
    sig = { active: true, until: UNTIL };
    const signal: UserActivitySignal = { isUserActive: () => sig };
    yielding = new ClaudeOrchestrator({
      db,
      clock,
      provider,
      settings,
      events: new EventPublisher(clock),
      audit: new AuditLogger(clock),
      auth: new AuthMonitor(db, clock, settings, new EventPublisher(clock), credsPath),
      notifications: new NotificationService(db, clock, new LiveBus()),
      scratchDir: "/scratch",
      random: () => "0123456789abcdef",
      userActivity: signal,
    });
  });

  test("a batch request is deferred without spawning or a run row", async () => {
    const e = await yielding.run(req({ priorityClass: "batch" }), S()).catch((x) => x);
    expect(e).toBeInstanceOf(JobError);
    expect(e.classified.kind).toBe("user_active");
    expect(e.classified.retryAfter).toBe(UNTIL);
    expect(e.classified.details).toEqual({ notSpawned: true });
    expect(provider.requests).toHaveLength(0);
    expect(runs()).toHaveLength(0);
  });

  test("a backfill request is deferred without spawning", async () => {
    const e = await yielding.run(req({ priorityClass: "backfill" }), S()).catch((x) => x);
    expect(e.classified.kind).toBe("user_active");
    expect(provider.requests).toHaveLength(0);
    expect(runs()).toHaveLength(0);
  });

  test("a throwing signal fails open and never-yield classes skip it", async () => {
    let calls = 0;
    const spy = spyOn(console, "error").mockImplementation(() => {});
    const throwing = new ClaudeOrchestrator({
      db,
      clock,
      provider,
      settings,
      events: new EventPublisher(clock),
      audit: new AuditLogger(clock),
      auth: new AuthMonitor(db, clock, settings, new EventPublisher(clock), credsPath),
      notifications: new NotificationService(db, clock, new LiveBus()),
      scratchDir: "/scratch",
      random: () => "0123456789abcdef",
      userActivity: {
        isUserActive: () => {
          calls++;
          throw new Error("db down SECRET-PATH");
        },
      },
    });
    await throwing.run(req({ priorityClass: "urgent" }), S());
    expect(calls).toBe(0);
    await throwing.run(req({ priorityClass: "batch" }), S());
    expect(calls).toBeGreaterThan(0);
    expect(provider.requests).toHaveLength(2);
    expect(JSON.stringify(spy.mock.calls)).not.toContain("SECRET-PATH");
    spy.mockRestore();
  });

  test("urgent, send and collection requests run", async () => {
    await yielding.run(req({ priorityClass: "urgent" }), S());
    await yielding.run(req({ priorityClass: "collection" }), S());
    expect(provider.requests).toHaveLength(2);
  });

  test("engineering runs unless yieldEngineering is set", async () => {
    const eng = req({
      workerProfile: "engineering",
      priorityClass: "engineering",
      allowedTools: ["Read(//tmp/demo-repo/**)"],
      workingDirectory: "/tmp/demo-repo",
    });
    await yielding.run(eng, S());
    expect(provider.requests).toHaveLength(1);
    settings.set("claudeActivity.yieldEngineering", true, { emit: false });
    const e = await yielding.run(eng, S()).catch((x) => x);
    expect(e.classified.kind).toBe("user_active");
    expect(provider.requests).toHaveLength(1);
  });

  test("an idle signal lets batch run (resume)", async () => {
    sig.active = false;
    await yielding.run(req({ priorityClass: "batch" }), S());
    expect(provider.requests).toHaveLength(1);
  });

  test("yieldWhenActive false disables the yield", async () => {
    settings.set("claudeActivity.yieldWhenActive", false, { emit: false });
    await yielding.run(req({ priorityClass: "batch" }), S());
    expect(provider.requests).toHaveLength(1);
  });

  test("no userActivity dependency: batch runs", async () => {
    await run(req({ priorityClass: "batch" }));
    expect(provider.requests).toHaveLength(1);
  });

  test("the signal turning active while waiting for a slot defers after acquiring and frees the slot", async () => {
    sig.active = false;
    settings.set("orchestrator.maxConcurrent", 1, { emit: false });
    let release: (r: AIExecutionResult) => void = () => {};
    provider.next = () => new Promise<AIExecutionResult>((r) => (release = r));
    const first = yielding.run(req({ priorityClass: "urgent" }), S());
    await new Promise((r) => setTimeout(r, 0));
    const second = yielding.run(req({ priorityClass: "batch" }), S());
    await new Promise((r) => setTimeout(r, 0));
    sig.active = true;
    release(result());
    await first;
    expect(((await second.catch((x) => x)) as JobError).classified.kind).toBe("user_active");
    expect(provider.requests).toHaveLength(1);
    expect(runs()).toHaveLength(1);
    provider.next = () => result();
    await yielding.run(req({ priorityClass: "urgent" }), S());
    expect(provider.requests).toHaveLength(2);
  });
});
