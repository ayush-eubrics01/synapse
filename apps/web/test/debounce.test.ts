import { expect, test } from "bun:test";
import { trailingDebounce } from "../lib/debounce";

type Timer = { at: number; fn: () => void; id: number };

function fakeTimers() {
  let now = 0;
  let nextId = 1;
  let timers: Timer[] = [];
  return {
    set: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clear: (id: unknown) => {
      timers = timers.filter((t) => t.id !== id);
    },
    advance(ms: number) {
      now += ms;
      const due = timers.filter((t) => t.at <= now);
      timers = timers.filter((t) => t.at > now);
      for (const t of due) t.fn();
    },
  };
}

test("a burst of calls runs once, 500 ms after the last call", () => {
  const t = fakeTimers();
  let runs = 0;
  const d = trailingDebounce(() => runs++, 500, t);
  d.call();
  t.advance(300);
  d.call();
  t.advance(300);
  d.call();
  t.advance(499);
  expect(runs).toBe(0);
  t.advance(1);
  expect(runs).toBe(1);
  t.advance(1000);
  expect(runs).toBe(1);
});

test("cancel drops a pending call", () => {
  const t = fakeTimers();
  let runs = 0;
  const d = trailingDebounce(() => runs++, 500, t);
  d.call();
  d.cancel();
  t.advance(1000);
  expect(runs).toBe(0);
});
