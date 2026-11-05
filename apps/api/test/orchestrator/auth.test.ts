import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AIProvider } from "@synapse/contracts";
import { openDatabase, runMigrations, schema } from "@synapse/database";
import { FakeClock } from "@synapse/shared";
import { eq } from "drizzle-orm";
import { SettingsService } from "../../src/core/config/settings";
import { EventPublisher } from "../../src/core/events/publisher";
import { authCheck, claudeCheck } from "../../src/core/health/checks";
import { AuthMonitor, readAuthExpiry } from "../../src/core/orchestrator/auth";

const FAKE_ACCESS = "sk-ant-oat01-FAKEACCESSTOKEN";
const FAKE_REFRESH = "sk-ant-ort01-FAKEREFRESHTOKEN";
const START = "2026-11-05T12:00:00.000Z";
const HOUR = 3_600_000;

let dir: string;
let path: string;
let db: ReturnType<typeof openDatabase>["db"];
let clock: FakeClock;
let settings: SettingsService;
let monitor: AuthMonitor;

function writeCreds(accessMs: number, refreshMs: number) {
  writeFileSync(
    path,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: FAKE_ACCESS,
        refreshToken: FAKE_REFRESH,
        expiresAt: accessMs,
        refreshTokenExpiresAt: refreshMs,
        scopes: ["x"],
      },
    }),
  );
}
const nowMs = () => clock.now().getTime();
const warnings = () =>
  db
    .select()
    .from(schema.domainEvents)
    .where(eq(schema.domainEvents.type, "auth.expiry_warning"))
    .all();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "auth-test-"));
  path = join(dir, "credentials.json");
  db = openDatabase(":memory:").db;
  runMigrations(db);
  clock = new FakeClock(START);
  settings = new SettingsService(db, clock, () => "e");
  monitor = new AuthMonitor(db, clock, settings, new EventPublisher(clock), path);
});

test("readAuthExpiry returns only the two dates, never token text", () => {
  writeCreds(Date.parse(START) + HOUR, Date.parse(START) + 7 * 24 * HOUR);
  const r = readAuthExpiry(path);
  expect(r).toEqual({
    accessExpiresAt: "2026-11-05T13:00:00.000Z",
    refreshExpiresAt: "2026-11-12T12:00:00.000Z",
  });
  const s = JSON.stringify(r);
  expect(s).not.toContain(FAKE_ACCESS);
  expect(s).not.toContain(FAKE_REFRESH);
  expect(s).not.toContain("FAKE");
});

test("readAuthExpiry errors are generic and leak no content", () => {
  const missing = readAuthExpiry(join(dir, "nope.json"));
  expect("error" in missing).toBe(true);
  writeFileSync(path, `{"claudeAiOauth": {"accessToken": "${FAKE_ACCESS}", oops`);
  const bad = readAuthExpiry(path);
  expect("error" in bad).toBe(true);
  writeFileSync(path, JSON.stringify({ claudeAiOauth: { accessToken: FAKE_ACCESS } }));
  const noFields = readAuthExpiry(path);
  expect("error" in noFields).toBe(true);
  writeFileSync(
    path,
    JSON.stringify({ claudeAiOauth: { expiresAt: "x", refreshTokenExpiresAt: FAKE_REFRESH } }),
  );
  const wrongType = readAuthExpiry(path);
  for (const r of [missing, bad, noFields, wrongType]) {
    const s = JSON.stringify(r);
    expect(s).not.toContain("FAKE");
    expect(s).not.toContain(dir);
  }
});

test("record with unreadable file inserts nothing and does not throw", () => {
  expect(() => monitor.record()).not.toThrow();
  expect(db.select().from(schema.authSnapshots).all()).toHaveLength(0);
  expect(monitor.status()).toEqual({
    refreshExpiresAt: null,
    slides: null,
    readError: "credentials file unreadable",
  });
});

