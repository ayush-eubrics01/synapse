import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { BackupEntry, BackupFailureCode } from "@synapse/contracts";
import { type Db, schema } from "@synapse/database";
import { type Clock, newId } from "@synapse/shared";
import { desc, inArray, sql } from "drizzle-orm";
import type { AuditLogger } from "../audit/audit";
import { checkBackupDir } from "../config/config";

export const BACKUP_NAME_RE = /^synapse-\d{8}-\d{6}\.db$/;
export const BACKUP_TMP_RE = /^\.synapse-.+\.tmp$/;

const GIB = 2 ** 30;
const p2 = (n: number) => String(n).padStart(2, "0");

/** `synapse-YYYYMMDD-HHMMSS.db` in local time. */
export function backupFileName(now: Date): string {
  const d = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}`;
  const t = `${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
  return `synapse-${d}-${t}.db`;
}

export interface BackupServiceDeps {
  db: Db;
  sqlite: Database;
  clock: Clock;
  audit: AuditLogger;
  dir: string;
  dbPath: string;
  diskFree: (path: string) => number | null;
  vacuumInto?: (target: string) => void;
  fileName?: (now: Date) => string;
  /** Apply the "outside the repository" check to `dir` (true for an explicitly configured dir). */
  checkDir?: boolean;
  /** chmod 0700 a directory that already existed (only the dedicated default dir). A directory this service creates is always 0700. */
  chmodDir?: boolean;
  /** Test seam for the repository root used by that check. */
  repoRoot?: string;
}

export type BackupResult =
  | { ok: true; name: string; bytes: number; pruned: number }
  | { ok: false; failure: BackupFailureCode; cause?: string };

class Failure extends Error {
  constructor(
    readonly code: BackupFailureCode,
    readonly cause?: string,
  ) {
    super(code);
  }
}

/** A fixed error code such as EACCES or SQLITE_FULL; anything else (messages, paths) is dropped. */
function causeOf(e: unknown): string | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z_]{2,32}$/.test(code) ? code : undefined;
}

function rmQuiet(p: string): void {
  try {
    unlinkSync(p);
  } catch {
    // already gone
  }
}

export class BackupService {
  readonly dir: string;

  constructor(private readonly d: BackupServiceDeps) {
    this.dir = d.dir;
  }

  /** Never throws: every outcome is audited with a fixed code. */
  run(keep: number): BackupResult {
    let result: BackupResult;
    try {
      result = this.attempt(keep);
    } catch (e) {
      const failure = e instanceof Failure ? e.code : "unexpected";
      const cause = e instanceof Failure ? e.cause : causeOf(e);
      result = cause ? { ok: false, failure, cause } : { ok: false, failure };
    }
    try {
      this.d.audit.record(this.d.db, {
        actor: "system",
        module: "ops",
        action: result.ok ? "ops.backup_created" : "ops.backup_failed",
        result: result.ok ? "ok" : "failed",
        details: result.ok
          ? { name: result.name, bytes: result.bytes, pruned: result.pruned }
          : result.cause
            ? { code: result.failure, cause: result.cause }
            : { code: result.failure },
      });
    } catch {
      // the audit write must not turn a finished backup into a throw
    }
    return result;
  }

  list(): BackupEntry[] {
    let names: string[];
    try {
      names = readdirSync(this.dir).filter((n) => BACKUP_NAME_RE.test(n));
    } catch {
      return [];
    }
    const out: { entry: BackupEntry; ms: number }[] = [];
    for (const name of names) {
      try {
        const s = lstatSync(join(this.dir, name));
        if (!s.isFile()) continue;
        out.push({
          entry: { name, bytes: s.size, createdAt: new Date(s.mtimeMs).toISOString() },
          ms: s.mtimeMs,
        });
      } catch {
        // removed between readdir and stat
      }
    }
    out.sort((a, b) => b.ms - a.ms || (a.entry.name < b.entry.name ? 1 : -1));
    return out.map((o) => o.entry);
  }

