import type { Database } from "bun:sqlite";
import type { AIProvider } from "@synapse/contracts";
import { type Db, schema } from "@synapse/database";
import { type Clock, isoNow, systemClock } from "@synapse/shared";
import { and, count, eq, lte, min } from "drizzle-orm";
import type { SettingsService } from "../config/settings";
import type { AuthMonitor } from "../orchestrator/auth";
import type { HealthCheck } from "./health";

const { jobs, eventConsumptions } = schema;

const STALE_PENDING_MS = 15 * 60_000;
const STALE_HEARTBEAT_MS = 3 * 60_000;
const MIN_BUN = "1.4.4";

function guarded(check: HealthCheck): HealthCheck {
  return async () => {
    try {
      return await check();
    } catch (e) {
      return { status: "down", detail: e instanceof Error ? e.message : String(e) };
    }
  };
}

export function databaseCheck(sqlite: Database): HealthCheck {
  return guarded(async () => {
    sqlite.query("select 1").get();
    const row = sqlite.query("pragma journal_mode").get() as { journal_mode: string } | null;
    const mode = row?.journal_mode;
    if (mode !== "wal") {
      return { status: "degraded", detail: `journal_mode is ${mode}, expected wal` };
    }
    return { status: "ok" };
  });
}

export function jobsCheck(db: Db, clock: Clock): HealthCheck {
  return guarded(async () => {
    const now = isoNow(clock);
    const problems: string[] = [];
    const oldest = db
      .select({ runAfter: min(jobs.runAfter) })
      .from(jobs)
      .where(and(eq(jobs.status, "PENDING"), lte(jobs.runAfter, now)))
      .get()?.runAfter;
    if (oldest && clock.now().getTime() - Date.parse(oldest) > STALE_PENDING_MS) {
      problems.push(`oldest due pending job is from ${oldest}`);
    }
    const expired = db
      .select({ n: count() })
      .from(jobs)
      .where(and(eq(jobs.status, "RUNNING"), lte(jobs.leaseExpiresAt, now)))
      .get()?.n;
    if (expired) problems.push(`${expired} running job(s) with expired lease`);
    const parked = db
      .select({ n: count() })
      .from(jobs)
      .where(eq(jobs.status, "NEEDS_ATTENTION"))
      .get()?.n;
    if (parked) problems.push(`${parked} job(s) need attention`);
    return problems.length > 0
      ? { status: "degraded", detail: problems.join("; ") }
      : { status: "ok" };
  });
}

/** Consumers that exhausted their retries for an event (event-system.md, Delivery §4). */
export function eventsCheck(db: Db): HealthCheck {
  return guarded(async () => {
    const failed = db
      .select({ n: count() })
      .from(eventConsumptions)
      .where(eq(eventConsumptions.status, "failed"))
      .get()?.n;
    return failed
      ? { status: "degraded", detail: `${failed} failed event consumption(s)` }
      : { status: "ok" };
  });
}

export function heartbeatCheck(settings: SettingsService, clock: Clock): HealthCheck {
  return guarded(async () => {
    const last = settings.get("system.lastHeartbeatAt");
    if (last === null) return { status: "degraded", detail: "no heartbeat recorded" };
    if (clock.now().getTime() - Date.parse(last) > STALE_HEARTBEAT_MS) {
      return { status: "degraded", detail: `last heartbeat at ${last}` };
    }
    return { status: "ok" };
  });
}

export function lingerCheck(
  run: (cmd: string[]) => Promise<string>,
  user: string = process.env.USER ?? "",
): HealthCheck {
  return guarded(async () => {
    const out = await run(["loginctl", "show-user", user, "-p", "Linger"]);
    const m = /Linger=(yes|no)/.exec(out);
    if (!m) return { status: "degraded", detail: `unparseable loginctl output: ${out.trim()}` };
    if (m[1] === "no") return { status: "degraded", detail: `run: loginctl enable-linger ${user}` };
    return { status: "ok" };
  });
}

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((p) => Number.parseInt(p, 10) || 0);
  const pb = b.split(".").map((p) => Number.parseInt(p, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function bunVersionCheck(version: string = Bun.version): HealthCheck {
  return guarded(async () =>
    compareSemver(version, MIN_BUN) < 0
      ? { status: "down", detail: `bun ${version} < required ${MIN_BUN}` }
      : { status: "ok", detail: version },
  );
}

const AUTH_DOWN_MS = 2 * 3_600_000;
const AUTH_DEGRADED_MS = 48 * 3_600_000;

export function authCheck(monitor: AuthMonitor, clock: Clock): HealthCheck {
  return guarded(async () => {
    const st = monitor.status();
    if (st.readError !== null) return { status: "degraded", detail: st.readError };
    if (st.refreshExpiresAt === null) {
      return { status: "degraded", detail: "no auth snapshot recorded" };
    }
    const left = Date.parse(st.refreshExpiresAt) - clock.now().getTime();
    const slides = st.slides === null ? "unknown" : st.slides ? "yes" : "no";
    const detail = `refresh token expires ${st.refreshExpiresAt}; slides: ${slides}`;
    if (left < AUTH_DOWN_MS) return { status: "down", detail };
    if (left < AUTH_DEGRADED_MS) return { status: "degraded", detail };
    return { status: "ok", detail };
  });
}

const CLAUDE_HEALTH_TTL_MS = 60_000;

/** Caches the provider health (P5): `getHealth` spawns the CLI, so /health/ready must not on every call. */
export function claudeCheck(
  provider: AIProvider,
  clock: Clock = systemClock,
  ttlMs: number = CLAUDE_HEALTH_TTL_MS,
): HealthCheck {
  let cached: { at: number; result: Awaited<ReturnType<HealthCheck>> } | null = null;
  return guarded(async () => {
    const now = clock.now().getTime();
    if (cached && now - cached.at < ttlMs) return cached.result;
    const h = await provider.getHealth();
    const detail = [h.detail, h.version].filter((x) => x !== undefined).join(" ");
    const result = detail ? { status: h.status, detail } : { status: h.status };
    cached = { at: now, result };
    return result;
  });
}
