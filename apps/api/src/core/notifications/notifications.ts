import { type Db, type DbOrTx, schema } from "@synapse/database";
import { type Clock, isoNow, newId } from "@synapse/shared";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { LiveBus } from "../events/live-bus";

export type Notification = typeof schema.notifications.$inferSelect;

export class NotificationService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly live: LiveBus,
  ) {}

  notify(
    tx: DbOrTx,
    n: {
      kind: string;
      severity: "info" | "warning" | "high";
      title: string;
      body?: string;
      ref?: string;
    },
  ): string {
    const row = tx
      .insert(schema.notifications)
      .values({ id: newId(), ...n, createdAt: isoNow(this.clock) })
      .returning()
      .get();
    // Pushed right after the insert. When the caller owns the transaction and later rolls it
    // back, a notification may have been pushed for a row that never committed; Phase 1
    // accepts that.
    this.live.publish({ type: "notification", data: row });
    return row.id;
  }

  list(opts: { unreadOnly?: boolean; limit?: number } = {}): Notification[] {
    return this.db
      .select()
      .from(schema.notifications)
      .where(opts.unreadOnly ? isNull(schema.notifications.readAt) : undefined)
      .orderBy(desc(schema.notifications.createdAt), desc(schema.notifications.id))
      .limit(opts.limit ?? 100)
      .all();
  }

  markRead(id: string): void {
    this.db
      .update(schema.notifications)
      .set({ readAt: isoNow(this.clock) })
      .where(and(eq(schema.notifications.id, id), isNull(schema.notifications.readAt)))
      .run();
  }
}
