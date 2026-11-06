import { Database } from "bun:sqlite";
import { chmodSync, copyFileSync, existsSync, renameSync, statSync } from "node:fs";
import { basename } from "node:path";
import { knownMigrationHashes } from "@synapse/database";
import { loadConfig } from "../../apps/api/src/core/config/config";

export const RESTORE_USAGE = "usage: bun scripts/ops/restore.ts <backup-file> --yes";
export const RESTORED_LINE = "restored; start the API to apply any newer migrations";

export type RestoreRefusal =
  | "usage"
  | "no_confirm"
  | "backup_missing"
  | "api_running"
  | "database_busy"
  | "integrity_failed"
  | "not_a_synapse_backup"
  | "unknown_migration";

export interface RestoreDeps {
  dbPath: string;
  port: number;
  probe: (url: string) => Promise<boolean>;
  knownHashes: Set<string>;
  now: () => Date;
  log: (line: string) => void;
}

export type RestoreResult = { ok: true } | { ok: false; refusal: RestoreRefusal };

const p2 = (n: number) => String(n).padStart(2, "0");

function stamp(d: Date): string {
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
}

/** Whether the live DB can take a write lock right now. Null when there is no live DB. */
function liveIsFree(dbPath: string): boolean | null {
  if (!existsSync(dbPath)) return null;
  let live: Database | null = null;
  try {
    live = new Database(dbPath, { readwrite: true, create: false });
    live.run("PRAGMA busy_timeout = 0");
    live.run("BEGIN IMMEDIATE");
    live.run("ROLLBACK");
    return true;
  } catch {
    return false;
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

export async function restore(args: string[], deps: RestoreDeps): Promise<RestoreResult> {
  const refuse = (refusal: RestoreRefusal): RestoreResult => {
    deps.log(`restore refused: ${refusal}`);
    return { ok: false, refusal };
  };
  const yes = args.includes("--yes");
  const files = args.filter((a) => !a.startsWith("--"));
  if (files.length !== 1) {
    deps.log(RESTORE_USAGE);
    return refuse("usage");
  }
  const backup = files[0] as string;
  if (!yes) return refuse("no_confirm");
  if (!existsSync(backup)) return refuse("backup_missing");

  if (await deps.probe(`http://127.0.0.1:${deps.port}/health/live`)) return refuse("api_running");

  const free = liveIsFree(deps.dbPath);
  if (free === false) return refuse("database_busy");

  const verdict = checkBackup(backup, deps.knownHashes);
  if (verdict !== "ok") return refuse(verdict);

  const { dbPath } = deps;
  if (free === true) {
    // Fold committed WAL rows into the main file, then move all three files aside together so
    // the restored DB never replays a foreign WAL.
    const live = new Database(dbPath, { readwrite: true, create: false });
    try {
      live.run("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      live.close();
    }
    const aside = `${dbPath}.before-restore-${stamp(deps.now())}`;
    for (const suffix of ["", "-wal", "-shm"]) {
      const from = `${dbPath}${suffix}`;
      if (!existsSync(from)) continue;
      const to = `${aside}${suffix}`;
      renameSync(from, to);
      chmodSync(to, 0o600);
      deps.log(`moved aside: ${basename(to)} (${statSync(to).size} bytes)`);
    }
  }

  const tmp = `${dbPath}.restore-tmp`;
  copyFileSync(backup, tmp);
  chmodSync(tmp, 0o600);
  renameSync(tmp, dbPath);
  deps.log(`restored: ${basename(dbPath)} (${statSync(dbPath).size} bytes)`);
  deps.log(RESTORED_LINE);
  return { ok: true };
}

if (import.meta.main) {
  process.umask(0o077);
  const config = loadConfig(process.env);
  const res = await restore(process.argv.slice(2), {
    dbPath: config.dbPath,
    port: config.api.port,
    probe: async (url) => {
      try {
        await fetch(url, { signal: AbortSignal.timeout(1000) });
        return true;
      } catch {
        return false;
      }
    },
    knownHashes: knownMigrationHashes(),
    now: () => new Date(),
    log: (l) => console.log(l),
  });
  process.exit(res.ok ? 0 : 1);
}
