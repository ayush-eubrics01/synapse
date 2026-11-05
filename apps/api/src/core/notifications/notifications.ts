import type { DesktopNotifier } from "@synapse/contracts";
import { type Db, type DbOrTx, schema } from "@synapse/database";
import { type Clock, isoNow, newId } from "@synapse/shared";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { SettingsService } from "../config/settings";
import type { LiveBus } from "../events/live-bus";

const RANK = { info: 0, warning: 1, high: 2 } as const;
type Severity = keyof typeof RANK;

/** R15: at most this many desktop popups per rolling window; the rest collapse into one summary. */
export const DESKTOP_MAX_PER_WINDOW = 5;
export const DESKTOP_WINDOW_MS = 60_000;

export type Notification = typeof schema.notifications.$inferSelect;

export interface DesktopOptions {
  notifier: DesktopNotifier;
  settings: SettingsService;
  /** Timer for the summary popup; tests inject a fake. Defaults to an unref'd setTimeout. */
  schedule?: (fn: () => void, ms: number) => void;
}

const defaultSchedule = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms);
  (t as { unref?: () => void }).unref?.();
};

export class NotificationService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly live: LiveBus,
    /** Optional: without it only the in-app row is written. */
    private readonly desktop?: DesktopOptions,
  ) {}

  /** Desktop popups sent in the current rolling window (epoch ms), oldest first. */
  private sentAt: number[] = [];
  /** Popups held back while the window was full: collapsed into one summary popup. */
  private suppressed: { count: number; severity: Severity } | null = null;
  private summaryArmed = false;

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
  private queueDesktop(id: string, title: string, severity: Severity): void {
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
        this.deliver(desktop, title, severity);
      } catch {
        // The database closed or the row check failed: nothing to announce, nothing to log.
      }
    }, 0);
  }

  /**
   * R15 rate limit: at most DESKTOP_MAX_PER_WINDOW popups per rolling DESKTOP_WINDOW_MS. Further
   * ones (and everything after them until the summary goes out, so order is kept) collapse into a
   * single "Synapse: N more notifications" popup at the highest suppressed severity, sent when the
   * window frees. The in-app rows are unaffected.
   */
  private deliver(desktop: DesktopOptions, title: string, severity: Severity): void {
    this.prune();
    if (this.suppressed === null && this.sentAt.length < DESKTOP_MAX_PER_WINDOW) {
      this.send(desktop, title, severity);
      return;
    }
    const cur = this.suppressed;
    this.suppressed = {
      count: (cur?.count ?? 0) + 1,
      severity: cur && RANK[cur.severity] >= RANK[severity] ? cur.severity : severity,
    };
    this.flushSummary(desktop);
  }

  private flushSummary(desktop: DesktopOptions): void {
    this.prune();
    const pending = this.suppressed;
    if (pending === null) return;
    if (this.sentAt.length < DESKTOP_MAX_PER_WINDOW) {
      this.suppressed = null;
      this.send(desktop, `Synapse: ${pending.count} more notifications`, pending.severity);
      return;
    }
    if (this.summaryArmed) return;
    this.summaryArmed = true;
    const oldest = this.sentAt[0] ?? this.now();
    const wait = Math.max(0, oldest + DESKTOP_WINDOW_MS - this.now());
    (desktop.schedule ?? defaultSchedule)(() => {
      this.summaryArmed = false;
      try {
        this.flushSummary(desktop);
      } catch {
        // Never throw from a timer.
      }
    }, wait);
  }

  private send(desktop: DesktopOptions, title: string, severity: Severity): void {
    this.sentAt.push(this.now());
    desktop.notifier.notify({ title, severity }).catch(() => {
      console.error("desktop notification failed");
    });
  }

  private prune(): void {
    const floor = this.now() - DESKTOP_WINDOW_MS;
    while (this.sentAt.length > 0 && (this.sentAt[0] as number) <= floor) this.sentAt.shift();
  }

  private now(): number {
    return this.clock.now().getTime();
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
