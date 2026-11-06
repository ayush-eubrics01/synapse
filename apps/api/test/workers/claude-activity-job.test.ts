import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { openDatabase, runMigrations } from "@synapse/database";
import { FakeClock } from "@synapse/shared";
import { SettingsService } from "../../src/core/config/settings";
import type { HandlerRegistration } from "../../src/core/jobs/worker";
import type { SchedulerService } from "../../src/core/scheduler/scheduler";
import {
  CLAUDE_ACTIVITY_SCAN_JOB,
  registerClaudeActivityJobs,
} from "../../src/workers/claude-activity";

const SECRET = "/home/demo/Secret Title/demo-app";

function setup(scan: () => Promise<unknown>) {
  const { db } = openDatabase(":memory:");
  runMigrations(db);
  const settings = new SettingsService(db, new FakeClock("2026-11-06T09:00:00.000Z"), () => "");
  settings.set("claudeActivity.scanIntervalSeconds", 300);
  const handlers = new Map<string, HandlerRegistration>();
  const upserts: unknown[] = [];
  const scheduler = { upsert: (i: unknown) => upserts.push(i) } as unknown as SchedulerService;
  registerClaudeActivityJobs({ handlers, scheduler, settings, service: { scan } as never });
  return { handlers, upserts };
}

const spies: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
});

describe("claude_activity.scan job", () => {
  test("schedule uses the setting interval, coalesces; handler timeout is 60 s", () => {
    const { handlers, upserts } = setup(async () => ({}));
    expect(upserts).toEqual([
      {
        name: CLAUDE_ACTIVITY_SCAN_JOB,
        jobType: CLAUDE_ACTIVITY_SCAN_JOB,
        intervalSeconds: 300,
        coalesce: true,
      },
    ]);
    expect(handlers.get(CLAUDE_ACTIVITY_SCAN_JOB)?.timeoutMs).toBe(60_000);
  });

  test("a failing scan logs only the fixed line and throws the fixed error", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    spies.push(err);
    const { handlers } = setup(async () => {
      throw new TypeError(`cannot open ${SECRET}`);
    });
    const reg = handlers.get(CLAUDE_ACTIVITY_SCAN_JOB) as HandlerRegistration;
    let thrown: unknown;
    try {
      await reg.handler({} as never, {} as never);
    } catch (e) {
      thrown = e;
    }
    expect((thrown as Error).message).toBe("claude_activity scan failed");
    expect(err.mock.calls).toEqual([["claude-activity: scan failed TypeError"]]);
    expect(JSON.stringify([thrown, err.mock.calls])).not.toContain("Secret");
  });
});
