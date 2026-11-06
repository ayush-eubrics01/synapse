import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  renameSync,
  statfsSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { knownMigrationHashes } from "@synapse/database";
import { loadConfig } from "../../apps/api/src/core/config/config";

export const RESTORE_USAGE = "usage: bun scripts/ops/restore.ts <backup-file> --yes";
export const RESTORE_REMINDER =
  "check Outgoing and Inbox before approving anything: an older snapshot can show executed approvals as pending again";
export const RESTORED_LINE = "restored; start the API to apply any newer migrations";

export type RestoreRefusal =
  | "usage"
  | "no_confirm"
  | "backup_missing"
  | "backup_has_wal"
  | "api_running"
  | "api_state_unknown"
  | "database_busy"
  | "integrity_failed"
  | "not_a_synapse_backup"
  | "unknown_migration"
  | "insufficient_space"
  | "aside_exists"
  | "restore_failed";

export type ProbeResult = "up" | "down" | "unknown";

export interface RestoreDeps {
  dbPath: string;
  host: string;
  port: number;
  /** "up": any HTTP answer. "down": connection refused only. "unknown": timeout or anything else. */
  probe: (url: string) => Promise<ProbeResult>;
  knownHashes: Set<string>;
  now: () => Date;
  log: (line: string) => void;
  /** Free bytes at a path, or null when unknown. */
  diskFree?: (path: string) => number | null;
  /** Test seams. */
  copy?: (from: string, to: string) => void;
  rand?: () => string;
}

export type RestoreResult = { ok: true } | { ok: false; refusal: RestoreRefusal };

const p2 = (n: number) => String(n).padStart(2, "0");
const SPACE_MARGIN = 64 * 2 ** 20;
const SUFFIXES = ["", "-wal", "-shm"] as const;

function stamp(d: Date): string {
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
}

