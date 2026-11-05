import type { Db } from "@synapse/database";
import type { AuditLogger } from "../../core/audit/audit";
import type { JobQueue } from "../../core/jobs/queue";
import type { SyncStateService } from "./sync-state";

export type SkipResult = { ok: true; checkpoint: string } | { ok: false; reason: string };

/** Slack ts string plus exactly one second, keeping the 6-digit fraction. */
export function addOneSecond(ts: string): string | null {
  const m = /^(\d+)\.(\d{6})$/.exec(ts);
  if (!m) return null;
  return `${Number(m[1]) + 1}.${m[2]}`;
}

/**
 * Q1: recovery for a fail-closed parse stall. Allowed only while the incremental stream's last
 * error is `parse_failed`: advances the checkpoint by 1 s, clears the error, audits (old and new
 * checkpoint only) and re-enqueues an incremental run. Never touches message content.
 */
export function skipUnreadablePage(deps: {
  db: Db;
  sync: SyncStateService;
  audit: AuditLogger;
  queue: JobQueue;
}): SkipResult {
  const { db, sync, audit, queue } = deps;
  return db.transaction(
    (tx) => {
      const cur = sync.get("slack.messages", tx);
      if (cur.lastError?.kind !== "parse_failed") {
        return { ok: false, reason: "no unreadable page to skip" } as const;
      }
      const next = cur.checkpoint === null ? null : addOneSecond(cur.checkpoint);
      if (cur.checkpoint === null || next === null) {
        return { ok: false, reason: "checkpoint is not a slack timestamp" } as const;
      }
      sync.update(tx, "slack.messages", { checkpoint: next, lastError: null });
      audit.record(tx, {
        actor: "user",
        module: "inbox",
        action: "slack.checkpoint_skipped",
        result: "ok",
        details: { from: cur.checkpoint, to: next },
      });
      queue.enqueue(tx, {
        type: "slack.collect_incremental",
        idempotencyKey: `skip:slack.collect_incremental:${next}`,
      });
      return { ok: true, checkpoint: next } as const;
    },
    { behavior: "immediate" },
  );
}
