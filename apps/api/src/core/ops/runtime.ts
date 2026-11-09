import type { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeView } from "@synapse/contracts";
import type { Db } from "@synapse/database";
import type { Clock } from "@synapse/shared";
import type { SettingsService } from "../config/settings";
import type { BackupService } from "./backup";

const SHA_RE = /^[0-9a-f]{7,12}$/;

/**
 * `<package version>[+<short sha>]`. Null when the package file is unreadable; a git failure or an
 * unexpected output just leaves the sha off.
 */
export async function readVersion(
  repoRoot: string,
  run: (cmd: string[]) => Promise<string>,
): Promise<string | null> {
  let version: string;
  try {
    const pkg = JSON.parse(await readFile(join(repoRoot, "apps/api/package.json"), "utf8")) as {
      version?: unknown;
    };
    if (typeof pkg.version !== "string" || pkg.version === "") return null;
    version = pkg.version;
  } catch {
    return null;
  }
  try {
    const sha = (await run(["git", "-C", repoRoot, "rev-parse", "--short", "HEAD"])).trim();
    return SHA_RE.test(sha) ? `${version}+${sha}` : version;
  } catch {
    return version;
  }
}

export interface RuntimeDeps {
  db: Db;
  sqlite: Database;
  clock: Clock;
  settings: SettingsService;
  startedAt: Date;
  dbPath: string;
  dataDir: string;
  diskFree: (path: string) => number | null;
  backup: Pick<BackupService, "list" | "lastAttempt">;
  version: Promise<string | null>;
  endpoints: RuntimeView["endpoints"];
}

/** The operational numbers behind the System Runtime panel (R5). Names, sizes and counts only. */
export class RuntimeService {
  constructor(private readonly d: RuntimeDeps) {}

  async view(): Promise<RuntimeView> {
    const { sqlite, clock, startedAt } = this.d;
    const now = clock.now();
    const backups = this.d.backup.list();
    const counts = new Map(
      sqlite
        .query<{ status: string; n: number }, []>(
          "select status, count(*) as n from jobs group by status",
        )
        .all()
        .map((r) => [r.status, r.n]),
    );
    const oldest = sqlite
      .query<{ t: string | null }, [string]>(
        "select min(run_after) as t from jobs where status = 'PENDING' and run_after <= ?",
      )
      .get(now.toISOString())?.t;
    const pages =
      sqlite.query<{ page_count: number }, []>("pragma page_count").get()?.page_count ?? 0;
    const pageSize =
      sqlite.query<{ page_size: number }, []>("pragma page_size").get()?.page_size ?? 0;
    return {
      startedAt: startedAt.toISOString(),
      uptimeSeconds: Math.max(0, Math.floor((now.getTime() - startedAt.getTime()) / 1000)),
      version: await this.d.version,
      memoryRssBytes: process.memoryUsage.rss(),
      dbBytes: pages * pageSize,
      walBytes: this.walBytes(),
      dataDirFreeBytes: this.d.diskFree(this.d.dataDir),
      lastBackup: backups[0] ? { name: backups[0].name, createdAt: backups[0].createdAt } : null,
      backupCount: backups.length,
      lastBackupAttempt: this.d.backup.lastAttempt(),
      queue: {
        pending: counts.get("PENDING") ?? 0,
        running: counts.get("RUNNING") ?? 0,
        retry: counts.get("RETRY") ?? 0,
        needsAttention: counts.get("NEEDS_ATTENTION") ?? 0,
        oldestPendingAgeSeconds: oldest
          ? Math.max(0, Math.floor((now.getTime() - new Date(oldest).getTime()) / 1000))
          : null,
      },
      retention: this.d.settings.get("ops.retention.lastRun"),
      endpoints: this.d.endpoints,
    };
  }

  private walBytes(): number {
    if (this.d.dbPath === ":memory:") return 0;
    try {
      return statSync(`${this.d.dbPath}-wal`).size;
    } catch {
      return 0;
    }
  }
}
