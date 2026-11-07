import type { Database } from "bun:sqlite";
import type { RetentionSummary } from "@synapse/contracts";
import type { Db } from "@synapse/database";
import { type Clock, isoNow } from "@synapse/shared";
import type { AuditLogger } from "../audit/audit";
import type { SettingsService } from "../config/settings";
import type { DatabaseIntegrity } from "./integrity";

export const RETENTION_BATCH = 500;
export const OUTBOX_RETENTION_DAYS = 7;

export interface RetentionDeps {
  db: Db;
  sqlite: Database;
  clock: Clock;
  settings: SettingsService;
  audit: AuditLogger;
  integrity: DatabaseIntegrity;
  batchSize?: number;
  yieldFn?: () => Promise<void>;
}

const DAY_MS = 86_400_000;
const defaultYield = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Operational retention (R4). Deletes only rows nothing depends on, in batches of ids with one
 * immediate transaction per batch so the API stays responsive. Approvals, outgoing messages,
 * auto-replies, security flags, engineering tasks and commitments are never touched.
 */
export class RetentionService {
  private signal: AbortSignal | undefined;

  constructor(private readonly d: RetentionDeps) {}

  /**
   * With an aborted `signal` the run stops cleanly after the current batch: the partial counts are
   * audited (result `aborted`) and `ops.retention.lastRun` is not set, so the next run resumes.
   */
  async run(date: string, signal?: AbortSignal): Promise<RetentionSummary> {
    this.signal = signal;
    const { settings, clock } = this.d;
    const cutoff = (days: number) => new Date(clock.now().getTime() - days * DAY_MS).toISOString();

    const jobs = await this.prune(
      `select id from jobs where status in ('COMPLETED','CANCELLED','FAILED')
         and coalesce(finished_at, created_at) < ? limit ?`,
      cutoff(settings.get("retention.jobsDays")),
      (ids) => [
        `delete from job_checkpoints where job_id in ${ids}`,
        `delete from job_attempts where job_id in ${ids}`,
        `update claude_runs set job_id = null where job_id in ${ids}`,
        `delete from jobs where id in ${ids}`,
      ],
    );
    const notifications = await this.prune(
      "select id from notifications where read_at is not null and created_at < ? limit ?",
      cutoff(settings.get("retention.notificationsDays")),
      (ids) => [`delete from notifications where id in ${ids}`],
    );
    const events = await this.prune(
      `select e.id from domain_events e where e.dispatched_at is not null and e.dispatched_at < ?
         and not exists (select 1 from event_consumptions c where c.event_id = e.id and c.status <> 'done')
         limit ?`,
      cutoff(OUTBOX_RETENTION_DAYS),
      (ids) => [
        `delete from event_consumptions where event_id in ${ids}`,
        `delete from domain_events where id in ${ids}`,
      ],
    );
    const audit = await this.prune(
      "select id from audit_events where occurred_at < ? limit ?",
      cutoff(settings.get("retention.auditDays")),
      (ids) => [`delete from audit_events where id in ${ids}`],
    );
    const claudeRunsCompacted = await this.prune(
      `select id from claude_runs where started_at < ?
         and (permission_denials is not null or json_extract(error, '$.message') is not null) limit ?`,
      cutoff(settings.get("retention.claudeRunsDays")),
      (ids) => [
        `update claude_runs set permission_denials = null,
           error = case when error is null then null
                        else json_object('kind', json_extract(error, '$.kind')) end
         where id in ${ids}`,
      ],
    );
    const snapshotCutoff = cutoff(settings.get("retention.snapshotsDays"));
    const newest = (t: string) =>
      `select id from ${t} where observed_at < ?
         and id <> (select id from ${t} order by observed_at desc, rowid desc limit 1) limit ?`;
    const quotaSnapshots = await this.prune(newest("quota_snapshots"), snapshotCutoff, (ids) => [
      `delete from quota_snapshots where id in ${ids}`,
    ]);
    const authSnapshots = await this.prune(newest("auth_snapshots"), snapshotCutoff, (ids) => [
      `delete from auth_snapshots where id in ${ids}`,
    ]);

    const aborted = signal?.aborted === true;
    this.d.sqlite.exec("pragma wal_checkpoint(PASSIVE)");
    this.d.sqlite.exec("pragma optimize");
    const quickCheck = await this.d.integrity.check();

    const summary: RetentionSummary = {
      at: isoNow(clock),
      date,
      jobs,
      notifications,
      events,
      audit,
      claudeRunsCompacted,
      quickCheck,
      quotaSnapshots,
      authSnapshots,
    };
    this.d.audit.record(this.d.db, {
      actor: "system",
      module: "ops",
      action: "ops.retention_ran",
      result: aborted ? "aborted" : quickCheck === "ok" ? "ok" : "failed",
      details: {
        jobs,
        notifications,
        events,
        audit,
        claudeRunsCompacted,
        quickCheck,
        quotaSnapshots,
        authSnapshots,
      },
    });
    if (!aborted) settings.set("ops.retention.lastRun", summary, { emit: false });
    return summary;
  }

  /** Selects up to `batchSize` ids, applies the statements to them, and repeats until none match. */
  private async prune(
    select: string,
    cutoff: string,
    statements: (ids: string) => string[],
  ): Promise<number> {
    const { sqlite } = this.d;
    const size = this.d.batchSize ?? RETENTION_BATCH;
    const yieldFn = this.d.yieldFn ?? defaultYield;
    let total = 0;
    if (this.signal?.aborted) return total;
    for (;;) {
      const batch = sqlite
        .transaction(() => {
          const ids = (sqlite.query(select).all(cutoff, size) as { id: string }[]).map((r) => r.id);
          if (ids.length === 0) return 0;
          const list = `(${ids.map(() => "?").join(",")})`;
          for (const sql of statements(list)) sqlite.query(sql).run(...ids);
          return ids.length;
        })
        .immediate();
      if (batch === 0) return total;
      total += batch;
      await yieldFn();
      if (this.signal?.aborted) return total;
    }
  }
}
