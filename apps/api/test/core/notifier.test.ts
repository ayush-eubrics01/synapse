import { beforeEach, describe, expect, test } from "bun:test";
import type { DesktopNotifier } from "@synapse/contracts";
import { type Db, openDatabase, runMigrations, schema } from "@synapse/database";
import { FakeClock } from "@synapse/shared";
import { SettingsService } from "../../src/core/config/settings";
import { LiveBus } from "../../src/core/events/live-bus";
import { EventPublisher } from "../../src/core/events/publisher";
import { desktopNotifierCheck } from "../../src/core/health/checks";
import { NotificationService } from "../../src/core/notifications/notifications";
import { NotifySendNotifier } from "../../src/infrastructure/notifier";

let db: Db;
let settings: SettingsService;
let calls: { title: string; severity: string }[];
let svc: NotificationService;
const tick = () => new Promise((r) => setTimeout(r, 10));

beforeEach(() => {
  db = openDatabase(":memory:").db;
  runMigrations(db);
  const clock = new FakeClock("2026-11-05T12:00:00.000Z");
  const events = new EventPublisher(clock);
  settings = new SettingsService(db, clock, events.publish.bind(events));
  calls = [];
  const notifier: DesktopNotifier = {
    notify: async (n) => {
      calls.push(n);
    },
  };
  svc = new NotificationService(db, clock, new LiveBus(), { notifier, settings });
});

const note = (severity: "info" | "warning" | "high") =>
  svc.notify(db, { kind: "k", severity, title: `t-${severity}`, body: "SECRET BODY" });

test("severity gating: below notifications.desktop.minSeverity stays in-app only", async () => {
  note("info");
  note("warning");
  note("high");
  await tick();
  expect(calls).toEqual([
    { title: "t-warning", severity: "warning" },
    { title: "t-high", severity: "high" },
  ]);
  expect(db.select().from(schema.notifications).all()).toHaveLength(3);
});

test("minSeverity high only sends high; disabled sends nothing", async () => {
  settings.set("notifications.desktop.minSeverity", "high");
  note("warning");
  note("high");
  await tick();
  expect(calls.map((c) => c.severity)).toEqual(["high"]);
  settings.set("notifications.desktop.enabled", false);
  note("high");
  await tick();
  expect(calls).toHaveLength(1);
});

test("a rolled-back transaction sends no desktop notification", async () => {
  try {
    db.transaction((tx) => {
      svc.notify(tx, { kind: "k", severity: "high", title: "gone" });
      throw new Error("rollback");
    });
  } catch {}
  await tick();
  expect(calls).toHaveLength(0);
});

test("spawn failure: notify never throws, in-app row stays, health degraded", async () => {
  const clock = new FakeClock("2026-11-05T12:00:00.000Z");
  const failing = new NotifySendNotifier({
    spawn: async () => {
      throw new Error("spawn failed");
    },
    which: () => "/usr/bin/notify-send",
  });
  const s = new NotificationService(db, clock, new LiveBus(), { notifier: failing, settings });
  const err = console.error;
  console.error = () => {};
  try {
    expect(() => s.notify(db, { kind: "k", severity: "high", title: "x" })).not.toThrow();
    await tick();
  } finally {
    console.error = err;
  }
  expect(db.select().from(schema.notifications).all()).toHaveLength(1);
  const h = await desktopNotifierCheck(failing)();
  expect(h.status).toBe("degraded");
});

test("health: missing binary degraded, present ok", async () => {
  expect((await desktopNotifierCheck(new NotifySendNotifier({ which: () => null }))()).status).toBe(
    "degraded",
  );
  expect((await desktopNotifierCheck(new NotifySendNotifier({ which: () => "/x" }))()).status).toBe(
    "ok",
  );
});