  lastAttempt(): { ok: boolean; at: string; code: string | null } | null {
    const row = this.d.db
      .select({
        action: schema.auditEvents.action,
        at: schema.auditEvents.occurredAt,
        details: schema.auditEvents.details,
      })
      .from(schema.auditEvents)
      .where(inArray(schema.auditEvents.action, ["ops.backup_created", "ops.backup_failed"]))
      .orderBy(desc(schema.auditEvents.occurredAt), sql`rowid desc`)
      .get();
    if (!row) return null;
    const ok = row.action === "ops.backup_created";
    const code = (row.details as { code?: unknown } | null)?.code;
    return { ok, at: row.at, code: !ok && typeof code === "string" ? code : null };
  }

  private attempt(keep: number): BackupResult {
    const { dir } = this;
    this.prepareDir();
    for (const n of readdirSync(dir)) if (BACKUP_TMP_RE.test(n)) rmQuiet(join(dir, n));

    const free = this.d.diskFree(dir);
    if (free !== null && free < 2 * this.dbBytes() + GIB) throw new Failure("insufficient_space");

    const now = this.d.clock.now();
    const name = (this.d.fileName ?? backupFileName)(now);
    const stamp = name.replace(/^synapse-/, "").replace(/\.db$/, "");
    const tmp = join(dir, `.synapse-${stamp}-${newId().slice(-8)}.tmp`);
    const target = join(dir, name);
    try {
      // Created 0600 up front (an empty file is a valid VACUUM INTO target), so the copy is
      // never readable by others, whatever the umask.
      writeFileSync(tmp, "", { mode: 0o600, flag: "wx" });
      try {
        (this.d.vacuumInto ?? ((t) => void this.d.sqlite.run("VACUUM INTO ?", [t])))(tmp);
      } catch (e) {
        throw new Failure("vacuum_failed", causeOf(e));
      }
      if (!this.integrityOk(tmp)) throw new Failure("integrity_failed");
      chmodSync(tmp, 0o600);
      // A hard link never replaces an existing file, even one that appeared since the check.
      try {
        linkSync(tmp, target);
      } catch (e) {
        throw (e as { code?: string }).code === "EEXIST" ? new Failure("name_conflict") : e;
      }
      unlinkSync(tmp);
    } catch (e) {
      rmQuiet(tmp);
      throw e;
    }
    return { ok: true, name, bytes: lstatSync(target).size, pruned: this.prune(keep, name) };
  }

  private prepareDir(): void {
    if (this.d.checkDir !== false && checkBackupDir(this.dir, this.d.repoRoot) !== "ok")
      throw new Failure("dir_unavailable");
    try {
      const existed = existsSync(this.dir);
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const s = statSync(this.dir);
      if (!s.isDirectory()) throw new Failure("dir_unavailable");
      if (s.uid !== process.getuid?.()) throw new Failure("dir_unavailable");
      if (!existed || this.d.chmodDir !== false) chmodSync(this.dir, 0o700);
    } catch (e) {
      throw e instanceof Failure ? e : new Failure("dir_unavailable");
    }
  }

  private dbBytes(): number {
    const n = (p: string) =>
      (this.d.sqlite.query(`pragma ${p}`).get() as Record<string, number> | null)?.[p] ?? 0;
    let wal = 0;
    try {
      wal = statSync(`${this.d.dbPath}-wal`).size;
    } catch {
      // no wal file
    }
    return n("page_count") * n("page_size") + wal;
  }

  private integrityOk(file: string): boolean {
    let copy: Database | null = null;
    try {
      copy = new Database(file, { readonly: true });
      const rows = copy.query("pragma integrity_check").all();
      return (
        rows.length === 1 && (rows[0] as { integrity_check?: string }).integrity_check === "ok"
      );
    } catch {
      return false;
    } finally {
      try {
        copy?.close();
      } catch {
        // ignore
      }
    }
  }

  /** Deletes only `BACKUP_NAME_RE` files beyond the newest `keep`. */
  private prune(keep: number, justWritten: string): number {
    let pruned = 0;
    const others = this.list().filter((e) => e.name !== justWritten);
    for (const e of others.slice(Math.max(0, keep - 1))) {
      try {
        unlinkSync(join(this.dir, e.name));
        pruned++;
      } catch {
        // best effort; the next run prunes again
      }
    }
    return pruned;
  }
}
