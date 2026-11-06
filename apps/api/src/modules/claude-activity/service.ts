/**
 * Claude Code activity (ADR-036, A3–A8): incremental metadata scan of interactive session
 * files, the `UserActivitySignal` port, and health. Privacy: only ids, counts and fixed codes
 * leave this module; no title, branch, path or cwd is logged, audited, published or thrown.
 */
import { realpathSync } from "node:fs";
import {
  CLAUDE_ACTIVITY_FORMAT_MESSAGE,
  type ClaudeActivityHealth,
  type UserActivitySignal,
} from "@synapse/contracts";
import { type Db, schema } from "@synapse/database";
import { type Clock, newId } from "@synapse/shared";
import { eq, max } from "drizzle-orm";
import type { AuditLogger } from "../../core/audit/audit";
import type { SettingsService } from "../../core/config/settings";
import type { EventPublisher } from "../../core/events/publisher";
import {
  type CandidateFile,
  defaultFsOps,
  type FsOps,
  listCandidateFiles,
  ProjectsDirUnreadable,
  readNewLines,
  SessionFileUnreadable,
} from "./scanner";
import { foldMeta, MAX_CHUNK_BYTES, type SessionAccum } from "./session-meta";

const { claudeSessions, claudeSessionPrs, repositories } = schema;

export const SCAN_BUDGET_MS = 20_000;
const MODULE = "claude-activity";
const UNREADABLE_DETAIL = "projects dir unreadable";

export interface ScanSummary {
  files: number;
  sessionsUpserted: number;
  prsInserted: number;
  skippedUnchanged: number;
  ignored: number;
  parseErrors: number;
  oversized: number;
  timedOut: boolean;
}

const emptySummary = (): ScanSummary => ({
  files: 0,
  sessionsUpserted: 0,
  prsInserted: 0,
  skippedUnchanged: 0,
  ignored: 0,
  parseErrors: 0,
  oversized: 0,
  timedOut: false,
});

export interface ClaudeActivityServiceDeps {
  db: Db;
  clock: Clock;
  settings: SettingsService;
  events: Pick<EventPublisher, "publish">;
  audit: Pick<AuditLogger, "record">;
  projectsDir: string;
  fs?: FsOps;
  monotonicMs?: () => number;
  realpath?: (p: string) => string | null;
}

function defaultRealpath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

function stripSlashes(p: string): string {
  const s = p.replace(/\/+$/, "");
  return s === "" && p.startsWith("/") ? "/" : s;
}

/** A4: the repository whose `local_path` equals the cwd or contains it. Siblings never match. */
export function repositoryForCwd(
  cwd: string,
  repos: { id: string; localPath: string }[],
  realpath: (p: string) => string | null,
): string | null {
  const c = stripSlashes(realpath(cwd) ?? cwd);
  for (const r of repos) {
    const p = stripSlashes(r.localPath);
    if (c === p || c.startsWith(`${p}/`)) return r.id;
  }
  return null;
}

export class ClaudeActivityService implements UserActivitySignal {
  private readonly fs: FsOps;
  private readonly monotonicMs: () => number;
  private readonly realpath: (p: string) => string | null;
  private readonly ignored = new Map<string, { size: number; mtimeMs: number }>();
  private reposKey = "";
  private scanning = false;
  private unreadable = false;
  private formatDegraded = false;

  constructor(private readonly deps: ClaudeActivityServiceDeps) {
    this.fs = deps.fs ?? defaultFsOps;
    this.monotonicMs = deps.monotonicMs ?? (() => performance.now());
    this.realpath = deps.realpath ?? defaultRealpath;
  }

  private get enabled(): boolean {
    return this.deps.settings.get("claudeActivity.enabled");
  }

  async scan(): Promise<ScanSummary> {
    const summary = emptySummary();
    if (!this.enabled || this.scanning) return summary;
    this.scanning = true;
    try {
      await this.scanInner(summary);
    } finally {
      this.scanning = false;
    }
    return summary;
  }

