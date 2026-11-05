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

const HOUR_MS = 3_600_000;
/** Minimum deferral for quota_exhausted, so a bad or past resetsAt can never cause a spawn loop. */
export const QUOTA_MIN_RETRY_MS = 15 * 60_000;

/** retryAfter for quota_exhausted: max(resetsAt ?? 0, now + 15 min). */
export function clampQuotaRetry(resetsAt: string | undefined, now: Date): string {
  const floor = now.getTime() + QUOTA_MIN_RETRY_MS;
  const at = resetsAt === undefined ? Number.NaN : Date.parse(resetsAt);
  return new Date(Number.isFinite(at) && at > floor ? at : floor).toISOString();
}

/**
 * When a window stops counting. A missing resetsAt counts for one hour after observation (R30).
 * A rejected window counts until at least observedAt + 1h even if its resetsAt is already past,
 * so a rejection is never ignored (fail closed). A stale allowed window is ignored.
 */
function effectiveReset(w: QuotaWindow, observedAtMs: number): number {
  const fallback = observedAtMs + HOUR_MS;
  const at = w.resetsAt === undefined ? Number.NaN : Date.parse(w.resetsAt);
  if (!Number.isFinite(at)) return fallback;
  return w.status === "rejected" ? Math.max(at, fallback) : at;
}

function windowLevel(
  w: QuotaWindow,
  t: { soft: number; hard: number; stop?: number },
  nowMs: number,
  resetMs: number,
): QuotaLevel {
  if (resetMs <= nowMs) return "ok"; // stale: the window has already reset
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
  const observedMs = Date.parse(s.observedAt);
  const windows = [
    { w: s.fiveHour, t: t.fiveHour, window: "five_hour" as const },
    { w: s.sevenDay, t: t.sevenDay, window: "seven_day" as const },
  ];
  let worst = none;
  for (const { w, t: th, window } of windows) {
    if (!w) continue; // absent window: nothing known about it
    const resetMs = effectiveReset(w, Number.isFinite(observedMs) ? observedMs : nowMs);
    const level = windowLevel(w, th, nowMs, resetMs);
    if (RANK[level] > RANK[worst.level]) {
      worst = { level, window, resetsAt: new Date(resetMs).toISOString() };
    }
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
