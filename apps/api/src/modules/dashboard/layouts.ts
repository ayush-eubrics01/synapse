import {
  type DashboardLayout,
  type DashboardLayoutSummary,
  type DashboardLayoutsResponse,
  type DashboardLayoutView,
  MAX_DASHBOARD_LAYOUTS,
} from "@synapse/contracts";
import { type Db, type DbOrTx, schema } from "@synapse/database";
import { type Clock, isoNow, newId } from "@synapse/shared";
import { asc, eq, sql } from "drizzle-orm";
import type { AuditLogger } from "../../core/audit/audit";
import type { EventPublisher } from "../../core/events/publisher";
import { defaultLayout, LayoutError, normaliseLayout } from "./layout";

const MODULE = "dashboard";
const { dashboardLayouts: t } = schema;

export interface DashboardLayoutServiceDeps {
  db: Db;
  clock: Clock;
  audit: Pick<AuditLogger, "record">;
  events: Pick<EventPublisher, "publish">;
}

type Row = { id: string; name: string; isActive: boolean; layout: string; updatedAt: string };
type Action = "created" | "updated" | "activated" | "reset" | "deleted";

export class DashboardLayoutService {
  constructor(private readonly deps: DashboardLayoutServiceDeps) {}

  list(): DashboardLayoutsResponse {
    const { db } = this.deps;
    return db.transaction(
      (tx) => {
        let rows = this.rows(tx);
        if (rows.length === 0) {
          const id = this.insert(tx, "Default", defaultLayout(), true);
          this.emit(tx, "system", "created", id);
          rows = this.rows(tx);
        } else if (!rows.some((r) => r.isActive)) {
          const latest = [...rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] as Row;
          tx.update(t).set({ isActive: true }).where(eq(t.id, latest.id)).run();
          this.emit(tx, "system", "activated", latest.id);
          rows = this.rows(tx);
        }
        const active = rows.find((r) => r.isActive) as Row;
        return { active: this.view(active), layouts: rows.map(summary) };
      },
      { behavior: "immediate" },
    );
  }

  create(name: string, fromId?: string): DashboardLayoutView {
    return this.write("created", (tx) => {
      const rows = this.rows(tx);
      let source: Row | undefined;
      if (fromId !== undefined) {
        source = rows.find((r) => r.id === fromId);
        if (!source) throw new LayoutError("not_found");
      } else {
        source = rows.find((r) => r.isActive);
      }
      if (rows.length >= MAX_DASHBOARD_LAYOUTS) throw new LayoutError("limit_reached");
      this.assertNameFree(rows, name);
      const layout = source ? this.view(source).layout : defaultLayout();
      return this.insert(tx, name, layout, rows.length === 0);
    });
  }

  update(id: string, patch: { name?: string; layout?: unknown }): DashboardLayoutView {
    return this.write("updated", (tx) => {
      const rows = this.rows(tx);
      if (!rows.some((r) => r.id === id)) throw new LayoutError("not_found");
      const set: Partial<typeof t.$inferInsert> = {
        updatedAt: isoNow(this.deps.clock),
      };
      if (patch.name !== undefined) {
        this.assertNameFree(
          rows.filter((r) => r.id !== id),
          patch.name,
        );
        set.name = patch.name;
      }
      if (patch.layout !== undefined) set.layout = normaliseLayout(patch.layout);
      tx.update(t).set(set).where(eq(t.id, id)).run();
      return id;
    });
  }

  activate(id: string): DashboardLayoutView {
    return this.write("activated", (tx) => {
      if (!this.rows(tx).some((r) => r.id === id)) throw new LayoutError("not_found");
      tx.update(t).set({ isActive: false }).where(eq(t.isActive, true)).run();
      tx.update(t)
        .set({ isActive: true, updatedAt: isoNow(this.deps.clock) })
        .where(eq(t.id, id))
        .run();
      return id;
    });
  }

  reset(id: string): DashboardLayoutView {
    return this.write("reset", (tx) => {
      if (!this.rows(tx).some((r) => r.id === id)) throw new LayoutError("not_found");
      tx.update(t)
        .set({ layout: defaultLayout(), updatedAt: isoNow(this.deps.clock) })
        .where(eq(t.id, id))
        .run();
      return id;
    });
  }

  remove(id: string): void {
    this.deps.db.transaction(
      (tx) => {
        const rows = this.rows(tx);
        const row = rows.find((r) => r.id === id);
        if (rows.length === 1 && row) throw new LayoutError("last_layout");
        if (row?.isActive) throw new LayoutError("active_layout");
        if (!row) throw new LayoutError("not_found");
        tx.delete(t).where(eq(t.id, id)).run();
        this.emit(tx, "user", "deleted", id);
      },
      { behavior: "immediate" },
    );
  }

  private write(action: Action, fn: (tx: DbOrTx) => string): DashboardLayoutView {
    return this.deps.db.transaction(
      (tx) => {
        const id = fn(tx);
        this.emit(tx, "user", action, id);
        return this.view(this.rows(tx).find((r) => r.id === id) as Row);
      },
      { behavior: "immediate" },
    );
  }

  private insert(tx: DbOrTx, name: string, layout: DashboardLayout, isActive: boolean): string {
    const id = newId();
    const now = isoNow(this.deps.clock);
    tx.insert(t).values({ id, name, isActive, layout, createdAt: now, updatedAt: now }).run();
    return id;
  }

  private assertNameFree(rows: Row[], name: string): void {
    const lower = name.toLowerCase();
    if (rows.some((r) => r.name.toLowerCase() === lower)) throw new LayoutError("name_taken");
  }

  /** The layout column is read as raw text so unparseable JSON cannot throw. */
  private rows(tx: DbOrTx): Row[] {
    return tx
      .select({
        id: t.id,
        name: t.name,
        isActive: t.isActive,
        layout: sql<string>`${t.layout}`,
        updatedAt: t.updatedAt,
      })
      .from(t)
      .orderBy(asc(t.createdAt), asc(t.id))
      .all();
  }

  private view(r: Row): DashboardLayoutView {
    let raw: unknown;
    try {
      raw = JSON.parse(r.layout);
    } catch {
      raw = undefined;
    }
    return { ...summary(r), layout: normaliseLayout(raw) };
  }

  private emit(tx: DbOrTx, actor: "user" | "system", action: Action, layoutId: string): void {
    const { audit, events } = this.deps;
    audit.record(tx, {
      actor,
      module: MODULE,
      action: `dashboard.layout_${action}`,
      result: "ok",
      details: { layoutId },
    });
    events.publish(tx, {
      type: "dashboard.layout_changed",
      aggregateType: "dashboard_layout",
      aggregateId: layoutId,
      correlationId: newId(),
      payload: { layoutId },
    });
  }
}

function summary(r: Row): DashboardLayoutSummary {
  return { id: r.id, name: r.name, isActive: r.isActive, updatedAt: r.updatedAt };
}
