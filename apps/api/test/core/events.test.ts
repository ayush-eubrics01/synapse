import { expect, test } from "bun:test";
import type { EventType, NewDomainEvent } from "@synapse/contracts";
import { openDatabase, runMigrations, schema } from "@synapse/database";
import { FakeClock, newId } from "@synapse/shared";
import { eq } from "drizzle-orm";
import { OutboxDispatcher } from "../../src/core/events/dispatcher.ts";
import { LiveBus } from "../../src/core/events/live-bus.ts";
import { EventPublisher } from "../../src/core/events/publisher.ts";

function setup() {
  const { db } = openDatabase(":memory:");
  runMigrations(db);
  const clock = new FakeClock("2026-01-01T00:00:00.000Z");
  const live = new LiveBus();
  const received: { type: string; data: unknown }[] = [];
  live.subscribe((m) => received.push(m));
  return {
    db,
    clock,
    received,
    pub: new EventPublisher(clock),
    d: new OutboxDispatcher(db, clock, live),
  };
}

// biome-ignore lint/suspicious/noExplicitAny: test helper builds arbitrary payloads
function ev(type: EventType, payload: any): NewDomainEvent {
  return { type, aggregateType: "t", aggregateId: "a", correlationId: newId(), payload };
}

test("handler runs once even if dispatched twice (idempotent)", () => {
  const { db, pub, d } = setup();
  let calls = 0;
  d.subscribe("settings.changed", "counter", () => {
    calls++;
  });
  pub.publish(db, ev("settings.changed", { key: "x" }));
  d.dispatchOnce();
  d.dispatchOnce();
  expect(calls).toBe(1);
});

test("failing consumer does not block others and is retried then dead", () => {
  const { db, clock, pub, d } = setup();
  let ok = 0;
  d.subscribe("settings.changed", "bad", () => {
    throw new Error("boom");
  });
  d.subscribe("settings.changed", "good", () => {
    ok++;
  });
  const id = pub.publish(db, ev("settings.changed", { key: "x" }));
  const attemptsOf = () =>
    db
      .select()
      .from(schema.eventConsumptions)
      .where(eq(schema.eventConsumptions.consumer, "bad"))
      .get()?.attempts;
  d.dispatchOnce();
  expect(db.select().from(schema.domainEvents).get()?.dispatchedAt).toBeNull();
  expect(attemptsOf()).toBe(1);
  d.dispatchOnce(); // still in backoff: no retry
  expect(attemptsOf()).toBe(1);
  clock.advance(10 * 60_000);
  d.dispatchOnce();
  expect(attemptsOf()).toBe(2);
  clock.advance(10 * 60_000);
  d.dispatchOnce();
  const bad = db
    .select()
    .from(schema.eventConsumptions)
    .where(eq(schema.eventConsumptions.consumer, "bad"))
    .get();
  expect(ok).toBe(1);
  expect(bad?.status).toBe("failed");
  expect(bad?.attempts).toBe(3);
  expect(bad?.lastError).toEqual({ message: "boom" });
  expect(
    db.select().from(schema.domainEvents).where(eq(schema.domainEvents.id, id)).get()?.dispatchedAt,
  ).not.toBeNull();
});

test("handler work rolls back with its consumption row", () => {
  const { db, clock, pub, d } = setup();
  d.subscribe("settings.changed", "partial", (_e, tx) => {
    tx.insert(schema.notifications)
      .values({
        id: newId(),
        kind: "k",
        severity: "info",
        title: "t",
        createdAt: clock.now().toISOString(),
      })
      .run();
    throw new Error("x");
  });
  pub.publish(db, ev("settings.changed", { key: "x" }));
  d.dispatchOnce();
  expect(db.select().from(schema.notifications).all()).toHaveLength(0);
  const row = db.select().from(schema.eventConsumptions).get();
  expect(row?.status).toBe("pending");
  expect(row?.attempts).toBe(1);
});

test("events dispatch in publish order within one millisecond and reach the live bus", () => {
  const { db, pub, d, received } = setup();
  const seen: string[] = [];
  d.subscribe("settings.changed", "order", (e) => {
    seen.push((e.payload as { key: string }).key);
  });
  for (const key of ["a", "b", "c"]) pub.publish(db, ev("settings.changed", { key }));
  d.dispatchOnce();
  expect(seen).toEqual(["a", "b", "c"]);
  expect(received.map((m) => m.type)).toEqual([
    "settings.changed",
    "settings.changed",
    "settings.changed",
  ]);
});

test("event with no subscribers is dispatched and forwarded", () => {
  const { db, pub, d, received } = setup();
  pub.publish(db, ev("settings.changed", { key: "x" }));
  d.dispatchOnce();
  expect(db.select().from(schema.domainEvents).get()?.dispatchedAt).not.toBeNull();
  expect(received).toHaveLength(1);
});

test("publish rejects invalid payload", () => {
  const { db, pub } = setup();
  expect(() => pub.publish(db, ev("approval.requested", {}))).toThrow();
  expect(db.select().from(schema.domainEvents).all()).toHaveLength(0);
});
