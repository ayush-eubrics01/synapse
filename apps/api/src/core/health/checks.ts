import type { Database } from "bun:sqlite";
import type { AIProvider, BackupEntry, ClaudeActivityHealth } from "@synapse/contracts";
import { type Db, schema } from "@synapse/database";
import { type Clock, isoNow, systemClock } from "@synapse/shared";
import { and, count, eq, lte, min } from "drizzle-orm";
import type { PrivateFilesResult } from "../../infrastructure/private-files";
import { type CommandRunner, CommandTimeoutError } from "../../infrastructure/run-command";
import type { SettingsService } from "../config/settings";
import type { DatabaseIntegrity } from "../ops/integrity";
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

export function databaseCheck(
  sqlite: Database,
  integrity?: Pick<DatabaseIntegrity, "last">,
): HealthCheck {
  return guarded(async () => {
    sqlite.query("select 1").get();
    // A failed quick_check is `down` whatever the journal mode.
    if (integrity?.last()?.result === "failed") {
      return { status: "down", detail: "quick_check failed" };
    }
    const row = sqlite.query("pragma journal_mode").get() as { journal_mode: string } | null;
    const mode = row?.journal_mode;
    if (mode !== "wal") {
      return { status: "degraded", detail: `journal_mode is ${mode}, expected wal` };
    }
    return { status: "ok" };
  });
}