  private async scanInner(summary: ScanSummary): Promise<void> {
    const { db, clock } = this.deps;
    const repos = db
      .select({ id: repositories.id, localPath: repositories.localPath })
      .from(repositories)
      .all();
    const key = repos
      .map((r) => r.localPath)
      .sort()
      .join("\n");
    if (key !== this.reposKey) {
      this.ignored.clear();
      this.reposKey = key;
    }
    const startedAt = this.monotonicMs();
    let candidates: CandidateFile[];
    try {
      candidates = await listCandidateFiles(
        this.deps.projectsDir,
        repos.map((r) => r.localPath),
        this.fs,
      );
    } catch (e) {
      if (e instanceof ProjectsDirUnreadable) {
        this.unreadable = true;
        return;
      }
      throw e;
    }
    this.unreadable = false;
    const stored = new Map(
      db
        .select()
        .from(claudeSessions)
        .all()
        .map((r) => [r.filePath, r]),
    );
    let lines = 0;
    let known = 0;
    for (const file of candidates) {
      if (this.monotonicMs() - startedAt >= SCAN_BUDGET_MS) {
        summary.timedOut = true;
        break;
      }
      summary.files++;
      const row = stored.get(file.path);
      const sameStat = (s: { size: number; mtimeMs: number }) =>
        s.size === file.size && s.mtimeMs === file.mtimeMs;
      if (
        row &&
        sameStat({ size: row.fileSize, mtimeMs: row.fileMtimeMs }) &&
        file.size - row.fileOffset < MAX_CHUNK_BYTES
      ) {
        summary.skippedUnchanged++;
        continue;
      }
      const ign = this.ignored.get(file.path);
      if (!row && ign && sameStat(ign)) {
        summary.ignored++;
        continue;
      }
      // A4: a file that shrank below the stored offset was rewritten; start over.
      const reset = !row || file.size < row.fileOffset;
      const from = reset ? 0 : (row as NonNullable<typeof row>).fileOffset;
      let res: Awaited<ReturnType<typeof readNewLines>>;
      try {
        res = await readNewLines(file, from, this.fs);
      } catch (e) {
        if (e instanceof SessionFileUnreadable) continue;
        throw e;
      }
      lines += res.lines;
      known += res.known;
      summary.parseErrors += res.parseErrors;
      summary.oversized += res.oversized;
      const prev: SessionAccum | null =
        row && !reset
          ? {
              cwd: row.cwd,
              gitBranch: row.gitBranch,
              title: row.title,
              firstAt: row.firstAt,
              lastAt: row.lastAt,
              version: row.version,
              entrypoint: row.entrypoint,
              prs: [],
            }
          : null;
      const nowMs = clock.now().getTime();
      const acc = foldMeta(prev, res.deltas, nowMs);
      if (acc.cwd === null) continue; // nothing stored; re-read from 0 next scan
      let repositoryId: string | null;
      if (row) repositoryId = row.repositoryId;
      else {
        repositoryId = repositoryForCwd(acc.cwd, repos, this.realpath);
        if (repositoryId === null) {
          this.ignored.set(file.path, { size: file.size, mtimeMs: file.mtimeMs });
          summary.ignored++;
          continue;
        }
      }
      const lastMs = Math.max(
        acc.lastAt ? Date.parse(acc.lastAt) : Number.NEGATIVE_INFINITY,
        Math.min(file.mtimeMs, nowMs),
      );
      const lastAt = new Date(lastMs).toISOString();
      const firstAt = acc.firstAt ?? lastAt;
      const nowIso = clock.now().toISOString();
      const values = {
        repositoryId,
        cwd: acc.cwd,
        gitBranch: acc.gitBranch,
        title: acc.title,
        firstAt,
        lastAt,
        version: acc.version,
        entrypoint: acc.entrypoint,
        filePath: file.path,
        fileOffset: res.consumedTo,
        fileSize: file.size,
        fileMtimeMs: file.mtimeMs,
        updatedAt: nowIso,
      };
      const repoId = repositoryId;
      db.transaction(
        (tx) => {
          tx.insert(claudeSessions)
            .values({ sessionId: file.sessionId, ...values })
            .onConflictDoUpdate({ target: claudeSessions.sessionId, set: values })
            .run();
          for (const p of acc.prs) {
            const exists = tx
              .select({ id: claudeSessionPrs.id })
              .from(claudeSessionPrs)
              .where(eq(claudeSessionPrs.prUrl, p.url))
              .get();
            if (exists) continue;
            tx.insert(claudeSessionPrs)
              .values({
                id: newId(),
                sessionId: file.sessionId,
                repositoryId: repoId,
                prUrl: p.url,
                prNumber: p.number,
                prRepository: p.repository,
                gitBranch: p.branch,
                firstSeenAt: p.seenAt ?? nowIso,
              })
              .onConflictDoNothing({ target: claudeSessionPrs.prUrl })
              .run();
            summary.prsInserted++;
          }
        },
        { behavior: "immediate" },
      );
      summary.sessionsUpserted++;
    }
    if (lines > 0) this.formatDegraded = known === 0;
    else if (known > 0) this.formatDegraded = false;
    this.applyTransition();
  }

  private applyTransition(): void {
    const { db, clock, settings, events, audit } = this.deps;
    const active = this.isUserActive(clock.now()).active;
    if (active === settings.get("claudeActivity.lastActiveState")) return;
    settings.set("claudeActivity.lastActiveState", active);
    const lastActiveAt = this.lastActiveAt();
    db.transaction((tx) => {
      events.publish(tx, {
        type: "claude_session.activity_changed",
        aggregateType: "claude_activity",
        aggregateId: "user",
        correlationId: newId(),
        payload: { active, lastActiveAt },
      });
      audit.record(tx, {
        actor: "system",
        module: MODULE,
        action: active ? "claude_activity.active" : "claude_activity.idle",
        result: "ok",
        details: { lastActiveAt },
      });
    });
  }

  lastActiveAt(): string | null {
    const row = this.deps.db
      .select({ at: max(claudeSessions.lastAt) })
      .from(claudeSessions)
      .get();
    return row?.at ?? null;
  }

  isUserActive(now: Date): { active: boolean; until: string | null } {
    const last = this.lastActiveAt();
    if (last === null) return { active: false, until: null };
    const windowMs = this.deps.settings.get("claudeActivity.activeWindowMinutes") * 60_000;
    const untilMs = Date.parse(last) + windowMs;
    return {
      active: this.enabled && untilMs >= now.getTime(),
      until: new Date(untilMs).toISOString(),
    };
  }

  healthState(): ClaudeActivityHealth {
    if (!this.enabled) return { state: "disabled", message: null };
    if (this.unreadable) return { state: "degraded", message: UNREADABLE_DETAIL };
    if (this.formatDegraded) return { state: "degraded", message: CLAUDE_ACTIVITY_FORMAT_MESSAGE };
    return { state: "ok", message: null };
  }
}
