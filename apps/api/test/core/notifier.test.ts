import { afterEach, beforeEach, expect, test } from "bun:test";
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
afterEach(() => {});

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
      "Critical: message from A in a DM",
    ],
    timeout: 5000,
  });
  expect(seen[1]?.argv[2]).toBe("--urgency=normal");
  expect(seen[2]?.argv[2]).toBe("--urgency=low");
  expect(seen.every((s) => s.argv.length === 4)).toBe(true);
});

test("nonzero exit is a failure", async () => {
  const n = new NotifySendNotifier({ spawn: async () => 1, which: () => "/x" });
  await expect(n.notify({ title: "t", severity: "high" })).rejects.toThrow();
  expect(n.health().ok).toBe(false);
});