export function filePermissionsCheck(r: PrivateFilesResult): HealthCheck {
  return guarded(async () =>
    r.ok
      ? { status: "ok" }
      : { status: "degraded", detail: `chmod failed for ${r.failed} path(s)` },
  );
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

export const LINGER_TIMEOUT_MS = 3_000;

export function lingerCheck(
  run: CommandRunner,
  user: string = process.env.USER ?? "",
): HealthCheck {
  return guarded(async () => {
    let out: string;
    try {
      out = await run(["loginctl", "show-user", user, "-p", "Linger"], {
        timeoutMs: LINGER_TIMEOUT_MS,
      });
    } catch (e) {
      if (e instanceof CommandTimeoutError) return { status: "degraded", detail: "timeout" };
      throw e;
    }
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
const CLAUDE_UNHEALTHY_TTL_MS = 10_000;

/**
 * Caches the provider health (P5): `getHealth` spawns the CLI, so /health/ready must not on every
 * call. The in-flight promise is shared, thrown errors are never cached, and non-ok results are
 * cached only briefly so recovery shows up quickly.
 */
export function claudeCheck(
  provider: AIProvider,
  clock: Clock = systemClock,
  ttlMs: number = CLAUDE_HEALTH_TTL_MS,
): HealthCheck {
  type Result = Awaited<ReturnType<HealthCheck>>;
  let cached: { at: number; ttl: number; result: Result } | null = null;
  let inflight: Promise<Result> | null = null;
  return guarded(async () => {
    const now = clock.now().getTime();
    if (cached && now - cached.at < cached.ttl) return cached.result;
    if (!inflight) {
      inflight = (async () => {
        try {
          const h = await provider.getHealth();
          const detail = [h.detail, h.version].filter((x) => x !== undefined).join(" ");
          const result: Result = detail ? { status: h.status, detail } : { status: h.status };
          cached = {
            at: now,
            ttl: h.status === "ok" ? ttlMs : Math.min(ttlMs, CLAUDE_UNHEALTHY_TTL_MS),
            result,
          };
          return result;
        } finally {
          inflight = null;
        }
      })();
    }
    return inflight;
  });
}

/** Degraded while the stored security rules are unusable and the starter rules stand in. */
export function securityRulesCheck(rules: { rulesFallbackActive(): boolean }): HealthCheck {
  return guarded(async () =>
    rules.rulesFallbackActive()
      ? { status: "degraded", detail: "stored security rules invalid; fallback rules in effect" }
      : { status: "ok" },
  );
}

/** Degraded when `notify-send` is missing or the last desktop notification failed. */
export function desktopNotifierCheck(n: {
  health(): { ok: boolean; detail?: string };
}): HealthCheck {
  return guarded(async () => {
    const h = n.health();
    return h.ok ? { status: "ok" } : { status: "degraded", detail: h.detail ?? "unavailable" };
  });
}

/** Degraded while any user-edited screening keyword regex is invalid and skipped. */
export function screeningRulesCheck(rules: { invalidKeywordIds(): string[] }): HealthCheck {
  return guarded(async () => {
    const n = rules.invalidKeywordIds().length;
    return n > 0
      ? { status: "degraded", detail: `${n} screening keyword rule(s) invalid and skipped` }
      : { status: "ok" };
  });
}

/** A8: `disabled` is not a core status, so it reads as ok with the detail "disabled". */
export function claudeActivityCheck(service: { healthState(): ClaudeActivityHealth }): HealthCheck {
  return guarded(async () => {
    const h = service.healthState();
    if (h.state === "disabled") return { status: "ok", detail: "disabled" };
    if (h.state === "degraded") return { status: "degraded", detail: h.message ?? undefined };
    return { status: "ok" };
  });
}

const BACKUP_STALE_MS = 36 * 3_600_000;
const BACKUP_GRACE_MS = 24 * 3_600_000;
const GIB = 2 ** 30;

export function backupCheck(deps: {
  settings: SettingsService;
  backup: { list(): BackupEntry[]; lastAttempt(): { ok: boolean; at: string } | null };
  clock: Clock;
  startedAt: Date;
}): HealthCheck {
  return guarded(async () => {
    if (!deps.settings.get("ops.backup.enabled")) return { status: "ok", detail: "disabled" };
    if (deps.backup.lastAttempt()?.ok === false) {
      return { status: "degraded", detail: "last backup failed" };
    }
    const now = deps.clock.now().getTime();
    if (now - deps.startedAt.getTime() >= BACKUP_GRACE_MS) {
      const newest = deps.backup.list()[0];
      if (!newest || now - Date.parse(newest.createdAt) > BACKUP_STALE_MS) {
        return { status: "degraded", detail: "no backup in 36 h" };
      }
    }
    return { status: "ok" };
  });
}

export function diskCheck(deps: {
  settings: SettingsService;
  diskFree: (path: string) => number | null;
  dataDir: string;
}): HealthCheck {
  return guarded(async () => {
    const free = deps.diskFree(deps.dataDir);
    if (free === null) return { status: "degraded", detail: "free space unknown" };
    const gib = free / GIB;
    const detail = `${gib.toFixed(1)} GiB free`;
    if (free < GIB) return { status: "down", detail };
    if (gib < deps.settings.get("ops.disk.warnFreeGiB")) return { status: "degraded", detail };
    return { status: "ok" };
  });
}

/** ADR-040: develop runs need bubblewrap and socat and an unmasked run root. Setting off reads `ok` (the feature is off). */
export function sandboxCheck(deps: {
  settings: Pick<SettingsService, "get">;
  which: (bin: string) => string | null;
  runRootMasked?: () => boolean;
}): HealthCheck {
  return guarded(async () => {
    if (!deps.settings.get("engineering.sandbox.enabled")) {
      return { status: "ok", detail: "disabled" };
    }
    const missing = ["bwrap", "socat"].filter((b) => deps.which(b) === null);
    if (missing.length > 0) {
      return { status: "degraded", detail: `missing: ${missing.join(", ")}` };
    }
    // H4.6: the run root is inside a masked path, so every develop run would be refused.
    if (deps.runRootMasked?.()) return { status: "degraded", detail: "run_root_masked" };
    return { status: "ok" };
  });
}

/**
 * The orchestrator's refusal condition for user settings, from the startup flags: a widening
 * `permissions`/`sandbox` entry, or a user-allowed connector server outside the known list.
 */
export function claudeSettingsCheck(deps: {
  provider: Pick<AIProvider, "userPermissionsWidenScope" | "userAllowedConnectorServers">;
  knownServers: () => readonly string[];
}): HealthCheck {
  return guarded(async () => {
    const known = new Set(deps.knownServers());
    const unknown = (deps.provider.userAllowedConnectorServers ?? []).some((s) => !known.has(s));
    return deps.provider.userPermissionsWidenScope === true || unknown
      ? { status: "degraded", detail: "unsafe_user_settings" }
      : { status: "ok" };
  });
}
