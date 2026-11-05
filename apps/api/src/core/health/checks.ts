import type { Database } from "bun:sqlite";
import { type Clock, isoNow } from "@synapse/shared";
import type { SettingsService } from "../config/settings";
import type { JobQueue } from "../jobs/queue";
import type { HealthCheck } from "./health";

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

export function jobsCheck(queue: JobQueue, clock: Clock): HealthCheck {
  return guarded(async () => {
    const now = isoNow(clock);
    const nowMs = clock.now().getTime();
    const due = queue.list({ status: "PENDING", limit: 100_000 }).filter((j) => j.runAfter <= now);
    const oldest = due.reduce<string | null>(
      (acc, j) => (acc === null || j.runAfter < acc ? j.runAfter : acc),
      null,
    );
    if (oldest !== null && nowMs - Date.parse(oldest) > STALE_PENDING_MS) {
      return { status: "degraded", detail: `oldest due pending job is from ${oldest}` };
    }
    const expired = queue
      .list({ status: "RUNNING", limit: 100_000 })
      .filter((j) => j.leaseExpiresAt !== null && j.leaseExpiresAt <= now);
    if (expired.length > 0) {
      return { status: "degraded", detail: `${expired.length} running job(s) with expired lease` };
    }
    return { status: "ok" };
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
