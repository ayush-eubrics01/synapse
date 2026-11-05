import { expect, test } from "bun:test";
import type { PriorityClass, QuotaSnapshot } from "@synapse/contracts";
import { openDatabase, runMigrations } from "@synapse/database";
import { FakeClock } from "@synapse/shared";
import { SettingsService } from "../../src/core/config/settings";
import {
  decideQuota,
  type QuotaLevel,
  type QuotaThresholds,
  quotaLevel,
  thresholdsFromSettings,
} from "../../src/core/orchestrator/quota-gate";

const T: QuotaThresholds = {
  fiveHour: { soft: 0.6, hard: 0.85, stop: 0.95 },
  sevenDay: { soft: 0.7, hard: 0.9 },
};
const now = new Date("2026-11-05T12:00:00.000Z");
const FUTURE = "2026-11-05T15:00:00.000Z";
const FUTURE7 = "2026-11-10T15:00:00.000Z";
const PAST = "2026-11-05T11:00:00.000Z";

function snap(
  five: number,
  seven: number,
  o: { fStatus?: string; sStatus?: string; fReset?: string; sReset?: string } = {},
): QuotaSnapshot {
  return {
    observedAt: now.toISOString(),
    fiveHour: { utilization: five, status: o.fStatus ?? "allowed", resetsAt: o.fReset ?? FUTURE },
    sevenDay: { utilization: seven, status: o.sStatus ?? "allowed", resetsAt: o.sReset ?? FUTURE7 },
  };
}

test("five-hour boundaries", () => {
  expect(quotaLevel(snap(0.59, 0), T, now).level).toBe("ok");
  expect(quotaLevel(snap(0.6, 0), T, now).level).toBe("soft");
  expect(quotaLevel(snap(0.85, 0), T, now).level).toBe("hard");
  expect(quotaLevel(snap(0.95, 0), T, now).level).toBe("stop");
  expect(quotaLevel(snap(0.6, 0), T, now)).toEqual({
    level: "soft",
    window: "five_hour",
    resetsAt: FUTURE,
  });
});

test("seven-day boundaries and worst window wins", () => {
  expect(quotaLevel(snap(0, 0.69), T, now).level).toBe("ok");
  expect(quotaLevel(snap(0, 0.7), T, now)).toEqual({
    level: "soft",
    window: "seven_day",
    resetsAt: FUTURE7,
  });
  expect(quotaLevel(snap(0, 0.9), T, now).level).toBe("hard");
  expect(quotaLevel(snap(0, 0.99), T, now).level).toBe("hard"); // no seven-day stop threshold
  expect(quotaLevel(snap(0.7, 0.9), T, now).window).toBe("seven_day");
  expect(quotaLevel(snap(0.96, 0.9), T, now)).toEqual({
    level: "stop",
    window: "five_hour",
    resetsAt: FUTURE,
  });
});

test("null snapshot is ok; stale windows are ignored", () => {
  expect(quotaLevel(null, T, now)).toEqual({ level: "ok", window: null, resetsAt: null });
  expect(quotaLevel(snap(0.99, 0.5, { fReset: PAST }), T, now).level).toBe("ok");
  expect(quotaLevel(snap(0.99, 0.5, { fReset: now.toISOString() }), T, now).level).toBe("ok");
  expect(quotaLevel(snap(0.99, 0.75, { fReset: PAST }), T, now)).toEqual({
    level: "soft",
    window: "seven_day",
    resetsAt: FUTURE7,
  });
  expect(quotaLevel(snap(0.1, 0.99, { sStatus: "rejected", sReset: PAST }), T, now).level).toBe(
    "ok",
  );
});

test("rejected means stop", () => {
  expect(quotaLevel(snap(0.1, 0.1, { fStatus: "rejected" }), T, now).level).toBe("stop");
  expect(quotaLevel(snap(0.1, 0.1, { sStatus: "rejected" }), T, now)).toEqual({
    level: "stop",
    window: "seven_day",
    resetsAt: FUTURE7,
  });
});

test("decideQuota table", () => {
  const classes: PriorityClass[] = [
    "urgent",
    "send",
    "collection",
    "engineering",
    "batch",
    "backfill",
  ];
  const allowed: Record<QuotaLevel, PriorityClass[]> = {
    ok: classes,
    soft: ["urgent", "send", "collection", "engineering"],
    hard: ["urgent", "send", "collection"],
    stop: [],
  };
  for (const level of Object.keys(allowed) as QuotaLevel[]) {
    for (const c of classes) {
      expect(decideQuota(level, c)).toBe(allowed[level].includes(c));
    }
  }
});

test("thresholdsFromSettings reads defaults and overrides", () => {
  const { db } = openDatabase(":memory:");
  runMigrations(db);
  const settings = new SettingsService(db, new FakeClock(now), () => "e");
  expect(thresholdsFromSettings(settings)).toEqual(T);
  settings.set("orchestrator.quota.fiveHour.soft", 0.5);
  expect(thresholdsFromSettings(settings).fiveHour.soft).toBe(0.5);
});
