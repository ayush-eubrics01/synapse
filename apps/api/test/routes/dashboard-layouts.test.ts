import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type AIProvider,
  DASHBOARD_SECTION_IDS,
  type DashboardLayoutsResponse,
  type DashboardLayoutView,
  DEFAULT_DASHBOARD_LAYOUT,
} from "@synapse/contracts";
import { schema } from "@synapse/database";
import { eq } from "drizzle-orm";
import { createApp } from "../../src/app";
import { type Container, createContainer } from "../../src/container";
import { loadConfig } from "../../src/core/config/config";

const fakeProvider: AIProvider = {
  execute: async () => {
    throw new Error("fake provider must not execute");
  },
  getHealth: async () => ({ status: "ok", version: "fake" }),
};

let c: Container;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  c = createContainer(loadConfig({ SYNAPSE_DB_PATH: ":memory:" }), {
    run: async () => "Linger=no",
    provider: fakeProvider,
    clock: { now: () => new Date("2026-11-07T12:00:00.000Z") },
  });
  app = createApp(c);
});
afterEach(() => c.sqlite.close());

const call = (method: string, path: string, body?: unknown) =>
  app.request(`http://127.0.0.1:7400/api/dashboard/layouts${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const list = async () => (await (await call("GET", "")).json()) as DashboardLayoutsResponse;
const post = async (name: string) => call("POST", "", { name });
const errorOf = async (r: Response) => ((await r.json()) as { error: string }).error;
const changed = () =>
  c.db
    .select()
    .from(schema.domainEvents)
    .where(eq(schema.domainEvents.type, "dashboard.layout_changed"))
    .all();

describe("dashboard layouts API", () => {
  test("first GET seeds one active Default (audited as system); second seeds nothing", async () => {
    const first = await list();
    expect(first.layouts).toHaveLength(1);
    expect(first.active.name).toBe("Default");
    expect(first.active.isActive).toBe(true);
    expect(first.active.layout).toEqual(DEFAULT_DASHBOARD_LAYOUT);
    const audits = c.db.select().from(schema.auditEvents).all();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor: "system",
      module: "dashboard",
      action: "dashboard.layout_created",
    });
    await list();
    expect(c.db.select().from(schema.dashboardLayouts).all()).toHaveLength(1);
    expect(c.db.select().from(schema.auditEvents).all()).toHaveLength(1);
  });

  test("POST copies the active layout; duplicate name is 409; empty name is 400", async () => {
    const before = await list();
    const r = await post("Focus");
    expect(r.status).toBe(201);
    const v = (await r.json()) as DashboardLayoutView;
    expect(v.layout).toEqual(before.active.layout);
    expect(v.isActive).toBe(false);
    const dup = await post("focus");
    expect(dup.status).toBe(409);
    expect(await errorOf(dup)).toBe("name_taken");
    const bad = await post("");
    expect(bad.status).toBe(400);
    expect(await errorOf(bad)).toBe("invalid_name");
    const unknownFrom = await call("POST", "", { name: "Other", fromId: "nope" });
    expect(unknownFrom.status).toBe(404);
  });

  test("the 11th layout is rejected with limit_reached", async () => {
    await list();
    for (let i = 0; i < 9; i++) expect((await post(`L${i}`)).status).toBe(201);
    const r = await post("L-extra");
    expect(r.status).toBe(409);
    expect(await errorOf(r)).toBe("limit_reached");
  });

  test("PUT normalises the layout; a bad shape is invalid_layout", async () => {
    const { active } = await list();
    const r = await call("PUT", `/${active.id}`, {
      layout: {
        version: 1,
        sections: [{ id: "triage", visible: false, collapsed: true, width: "half" }],
      },
    });
    expect(r.status).toBe(200);
    const v = (await r.json()) as DashboardLayoutView;
    expect(v.layout.sections).toHaveLength(DASHBOARD_SECTION_IDS.length);
    expect(v.layout.sections[0]).toEqual({
      id: "triage",
      visible: true,
      collapsed: false,
      width: "half",
    });
    const bad = await call("PUT", `/${active.id}`, {
      layout: { version: 1, sections: [{ id: "jira", width: "third" }] },
    });
    expect(bad.status).toBe(400);
    expect(await errorOf(bad)).toBe("invalid_layout");
  });

  test("activate leaves exactly one active; reset restores the default and keeps the name", async () => {
    await list();
    const focus = (await (await post("Focus")).json()) as DashboardLayoutView;
    const a = await call("POST", `/${focus.id}/activate`);
    expect(a.status).toBe(200);
    expect(((await a.json()) as DashboardLayoutView).isActive).toBe(true);
    const all = await list();
    expect(all.layouts.filter((l) => l.isActive)).toHaveLength(1);
    expect(all.active.id).toBe(focus.id);
    await call("PUT", `/${focus.id}`, {
      layout: {
        version: 1,
        sections: [{ id: "jira", visible: false, collapsed: true, width: "half" }],
      },
    });
    const r = await call("POST", `/${focus.id}/reset`);
    expect(r.status).toBe(200);
    const v = (await r.json()) as DashboardLayoutView;
    expect(v.name).toBe("Focus");
    expect(v.layout).toEqual(DEFAULT_DASHBOARD_LAYOUT);
  });

  test("DELETE guards: last_layout, active_layout, then 204; unknown id is 404", async () => {
    const { active } = await list();
    const only = await call("DELETE", `/${active.id}`);
    expect(only.status).toBe(409);
    expect(await errorOf(only)).toBe("last_layout");
    const focus = (await (await post("Focus")).json()) as DashboardLayoutView;
    const act = await call("DELETE", `/${active.id}`);
    expect(act.status).toBe(409);
    expect(await errorOf(act)).toBe("active_layout");
    expect((await call("DELETE", `/${focus.id}`)).status).toBe(204);
    const missing = await call("DELETE", "/nope");
    expect(missing.status).toBe(404);
    expect(await errorOf(missing)).toBe("not_found");
    expect((await call("PUT", "/nope", { name: "X" })).status).toBe(404);
    expect((await call("POST", "/nope/activate")).status).toBe(404);
    expect((await call("POST", "/nope/reset")).status).toBe(404);
  });

  test("each write publishes one layout_changed event; no name leaks into audit or events", async () => {
    await list(); // seed: 1 event
    const focus = (await (await post("Focus")).json()) as DashboardLayoutView; // 2
    await call("PUT", `/${focus.id}`, { name: "Focus 2" }); // 3
    await call("POST", `/${focus.id}/activate`); // 4
    await call("POST", `/${focus.id}/reset`); // 5
    const other = (await list()).layouts.find((l) => l.id !== focus.id);
    await call("DELETE", `/${other?.id}`); // 6
    const evs = changed();
    expect(evs).toHaveLength(6);
    for (const e of evs) {
      expect(Object.keys(e.payload as object)).toEqual(["layoutId"]);
      expect(e.aggregateType).toBe("dashboard_layout");
    }
    const dump = JSON.stringify([
      c.db
        .select()
        .from(schema.auditEvents)
        .all()
        .map((a) => a.details),
      evs.map((e) => e.payload),
    ]);
    expect(dump).not.toContain("Focus");
    const audits = c.db.select().from(schema.auditEvents).all();
    expect(audits.filter((a) => a.actor === "user")).toHaveLength(5);
  });

  test("a corrupt stored layout does not crash GET: it reads as the default", async () => {
    const { active } = await list();
    c.sqlite.run("UPDATE dashboard_layouts SET layout = ? WHERE id = ?", [
      '{"version":2}',
      active.id,
    ]);
    const r = await call("GET", "");
    expect(r.status).toBe(200);
    expect(((await r.json()) as DashboardLayoutsResponse).active.layout).toEqual(
      DEFAULT_DASHBOARD_LAYOUT,
    );
    c.sqlite.run("UPDATE dashboard_layouts SET layout = ? WHERE id = ?", ["not json{", active.id]);
    const r2 = await call("GET", "");
    expect(r2.status).toBe(200);
    expect(((await r2.json()) as DashboardLayoutsResponse).active.layout).toEqual(
      DEFAULT_DASHBOARD_LAYOUT,
    );
  });

  test("if no row is active the most recently updated one is activated", async () => {
    await list();
    const focus = (await (await post("Focus")).json()) as DashboardLayoutView;
    c.sqlite.run("UPDATE dashboard_layouts SET is_active = 0");
    c.sqlite.run(
      "UPDATE dashboard_layouts SET updated_at = '2030-01-01T00:00:00.000Z' WHERE id = ?",
      [focus.id],
    );
    const all = await list();
    expect(all.active.id).toBe(focus.id);
  });

  test("invalid JSON bodies and an empty PUT are 400 and write nothing", async () => {
    const { active } = await list();
    const auditBefore = c.db.select().from(schema.auditEvents).all().length;
    const eventsBefore = changed().length;
    const raw = (method: string, path: string) =>
      app.request(`http://127.0.0.1:7400/api/dashboard/layouts${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: "{not json",
      });
    const p = await raw("POST", "");
    expect(p.status).toBe(400);
    expect(await errorOf(p)).toBe("invalid_name");
    const u = await raw("PUT", `/${active.id}`);
    expect(u.status).toBe(400);
    expect(await errorOf(u)).toBe("invalid_layout");
    const empty = await call("PUT", `/${active.id}`, {});
    expect(empty.status).toBe(400);
    expect(await errorOf(empty)).toBe("invalid_layout");
    expect(c.db.select().from(schema.auditEvents).all()).toHaveLength(auditBefore);
    expect(changed()).toHaveLength(eventsBefore);
  });

  test("renaming onto another layout's name is name_taken", async () => {
    const { active } = await list();
    await post("Focus");
    const r = await call("PUT", `/${active.id}`, { name: "FOCUS" });
    expect(r.status).toBe(409);
    expect(await errorOf(r)).toBe("name_taken");
    expect((await call("PUT", `/${active.id}`, { name: "Default" })).status).toBe(200);
  });

  test("create with fromId copies that (non-active) layout", async () => {
    const { active } = await list();
    const focus = (await (await post("Focus")).json()) as DashboardLayoutView;
    await call("PUT", `/${focus.id}`, {
      layout: {
        version: 1,
        sections: [{ id: "jira", visible: false, collapsed: true, width: "half" }],
      },
    });
    const r = await call("POST", "", { name: "Copy", fromId: focus.id });
    expect(r.status).toBe(201);
    const v = (await r.json()) as DashboardLayoutView;
    expect(v.layout.sections[0]?.id).toBe("jira");
    expect(v.layout).not.toEqual(active.layout);
  });

  test("at the limit, limit_reached wins over name_taken", async () => {
    await list();
    for (let i = 0; i < 9; i++) await post(`L${i}`);
    const r = await post("L0");
    expect(r.status).toBe(409);
    expect(await errorOf(r)).toBe("limit_reached");
  });
});
