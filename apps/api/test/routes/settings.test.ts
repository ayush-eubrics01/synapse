import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AIProvider } from "@synapse/contracts";
import { schema } from "@synapse/database";
import { createApp } from "../../src/app";
import { type Container, createContainer } from "../../src/container";
import { loadConfig } from "../../src/core/config/config";
import { USER_EDITABLE_SETTINGS } from "../../src/core/config/settings";

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
    clock: { now: () => new Date("2026-11-06T12:00:00.000Z") },
  });
  app = createApp(c);
});
afterEach(() => c.sqlite.close());

const put = (body: unknown) =>
  app.request("http://127.0.0.1:7400/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const audits = () =>
  c.db
    .select()
    .from(schema.auditEvents)
    .all()
    .filter((a) => a.action === "settings.updated");

describe("settings routes", () => {
  test("GET returns exactly the user-editable keys", async () => {
    const r = await app.request("http://127.0.0.1:7400/api/settings");
    expect(r.status).toBe(200);
    const body = (await r.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([...USER_EDITABLE_SETTINGS].sort());
    expect(body["codeAnswer.away.autoSend"]).toBe(false);
    expect(body).not.toHaveProperty("claudeActivity.lastActiveState");
    expect(body["ops.backup.enabled"]).toBe(true);
    expect(body["retention.auditDays"]).toBe(365);
    expect(body["retention.snapshotsDays"]).toBe(30);
    expect(body).not.toHaveProperty("ops.backup.dir");
    expect(body["engineering.sandbox.enabled"]).toBe(true);
  });

  test("GET includes the away-reply defaults", async () => {
    const body = (await (await app.request("http://127.0.0.1:7400/api/settings")).json()) as Record<
      string,
      unknown
    >;
    expect(body["autoReply.allowedKinds"]).toEqual([
      "code_answer",
      "stalled_reminder",
      "followup_question",
      "acknowledgement",
    ]);
    expect(body["autoReply.maxPerPersonPerDay"]).toBe(3);
    expect(body["autoReply.minMinutesBetweenInThread"]).toBe(30);
    expect(body["autoReply.minConfidence"]).toBe(0.75);
    expect(body["autoReply.maxSendDelayMinutes"]).toBe(15);
    expect(body).not.toHaveProperty("autoReply.awayMode");
  });

  test("away-reply limits reject looser or invalid values (ADR-033)", async () => {
    const bad: Record<string, unknown>[] = [
      { "autoReply.maxPerPersonPerDay": 4 },
      { "autoReply.maxPerPersonPerDay": -1 },
      { "autoReply.minMinutesBetweenInThread": 29 },
      { "autoReply.minConfidence": 0.7 },
      { "autoReply.maxSendDelayMinutes": 16 },
      { "autoReply.maxSendDelayMinutes": 0 },
      { "autoReply.allowedKinds": ["bogus"] },
      { "autoReply.allowedKinds": ["acknowledgement", "acknowledgement"] },
      { "autoReply.awayMode": true },
    ];
    for (const b of bad) {
      const r = await put(b);
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: string }).error).toBe("invalid_setting");
    }
    expect(audits()).toHaveLength(0);
  });

  test("maxPerPersonPerDay 0 and an empty kind list are accepted and audited by key", async () => {
    const r = await put({ "autoReply.maxPerPersonPerDay": 0, "autoReply.allowedKinds": [] });
    expect(r.status).toBe(200);
    const rows = audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.details).toEqual({
      keys: ["autoReply.maxPerPersonPerDay", "autoReply.allowedKinds"],
    });
  });

  test("retention.snapshotsDays is bounded 7..365", async () => {
    const bad = await put({ "retention.snapshotsDays": 6 });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe("invalid_setting");
    expect((await put({ "retention.snapshotsDays": 60 })).status).toBe(200);
  });

  test("the test sandbox setting can be turned off (ADR-040)", async () => {
    const r = await put({ "engineering.sandbox.enabled": false });
    expect(r.status).toBe(200);
    expect(((await r.json()) as Record<string, unknown>)["engineering.sandbox.enabled"]).toBe(
      false,
    );
    expect(c.settings.get("engineering.sandbox.enabled")).toBe(false);
  });

  test("PUT stores the value, audits the keys and returns the new values", async () => {
    const r = await put({ "codeAnswer.away.autoSend": true });
    expect(r.status).toBe(200);
    expect(((await r.json()) as Record<string, unknown>)["codeAnswer.away.autoSend"]).toBe(true);
    expect(c.settings.get("codeAnswer.away.autoSend")).toBe(true);
    const rows = audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor).toBe("user");
    expect(rows[0]?.details).toEqual({ keys: ["codeAnswer.away.autoSend"] });
  });

  test.each([
    [{ "claudeActivity.projectsDir": "/x" }],
    [{ "slack.selfUserId": "U1" }],
    [{ "claudeActivity.lastActiveState": true }],
    [{ "codeAnswer.maxTurns": 99 }],
    [{ "codeAnswer.model": "gpt" }],
    [{ "ops.backup.keep": 0 }],
    [{ "ops.backup.dir": "/tmp/x" }],
    [{ "ops.backup.lastRunDate": "2026-11-07" }],
    [{ "ops.retention.lastRun": null }],
    [{ "engineering.sandbox.enabled": "no" }],
    [["codeAnswer.maxTurns"]],
    [null],
  ])("PUT %j is 400 invalid_setting and changes nothing", async (body) => {
    const r = await put(body);
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "invalid_setting" });
    expect(audits()).toHaveLength(0);
  });

  test("a bad value in a mixed PUT applies none of it", async () => {
    const r = await put({ "codeAnswer.away.autoSend": true, "codeAnswer.maxTurns": 99 });
    expect(r.status).toBe(400);
    expect(c.settings.get("codeAnswer.away.autoSend")).toBe(false);
  });

  test("malformed JSON is 400", async () => {
    const r = await app.request("http://127.0.0.1:7400/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(r.status).toBe(400);
  });
});
