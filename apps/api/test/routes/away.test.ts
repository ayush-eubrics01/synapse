import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AIProvider, AwayDigest, DashboardOverview } from "@synapse/contracts";
import { schema } from "@synapse/database";
import { createApp } from "../../src/app";
import { type Container, createContainer } from "../../src/container";
import { loadConfig } from "../../src/core/config/config";

const fakeProvider: AIProvider = {
  execute: async () => {
    throw new Error("fake provider must not execute");
  },
  getHealth: async () => ({ status: "ok", version: "fake" }),
};
const NOW = "2026-11-06T12:00:00.000Z";
const SELF = "USELF00001";

let c: Container;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  c = createContainer(loadConfig({ SYNAPSE_DB_PATH: ":memory:" }), {
    run: async () => "Linger=no",
    provider: fakeProvider,
    clock: { now: () => new Date(NOW) },
  });
  app = createApp(c);
});
afterEach(() => c.sqlite.close());

const call = (path: string, init?: RequestInit) =>
  app.request(`http://127.0.0.1:7400${path}`, init);
const put = (body: unknown) =>
  call("/api/away", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("away routes", () => {
  test("GET /api/away is off with no session", async () => {
    const r = await call("/api/away");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ on: false, sessionId: null, startedAt: null });
  });

  test("PUT toggles on and off, idempotently", async () => {
    const on = (await (await put({ on: true })).json()) as { on: boolean; sessionId: string };
    expect(on.on).toBe(true);
    expect(on.sessionId).toBeTruthy();
    const again = (await (await put({ on: true })).json()) as { sessionId: string };
    expect(again.sessionId).toBe(on.sessionId);
    expect(await (await call("/api/away")).json()).toMatchObject({ on: true });
    const off = (await (await put({ on: false })).json()) as {
      on: boolean;
      sessionId: null;
      startedAt: null;
    };
    expect(off).toEqual({ on: false, sessionId: null, startedAt: null });
  });

  test("PUT with a bad body is 400 and changes nothing", async () => {
    expect((await put({ on: "yes" })).status).toBe(400);
    expect((await put({})).status).toBe(400);
    expect((await put(null)).status).toBe(400);
    expect(await (await call("/api/away")).json()).toMatchObject({ on: false });
  });

  test("digest is null until a session ends; then it shows and dismisses", async () => {
    expect(await (await call("/api/away/digest")).json()).toBeNull();
    const { sessionId } = (await (await put({ on: true })).json()) as { sessionId: string };
    expect(await (await call("/api/away/digest")).json()).toBeNull();
    await put({ on: false });
    const d = (await (await call("/api/away/digest")).json()) as AwayDigest;
    expect(d.session.id).toBe(sessionId);
    expect(d.sent).toEqual([]);
    expect(d.held).toEqual([]);
    const r = await call(`/api/away/digest/${sessionId}/dismiss`, { method: "POST" });
    expect(r.status).toBe(204);
    expect(await (await call("/api/away/digest")).json()).toBeNull();
  });

  test("dismiss of an unknown or still-open session is 404", async () => {
    expect((await call("/api/away/digest/nope/dismiss", { method: "POST" })).status).toBe(404);
    const { sessionId } = (await (await put({ on: true })).json()) as { sessionId: string };
    expect((await call(`/api/away/digest/${sessionId}/dismiss`, { method: "POST" })).status).toBe(
      404,
    );
  });
});

describe("dashboard overview away field", () => {
  const overview = async () =>
    (await (await call("/api/dashboard/overview")).json()) as DashboardOverview;

  test("off with zero priority people on an empty database", async () => {
    expect((await overview()).away).toEqual({ on: false, highPriorityCount: 0 });
  });

  test("counts high and critical people, excluding self and normal", async () => {
    c.settings.set("slack.selfUserId", SELF);
    for (const [id, ext] of [
      ["u-self", SELF],
      ["u-a", "UA00000001"],
      ["u-b", "UB00000001"],
      ["u-c", "UC00000001"],
    ] as const) {
      c.db.insert(schema.slackUsers).values({ id, externalId: ext, name: id }).run();
    }
    c.people.setPriority(SELF, { priority: "critical" });
    c.people.setPriority("UA00000001", { priority: "high" });
    c.people.setPriority("UB00000001", { priority: "critical" });
    c.people.setPriority("UC00000001", { priority: "normal" });
    c.autoReply.setAway(true);
    expect((await overview()).away).toEqual({ on: true, highPriorityCount: 2 });
  });
});
