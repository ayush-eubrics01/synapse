import { beforeEach, expect, test } from "bun:test";
import { openDatabase, runMigrations } from "@synapse/database";
import { FakeClock } from "@synapse/shared";
import { LeaseService } from "../../src/core/leases/leases";

let clock: FakeClock;
let svc: LeaseService;

beforeEach(() => {
  const { db } = openDatabase(":memory:");
  runMigrations(db);
  clock = new FakeClock("2026-11-05T12:00:00.000Z");
  svc = new LeaseService(db, clock);
});

test("acquire, second holder refused, same holder ok", () => {
  expect(svc.acquire("l", "a", 1000)).toBe(true);
  expect(svc.acquire("l", "b", 1000)).toBe(false);
  expect(svc.acquire("l", "a", 1000)).toBe(true);
  expect(svc.get("l")?.holder).toBe("a");
});

test("takeover after expiry", () => {
  svc.acquire("l", "a", 1000);
  clock.advance(1000);
  expect(svc.listExpired().map((l) => l.name)).toEqual(["l"]);
  expect(svc.acquire("l", "b", 1000)).toBe(true);
  const l = svc.get("l");
  expect(l?.holder).toBe("b");
  expect(l?.acquiredAt).toBe("2026-11-05T12:00:01.000Z");
  expect(svc.listExpired()).toEqual([]);
});

test("renew by non-holder is false, by holder extends", () => {
  svc.acquire("l", "a", 1000);
  expect(svc.renew("l", "b", 1000)).toBe(false);
  clock.advance(500);
  expect(svc.renew("l", "a", 1000)).toBe(true);
  expect(svc.get("l")?.expiresAt).toBe("2026-11-05T12:00:01.500Z");
  expect(svc.get("l")?.heartbeatAt).toBe("2026-11-05T12:00:00.500Z");
  clock.advance(2000);
  expect(svc.renew("l", "a", 1000)).toBe(false);
});

test("release only by holder", () => {
  svc.acquire("l", "a", 1000);
  expect(svc.release("l", "b")).toBe(false);
  expect(svc.release("l", "a")).toBe(true);
  expect(svc.get("l")).toBeNull();
  expect(svc.release("l", "a")).toBe(false);
});
