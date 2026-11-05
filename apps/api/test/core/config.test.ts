import { expect, test } from "bun:test";
import { homedir } from "node:os";
import type { NewDomainEvent } from "@synapse/contracts";
import { type DbOrTx, openDatabase, runMigrations, schema } from "@synapse/database";
import { FakeClock, isoNow, newId } from "@synapse/shared";
import { eq } from "drizzle-orm";
import { loadConfig, resolveHome } from "../../src/core/config/config";
import { SettingsService } from "../../src/core/config/settings";

function setup() {
  const { db } = openDatabase(":memory:");
  runMigrations(db);
  const clock = new FakeClock("2026-01-01T00:00:00.000Z");
  const publish = (tx: DbOrTx, e: NewDomainEvent<"settings.changed">): string => {
    const id = newId();
    tx.insert(schema.domainEvents)
      .values({
        id,
        type: e.type,
        aggregateType: e.aggregateType,
        aggregateId: e.aggregateId,
        correlationId: e.correlationId,
        payload: e.payload,
        occurredAt: isoNow(clock),
      })
      .run();
    return id;
  };
  return { db, settings: new SettingsService(db, clock, publish) };
}

const eventCount = (db: ReturnType<typeof setup>["db"]) =>
  db
    .select()
    .from(schema.domainEvents)
    .where(eq(schema.domainEvents.type, "settings.changed"))
    .all().length;

test("loadConfig defaults", () => {
  const c = loadConfig({ HOME: "/h" });
  expect(c.dbPath).toBe("/h/.local/share/synapse/synapse.db");
  expect(c.api).toEqual({ host: "127.0.0.1", port: 7400 });
  expect(c.web).toEqual({ host: "127.0.0.1", port: 7401 });
  expect(c.workerConcurrency).toBe(2);
  expect(c.claudeBinary).toBe("/h/.local/bin/claude");
  expect(c.credentialsPath).toBe("/h/.claude/.credentials.json");
});

test("loadConfig claude overrides", () => {
  const c = loadConfig({
    SYNAPSE_DB_PATH: "/d.db",
    SYNAPSE_CLAUDE_BIN: "/bin/c",
    SYNAPSE_CLAUDE_CREDENTIALS: "/cred.json",
  });
  expect(c.claudeBinary).toBe("/bin/c");
  expect(c.credentialsPath).toBe("/cred.json");
});

test("loadConfig honours XDG_DATA_HOME and overrides", () => {
  expect(loadConfig({ HOME: "/h", XDG_DATA_HOME: "/x" }).dbPath).toBe("/x/synapse/synapse.db");
  const c = loadConfig({
    SYNAPSE_DB_PATH: "/d.db",
    SYNAPSE_API_PORT: "9000",
    SYNAPSE_WEB_PORT: "9001",
  });
  expect(c.dbPath).toBe("/d.db");
  expect(c.api.port).toBe(9000);
  expect(c.web.port).toBe(9001);
});

test("loadConfig rejects non-loopback host", () => {
  expect(() => loadConfig({ HOME: "/h", SYNAPSE_API_HOST: "0.0.0.0" })).toThrow(/loopback/);
});

test("settings default on empty db", () => {
  const { settings } = setup();
  expect(settings.get("jobs.maxAttempts")).toBe(3);
  expect(settings.get("autoReply.awayMode")).toBe(false);
  expect(settings.get("system.lastHeartbeatAt")).toBeNull();
});

test("set then get round-trips and emits one settings.changed", () => {
  const { db, settings } = setup();
  settings.set("jobs.maxAttempts", 5);
  expect(settings.get("jobs.maxAttempts")).toBe(5);
  settings.set("jobs.maxAttempts", 6);
  expect(settings.get("jobs.maxAttempts")).toBe(6);
  expect(eventCount(db)).toBe(2);
  const row = db.select().from(schema.domainEvents).all()[0];
  expect(row?.payload).toEqual({ key: "jobs.maxAttempts" });
});

test("emit:false writes without an event", () => {
  const { db, settings } = setup();
  settings.set("system.lastHeartbeatAt", "2026-01-01T00:00:00.000Z", { emit: false });
  expect(settings.get("system.lastHeartbeatAt")).toBe("2026-01-01T00:00:00.000Z");
  expect(eventCount(db)).toBe(0);
});

test("invalid value throws and writes nothing", () => {
  const { db, settings } = setup();
  expect(() => settings.set("jobs.maxAttempts", -1)).toThrow();
  expect(settings.get("jobs.maxAttempts")).toBe(3);
  expect(eventCount(db)).toBe(0);
});

test("resolveHome: HOME, else os.homedir(); loadConfig and the container share it", () => {
  expect(resolveHome({ HOME: "/h" })).toBe("/h");
  expect(resolveHome({})).toBe(homedir());
  expect(resolveHome({ HOME: "" })).toBe(homedir());
  expect(loadConfig({ XDG_DATA_HOME: "/x" }).claudeBinary).toBe(`${homedir()}/.local/bin/claude`);
});

test("knownServers entries must match the R31 server-name rule", () => {
  const { settings } = setup();
  for (const bad of ["mcp__", "mcp_____", "Slack", "mcp__a,b", "mcp__a__b(", "mcp__a b"]) {
    expect(() =>
      settings.set("orchestrator.knownServers", ["mcp__claude_ai_Slack", bad]),
    ).toThrow();
  }
  expect(settings.get("orchestrator.knownServers")).toContain("mcp__claude_ai_Gmail");
  settings.set("orchestrator.knownServers", ["mcp__claude_ai_Slack", "mcp__a_1"]);
  expect(settings.get("orchestrator.knownServers")).toEqual(["mcp__claude_ai_Slack", "mcp__a_1"]);
});

test("slack.selfUserId validates the Slack user id shape", () => {
  const { settings } = setup();
  expect(settings.get("slack.selfUserId")).toBeNull();
  expect(() => settings.set("slack.selfUserId", "bob")).toThrow();
  settings.set("slack.selfUserId", "U012ABCDEF");
  expect(settings.get("slack.selfUserId")).toBe("U012ABCDEF");
});

test("urgency settings have the documented defaults", () => {
  const { settings } = setup();
  expect(settings.get("urgency.assess.batchWindowSeconds")).toBe(120);
  expect(settings.get("urgency.assess.batchMax")).toBe(10);
  expect(settings.get("urgency.notify.levels")).toEqual(["critical", "high"]);
  expect(settings.get("urgency.model")).toBe("haiku");
  expect(settings.get("urgency.suggest.model")).toBe("haiku");
  expect(settings.get("urgency.maxAgeHours")).toBe(24);
  expect(settings.get("urgency.candidateThreshold")).toBe(2);
  expect(settings.get("security.flags.notifyOnSeverity")).toBe("high");
  expect(settings.get("security.flags.widgetMinSeverity")).toBe("warning");
  expect(settings.get("security.flags.excerptMaxChars")).toBe(300);
  const kw = settings.get("urgency.rules.keywords");
  expect(kw.map((k) => k.id)).toEqual([
    "incident",
    "blocker",
    "urgent",
    "deadline",
    "today",
    "question",
  ]);
  expect(() => settings.set("urgency.rules.keywords", [{ id: "x" } as never])).toThrow();
});
