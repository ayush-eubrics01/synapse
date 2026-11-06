import { expect, test } from "bun:test";
import { createDeferred } from "../lib/deferred";

function fakeTimers() {
  let now = 0;
  let next = 0;
  const tasks = new Map<number, { at: number; fn: () => void }>();
  const setTimer = ((fn: () => void, ms: number) => {
    next += 1;
    tasks.set(next, { at: now + ms, fn });
    return next;
  }) as unknown as typeof setTimeout;
  const clearTimer = ((id: number) => void tasks.delete(id)) as unknown as typeof clearTimeout;
  const advance = (ms: number) => {
    now += ms;
    for (const [id, t] of [...tasks]) {
      if (t.at <= now) {
        tasks.delete(id);
        t.fn();
      }
    }
  };
  return { setTimer, clearTimer, advance, size: () => tasks.size };
}

test("schedule then undo never commits", () => {
  const t = fakeTimers();
  const d = createDeferred({ delayMs: 5000, setTimer: t.setTimer, clearTimer: t.clearTimer });
  let calls = 0;
  d.schedule("flag:1", async () => {
    calls += 1;
  });
  expect(d.pending().has("flag:1")).toBe(true);
  expect(d.undo("flag:1")).toBe(true);
  expect(d.pending().size).toBe(0);
  t.advance(10_000);
  expect(calls).toBe(0);
  expect(t.size()).toBe(0);
});

test("schedule then elapse commits once and the key leaves pending", () => {
  const t = fakeTimers();
  const d = createDeferred({ delayMs: 5000, setTimer: t.setTimer, clearTimer: t.clearTimer });
  let calls = 0;
  d.schedule("flag:1", async () => {
    calls += 1;
  });
  t.advance(4999);
  expect(calls).toBe(0);
  expect(d.pending().has("flag:1")).toBe(true);
  t.advance(1);
  expect(calls).toBe(1);
  expect(d.pending().has("flag:1")).toBe(false);
  t.advance(10_000);
  expect(calls).toBe(1);
});

test("undo after the commit started returns false", () => {
  const t = fakeTimers();
  const d = createDeferred({ delayMs: 5000, setTimer: t.setTimer, clearTimer: t.clearTimer });
  d.schedule("k", () => new Promise<void>(() => {}));
  t.advance(5000);
  expect(d.undo("k")).toBe(false);
  expect(d.undo("never-scheduled")).toBe(false);
});

test("re-scheduling the same key replaces the first", () => {
  const t = fakeTimers();
  const d = createDeferred({ delayMs: 5000, setTimer: t.setTimer, clearTimer: t.clearTimer });
  const ran: string[] = [];
  d.schedule("k", async () => void ran.push("first"));
  t.advance(3000);
  d.schedule("k", async () => void ran.push("second"));
  t.advance(2000);
  expect(ran).toEqual([]);
  t.advance(3000);
  expect(ran).toEqual(["second"]);
  expect(t.size()).toBe(0);
});

test("flushAll starts every pending commit now", () => {
  const t = fakeTimers();
  const d = createDeferred({ delayMs: 5000, setTimer: t.setTimer, clearTimer: t.clearTimer });
  const ran: string[] = [];
  d.schedule("a", async () => void ran.push("a"));
  d.schedule("b", async () => void ran.push("b"));
  d.flushAll();
  expect(ran.sort()).toEqual(["a", "b"]);
  expect(d.pending().size).toBe(0);
  expect(t.size()).toBe(0);
});

test("a failing commit is reported to onError, not thrown", async () => {
  const t = fakeTimers();
  const errors: unknown[] = [];
  const changes: number[] = [];
  const d = createDeferred({
    delayMs: 10,
    setTimer: t.setTimer,
    clearTimer: t.clearTimer,
    onError: (e) => void errors.push(e),
    onChange: () => void changes.push(d.pending().size),
  });
  d.schedule("k", async () => {
    throw new Error("boom");
  });
  t.advance(10);
  await Promise.resolve();
  await Promise.resolve();
  expect(errors.length).toBe(1);
  expect(changes).toEqual([1, 0]);
});
