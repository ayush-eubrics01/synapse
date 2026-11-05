import type { ClassifiedError } from "@synapse/contracts";
import { type Db, type DbOrTx, schema } from "@synapse/database";
import { type Clock, newId } from "@synapse/shared";
import { and, eq } from "drizzle-orm";

export type SyncStream = "slack.messages" | "slack.backfill";
export type SyncStatus = "idle" | "running" | "paused" | "complete" | "error";

export interface SyncState {
  stream: SyncStream;
  checkpoint: string | null;
  upperBound: string | null;
  status: SyncStatus;
  pagesDone: number;
  lastSuccessAt: string | null;
  lastError: ClassifiedError | null;
  nextRunAfter: string | null;
  backoffMinutes: number;
  searchCount: number;
  searchCountDate: string | null;
}

const { integrations, integrationSyncStates } = schema;

export class SyncStateService {
  private integrationId: string | null = null;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  ensureIntegration(kind: "slack", adapter: "claude-connector"): string {
    this.db
      .insert(integrations)
      .values({ id: newId(), kind, adapter, createdAt: this.clock.now().toISOString() })
      .onConflictDoNothing({ target: [integrations.kind, integrations.adapter] })
      .run();
    const row = this.db
      .select({ id: integrations.id })
      .from(integrations)
      .where(and(eq(integrations.kind, kind), eq(integrations.adapter, adapter)))
      .get();
    if (!row) throw new Error("integration row vanished");
    this.integrationId = row.id;
    return row.id;
  }

  /** Reads (creating on first use) the stream's state. Pass `tx` to read inside a transaction. */
  get(stream: SyncStream, tx: DbOrTx = this.db): SyncState {
    const integrationId = this.integrationId ?? this.ensureIntegration("slack", "claude-connector");
    this.ensureRow(tx, integrationId, stream);
    const row = tx
      .select()
      .from(integrationSyncStates)
      .where(
        and(
          eq(integrationSyncStates.integrationId, integrationId),
          eq(integrationSyncStates.stream, stream),
        ),
      )
      .get();
    if (!row) throw new Error("sync state row vanished");
    return {
      stream,
      checkpoint: row.checkpoint,
      upperBound: row.upperBound,
      status: row.status,
      pagesDone: row.pagesDone,
      lastSuccessAt: row.lastSuccessAt,
      lastError: (row.lastError as ClassifiedError | null) ?? null,
      nextRunAfter: row.nextRunAfter,
      backoffMinutes: row.backoffMinutes,
      searchCount: row.searchCount,
      searchCountDate: row.searchCountDate,
    };
  }

  update(tx: DbOrTx, stream: SyncStream, patch: Partial<SyncState>): void {
    const integrationId = this.integrationId ?? this.ensureIntegration("slack", "claude-connector");
    this.ensureRow(tx, integrationId, stream);
    const { stream: _ignored, ...fields } = patch;
    const set = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    if (Object.keys(set).length === 0) return;
    tx.update(integrationSyncStates)
      .set(set)
      .where(
        and(
          eq(integrationSyncStates.integrationId, integrationId),
          eq(integrationSyncStates.stream, stream),
        ),
      )
      .run();
  }

  /** Adds `n` searches to today's (UTC) count, resetting on a new day; returns today's count. */
  countSearches(tx: DbOrTx, stream: SyncStream, n: number): number {
    const today = this.clock.now().toISOString().slice(0, 10);
    const state = this.get(stream, tx);
    const count = (state.searchCountDate === today ? state.searchCount : 0) + n;
    this.update(tx, stream, { searchCount: count, searchCountDate: today });
    return count;
  }

  private ensureRow(tx: DbOrTx, integrationId: string, stream: SyncStream): void {
    tx.insert(integrationSyncStates)
      .values({ id: newId(), integrationId, stream, status: "idle" })
      .onConflictDoNothing({
        target: [integrationSyncStates.integrationId, integrationSyncStates.stream],
      })
      .run();
  }
}
