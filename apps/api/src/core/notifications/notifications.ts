import type { DesktopNotifier } from "@synapse/contracts";
import { type Db, type DbOrTx, schema } from "@synapse/database";
import { type Clock, isoNow, newId } from "@synapse/shared";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { SettingsService } from "../config/settings";
import type { LiveBus } from "../events/live-bus";

const RANK = { info: 0, warning: 1, high: 2 } as const;

export type Notification = typeof schema.notifications.$inferSelect;

export class NotificationService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly live: LiveBus,
    /** Optional: without it only the in-app row is written. */
    private readonly desktop?: { notifier: DesktopNotifier; settings: SettingsService },
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
    this.queueDesktop(row.id, n.title, n.severity);
    return row.id;
  }

  /**
   * Callers write inside their own synchronous transaction, so there is no commit hook. The
   * desktop call is deferred to a macrotask (after the transaction has committed or rolled back),
   * re-checks that the row exists, and is fire-and-forget: it never throws or blocks the caller.
   */
  private queueDesktop(id: string, title: string, severity: "info" | "warning" | "high"): void {
    const desktop = this.desktop;
    if (!desktop) return;
    try {
      if (!desktop.settings.get("notifications.desktop.enabled")) return;
      if (RANK[severity] < RANK[desktop.settings.get("notifications.desktop.minSeverity")]) return;
    } catch {
      return;
    }
    setTimeout(() => {
      try {
        const row = this.db
          .select({ id: schema.notifications.id })
          .from(schema.notifications)
          .where(eq(schema.notifications.id, id))
          .get();
        if (!row) return; // the caller's transaction rolled back
        desktop.notifier.notify({ title, severity }).catch(() => {
          console.error("desktop notification failed");
        });
      } catch {
        // The database closed or the row check failed: nothing to announce, nothing to log.
      }
    }, 0);
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
