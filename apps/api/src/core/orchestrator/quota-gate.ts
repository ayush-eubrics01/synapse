import type { PriorityClass, QuotaSnapshot, QuotaWindow } from "@synapse/contracts";
import type { SettingsService } from "../config/settings";

export interface QuotaThresholds {
  fiveHour: { soft: number; hard: number; stop: number };
  sevenDay: { soft: number; hard: number };
}

export type QuotaLevel = "ok" | "soft" | "hard" | "stop";

export interface QuotaDecision {
  level: QuotaLevel;
  window: "five_hour" | "seven_day" | null;
  resetsAt: string | null;
}

const RANK: Record<QuotaLevel, number> = { ok: 0, soft: 1, hard: 2, stop: 3 };

export function thresholdsFromSettings(settings: SettingsService): QuotaThresholds {
  return {
    fiveHour: {
      soft: settings.get("orchestrator.quota.fiveHour.soft"),
      hard: settings.get("orchestrator.quota.fiveHour.hard"),
      stop: settings.get("orchestrator.quota.fiveHour.stop"),
    },
    sevenDay: {
      soft: settings.get("orchestrator.quota.sevenDay.soft"),
      hard: settings.get("orchestrator.quota.sevenDay.hard"),
    },
  };
}

function windowLevel(
  w: QuotaWindow,
  t: { soft: number; hard: number; stop?: number },
  nowMs: number,
): QuotaLevel {
  if (Date.parse(w.resetsAt) <= nowMs) return "ok"; // stale: the window has already reset
  if (w.status === "rejected") return "stop";
  if (t.stop !== undefined && w.utilization >= t.stop) return "stop";
  if (w.utilization >= t.hard) return "hard";
  if (w.utilization >= t.soft) return "soft";
  return "ok";
}

export function quotaLevel(s: QuotaSnapshot | null, t: QuotaThresholds, now: Date): QuotaDecision {
  const none: QuotaDecision = { level: "ok", window: null, resetsAt: null };
  if (s === null) return none;
  const nowMs = now.getTime();
  const candidates: QuotaDecision[] = [
    {
      level: windowLevel(s.fiveHour, t.fiveHour, nowMs),
      window: "five_hour",
      resetsAt: s.fiveHour.resetsAt,
    },
    {
      level: windowLevel(s.sevenDay, t.sevenDay, nowMs),
      window: "seven_day",
      resetsAt: s.sevenDay.resetsAt,
    },
  ];
  let worst = none;
  for (const c of candidates) {
    if (RANK[c.level] > RANK[worst.level]) worst = c;
  }
  return worst;
}

const BLOCKED: Record<QuotaLevel, ReadonlySet<PriorityClass>> = {
  ok: new Set(),
  soft: new Set<PriorityClass>(["batch", "backfill"]),
  hard: new Set<PriorityClass>(["engineering", "batch", "backfill"]),
  stop: new Set<PriorityClass>([
    "urgent",
    "send",
    "collection",
    "engineering",
    "batch",
    "backfill",
  ]),
};

/** True when a job of this class may start at this quota level. */
export function decideQuota(level: QuotaLevel, cls: PriorityClass): boolean {
  return !BLOCKED[level].has(cls);
}