function defaultDiskFree(path: string): number | null {
  try {
    const s = statfsSync(path);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

function healthUrl(host: string, port: number): string {
  const h = host.includes(":") ? `[${host}]` : host;
  return `http://${h}:${port}/health/live`;
}

/** "free" when the live DB can take a write lock and a full TRUNCATE checkpoint right now; "corrupt" only for NOTADB/CORRUPT. */
function liveState(dbPath: string): "free" | "busy" | "corrupt" {
  let live: Database | null = null;
  try {
    live = new Database(dbPath, { readwrite: true, create: false });
    live.run("PRAGMA busy_timeout = 0");
    live.run("BEGIN IMMEDIATE");
    live.run("ROLLBACK");
    const r = live.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as {
      busy: number;
      log: number;
      checkpointed: number;
    } | null;
    return r && r.busy === 0 && r.log === r.checkpointed ? "free" : "busy";
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    return code === "SQLITE_NOTADB" || code === "SQLITE_CORRUPT" ? "corrupt" : "busy";
  } finally {
    live?.close();
  }
}

type BackupCheck = "ok" | "integrity_failed" | "not_a_synapse_backup" | "unknown_migration";

function checkBackup(path: string, known: Set<string>): BackupCheck {
  let b: Database | null = null;
  try {
    b = new Database(path, { readonly: true });
    const ic = b.query("PRAGMA integrity_check").all() as { integrity_check: string }[];
    if (ic.length !== 1 || ic[0]?.integrity_check !== "ok") return "integrity_failed";
    const has = b
      .query(
        "select 1 as x from sqlite_master where type = 'table' and name = '__drizzle_migrations'",
      )
      .get();
    if (!has) return "not_a_synapse_backup";
    const hashes = b.query("select hash from __drizzle_migrations").all() as { hash: string }[];
    return hashes.every((h) => known.has(h.hash)) ? "ok" : "unknown_migration";
  } catch {
    return "integrity_failed";
  } finally {
    b?.close();
  }
}

function rmQuiet(p: string): void {
  try {
    unlinkSync(p);
  } catch {
    // already gone
  }
}

function fsyncFile(p: string): void {
  const fd = openSync(p, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDir(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // best effort
  }
}

export async function restore(args: string[], deps: RestoreDeps): Promise<RestoreResult> {
  const refuse = (refusal: RestoreRefusal): RestoreResult => {
    deps.log(`restore refused: ${refusal}`);
    return { ok: false, refusal };
  };
  try {
    return await run(args, deps, refuse);
  } catch {
    return refuse("restore_failed");
  }
}

async function run(
  args: string[],
  deps: RestoreDeps,
  refuse: (r: RestoreRefusal) => RestoreResult,
): Promise<RestoreResult> {
  const flags = args.filter((a) => a.startsWith("--"));
  const files = args.filter((a) => !a.startsWith("--"));
  if (files.length !== 1 || flags.some((f) => f !== "--yes")) {
    deps.log(RESTORE_USAGE);
    return refuse("usage");
  }
  const backup = files[0] as string;
  if (!flags.includes("--yes")) return refuse("no_confirm");
  if (!existsSync(backup)) return refuse("backup_missing");
  if (existsSync(`${backup}-wal`)) return refuse("backup_has_wal");

  const probed = await deps.probe(healthUrl(deps.host, deps.port));
  if (probed === "up") return refuse("api_running");
  if (probed === "unknown") return refuse("api_state_unknown");

  const { dbPath } = deps;
  if (existsSync(dbPath)) {
    const state = liveState(dbPath);
    if (state === "busy") return refuse("database_busy");
    if (state === "corrupt") deps.log("live database is corrupt; it will be moved aside");
  }

  const verdict = checkBackup(backup, deps.knownHashes);
  if (verdict !== "ok") return refuse(verdict);

  const rand = deps.rand ?? (() => randomBytes(3).toString("hex"));
  const backupSize = statSync(backup).size;
  const free = (deps.diskFree ?? defaultDiskFree)(dirname(dbPath));
  if (free !== null && free < backupSize + SPACE_MARGIN) return refuse("insufficient_space");

  const aside = `${dbPath}.before-restore-${stamp(deps.now())}-${rand()}`;
  const present = SUFFIXES.filter((x) => existsSync(`${dbPath}${x}`));
  if (SUFFIXES.some((x) => existsSync(`${aside}${x}`))) return refuse("aside_exists");

  // Copy first, so a failure here changes nothing.
  const tmp = join(dirname(dbPath), `.restore-tmp-${rand()}`);
  try {
    (deps.copy ?? copyFileSync)(backup, tmp);
    chmodSync(tmp, 0o600);
    fsyncFile(tmp);
  } catch {
    rmQuiet(tmp);
    return refuse("restore_failed");
  }

  const moved: string[] = [];
  const rollback = () => {
    for (const x of moved.reverse()) {
      try {
        renameSync(`${aside}${x}`, `${dbPath}${x}`);
      } catch {
        // best effort; the aside set stays on disk
      }
    }
    rmQuiet(tmp);
  };
  try {
    for (const x of present) {
      const to = `${aside}${x}`;
      linkSync(`${dbPath}${x}`, to); // fails with EEXIST rather than overwriting
      unlinkSync(`${dbPath}${x}`);
      moved.push(x);
      chmodSync(to, 0o600);
      deps.log(`moved aside: ${basename(to)} (${statSync(to).size} bytes)`);
    }
    renameSync(tmp, dbPath);
    fsyncDir(dirname(dbPath));
  } catch (e) {
    rollback();
    return refuse(
      (e as { code?: string } | null)?.code === "EEXIST" ? "aside_exists" : "restore_failed",
    );
  }
  deps.log(`restored: ${basename(dbPath)} (${statSync(dbPath).size} bytes)`);
  deps.log(RESTORED_LINE);
  deps.log(RESTORE_REMINDER);
  return { ok: true };
}

async function main(): Promise<boolean> {
  process.umask(0o077);
  const config = loadConfig(process.env);
  const res = await restore(process.argv.slice(2), {
    dbPath: config.dbPath,
    host: config.api.host,
    port: config.api.port,
    probe: async (url) => {
      try {
        await fetch(url, { signal: AbortSignal.timeout(1000) });
        return "up";
      } catch (e) {
        const code = (e as { code?: string } | null)?.code;
        return code === "ConnectionRefused" || code === "ECONNREFUSED" ? "down" : "unknown";
      }
    },
    knownHashes: knownMigrationHashes(),
    now: () => new Date(),
    log: (l) => console.log(l),
  });
  return res.ok;
}

if (import.meta.main) {
  let ok = false;
  try {
    ok = await main();
  } catch {
    console.log("restore refused: restore_failed");
  }
  process.exit(ok ? 0 : 1);
}