test("exact argv: no shell, title only, urgency by severity, 5 s timeout", async () => {
  const seen: { argv: string[]; timeout: number }[] = [];
  const n = new NotifySendNotifier({
    spawn: async (argv, timeout) => {
      seen.push({ argv, timeout });
      return 0;
    },
    which: () => "/x",
  });
  await n.notify({ title: "Critical: message from A in a DM", severity: "high" });
  await n.notify({ title: "t", severity: "warning" });
  await n.notify({ title: "t", severity: "info" });
  expect(seen[0]).toEqual({
    argv: [
      "notify-send",
      "--app-name=Synapse",
      "--urgency=critical",
      "--",
      "Critical: message from A in a DM",
    ],
    timeout: 5000,
  });
  expect(seen[1]?.argv[2]).toBe("--urgency=normal");
  expect(seen[2]?.argv[2]).toBe("--urgency=low");
  expect(seen.every((s) => s.argv.length === 5)).toBe(true);
});

test("nonzero exit is a failure", async () => {
  const n = new NotifySendNotifier({ spawn: async () => 1, which: () => "/x" });
  await expect(n.notify({ title: "t", severity: "high" })).rejects.toThrow();
  expect(n.health().ok).toBe(false);
});

test("a title that looks like an option is passed after --, never parsed as a flag", async () => {
  const seen: string[][] = [];
  const n = new NotifySendNotifier({
    spawn: async (argv) => {
      seen.push(argv);
      return 0;
    },
    which: () => "/usr/bin/notify-send",
  });
  await n.notify({ title: "--hint=int:transient:1", severity: "high" });
  const argv = seen[0] ?? [];
  expect(argv.indexOf("--")).toBe(argv.length - 2);
  expect(argv.at(-1)).toBe("--hint=int:transient:1");
});

describe("desktop rate limit (R15)", () => {
  let clock: FakeClock;
  let timers: { fn: () => void; ms: number }[];
  let limited: NotificationService;

  beforeEach(() => {
    clock = new FakeClock("2026-11-05T12:00:00.000Z");
    timers = [];
    const notifier: DesktopNotifier = {
      notify: async (n) => {
        calls.push(n);
      },
    };
    limited = new NotificationService(db, clock, new LiveBus(), {
      notifier,
      settings,
      schedule: (fn, ms) => {
        timers.push({ fn, ms });
      },
    });
  });

  const burst = (n: number, severity: "warning" | "high" = "warning") => {
    for (let i = 0; i < n; i++) {
      limited.notify(db, { kind: "k", severity, title: `n${calls.length}-${i}` });
    }
  };

  test("12 rapid notifications: 5 popups, then 1 summary when the window frees", async () => {
    burst(11);
    limited.notify(db, { kind: "k", severity: "high", title: "the high one" });
    await tick();
    expect(calls).toHaveLength(5);
    expect(db.select().from(schema.notifications).all()).toHaveLength(12); // in-app rows all stay
    expect(timers).toHaveLength(1);
    expect(timers[0]?.ms).toBe(60_000);

    clock.advance(60_000);
    timers[0]?.fn();
    await tick();
    expect(calls).toHaveLength(6);
    expect(calls[5]).toEqual({ title: "Synapse: 7 more notifications", severity: "high" });
  });

  test("the window is rolling: a popup is allowed again once the oldest is 60 s old", async () => {
    burst(5);
    await tick();
    expect(calls).toHaveLength(5);
    clock.advance(59_999);
    burst(1);
    await tick();
    expect(calls).toHaveLength(5);
    clock.advance(1);
    timers.at(-1)?.fn();
    await tick();
    expect(calls).toHaveLength(6);
    expect(calls[5]?.title).toBe("Synapse: 1 more notification");
    // After the summary the suppressed count is reset; later traffic within capacity pops normally.
    clock.advance(60_000);
    burst(1);
    await tick();
    expect(calls).toHaveLength(7);
    expect(calls[6]?.title).not.toContain("more notifications");
  });

  test("the summary timer re-arms when the window is still full", async () => {
    burst(6);
    await tick();
    expect(timers).toHaveLength(1);
    clock.advance(30_000); // too early: the window is still full
    timers[0]?.fn();
    await tick();
    expect(calls).toHaveLength(5);
    expect(timers).toHaveLength(2);
    expect(timers[1]?.ms).toBe(30_000);
  });
});