test("status keeps last known snapshot after a failed read", () => {
  writeCreds(nowMs() + HOUR, nowMs() + 7 * 24 * HOUR);
  monitor.record();
  writeFileSync(path, "garbage");
  monitor.record();
  expect(db.select().from(schema.authSnapshots).all()).toHaveLength(1);
  const st = monitor.status();
  expect(st.refreshExpiresAt).toBe("2026-11-12T12:00:00.000Z");
  expect(st.readError).toBe("credentials file malformed");
});

test("expiry warning fires once within 24h and again after", () => {
  writeCreds(nowMs() + HOUR, nowMs() + 40 * HOUR);
  monitor.record();
  expect(warnings()).toHaveLength(1);
  expect(warnings()[0]?.payload).toEqual({
    refreshExpiresAt: new Date(nowMs() + 40 * HOUR).toISOString(),
  });
  expect(settings.get("auth.lastExpiryWarningAt")).toBe(START);
  clock.advance(23 * HOUR);
  monitor.record();
  expect(warnings()).toHaveLength(1);
  clock.advance(HOUR + 1);
  monitor.record();
  expect(warnings()).toHaveLength(2);
  // settings.set was emit:false
  expect(
    db
      .select()
      .from(schema.domainEvents)
      .where(eq(schema.domainEvents.type, "settings.changed"))
      .all(),
  ).toHaveLength(0);
});

test("no warning when refresh expiry is 48h or more away", () => {
  writeCreds(nowMs() + HOUR, nowMs() + 48 * HOUR);
  monitor.record();
  expect(warnings()).toHaveLength(0);
  expect(db.select().from(schema.authSnapshots).all()).toHaveLength(1);
});

test("slides detection", () => {
  expect(monitor.status().slides).toBeNull();
  writeCreds(nowMs() + HOUR, nowMs() + 7 * 24 * HOUR);
  monitor.record();
  expect(monitor.status().slides).toBeNull();
  clock.advance(HOUR);
  monitor.record();
  expect(monitor.status().slides).toBe(false);
  writeCreds(nowMs() + HOUR, nowMs() + 8 * 24 * HOUR);
  clock.advance(HOUR);
  monitor.record();
  expect(monitor.status().slides).toBe(true);
});

test("authCheck levels", async () => {
  const check = authCheck(monitor, clock);
  expect((await check()).status).toBe("degraded"); // nothing recorded / unreadable
  const at = async (leftMs: number) => {
    writeCreds(nowMs() + HOUR, nowMs() + leftMs);
    monitor.record();
    return check();
  };
  const ok = await at(72 * HOUR);
  expect(ok.status).toBe("ok");
  expect(ok.detail).toContain("slides: unknown");
  expect(ok.detail).toContain(new Date(nowMs() + 72 * HOUR).toISOString());
  clock.advance(1000);
  expect((await at(47 * HOUR)).status).toBe("degraded");
  clock.advance(1000);
  expect((await at(HOUR)).status).toBe("down");
  clock.advance(1000);
  const past = await at(-HOUR);
  expect(past.status).toBe("down");
  expect(past.detail).toContain("slides: no");
  writeFileSync(path, "garbage");
  monitor.record();
  expect(await check()).toEqual({ status: "degraded", detail: "credentials file malformed" });
});

test("claudeCheck wraps provider health and never throws", async () => {
  const mk = (getHealth: AIProvider["getHealth"]): AIProvider => ({
    execute: async () => {
      throw new Error("unused");
    },
    getHealth,
  });
  expect(await claudeCheck(mk(async () => ({ status: "ok", version: "2.1.318" })))()).toEqual({
    status: "ok",
    detail: "2.1.318",
  });
  expect(
    (await claudeCheck(mk(async () => ({ status: "down", detail: "no binary" })))()).status,
  ).toBe("down");
  expect(
    (
      await claudeCheck(
        mk(async () => {
          throw new Error("boom");
        }),
      )()
    ).status,
  ).toBe("down");
});
