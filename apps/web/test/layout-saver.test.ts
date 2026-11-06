import { expect, test } from "bun:test";
import { type DashboardLayoutView, DEFAULT_DASHBOARD_LAYOUT } from "@synapse/contracts";
import type { TimerApi } from "../lib/debounce";
import { setVisible } from "../lib/layout";
import { createLayoutGate, createLayoutSaver, LAYOUT_SAVE_FAILED } from "../lib/layout-saver";

function fakeTimers() {
  const q = new Map<number, () => void>();
  let n = 0;
  const api: TimerApi = {
    set: (fn) => {
      q.set(++n, fn);
      return n;
    },
    clear: (id) => void q.delete(id as number),
  };
  return {
    api,
    fire: () => {
      for (const [k, fn] of [...q]) {
        q.delete(k);
        fn();
      }
    },
  };
}

const view = (): DashboardLayoutView => ({
  id: "L1",
  name: "Default",
  isActive: true,
  layout: DEFAULT_DASHBOARD_LAYOUT,
  updatedAt: "2026-11-07T00:00:00.000Z",
});
const deferred = () => {
  let resolve!: (v: DashboardLayoutView) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<DashboardLayoutView>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const setup = (put: (l: unknown) => Promise<DashboardLayoutView>) => {
  const t = fakeTimers();
  const log = { saved: 0, errors: [] as string[], reloads: 0 };
  const saver = createLayoutSaver({
    put: put as never,
    onSaved: () => void log.saved++,
    onError: (e) => void log.errors.push(e),
    reload: () => void log.reloads++,
    timers: t.api,
  });
  return { t, log, saver };
};
const l1 = setVisible(DEFAULT_DASHBOARD_LAYOUT, "jira", false);
const l2 = setVisible(l1, "people", false);
const l3 = setVisible(l2, "system", false);

test("a burst of changes sends one put with the last layout", async () => {
  const puts: unknown[] = [];
  const { t, saver, log } = setup(async (l) => {
    puts.push(l);
    return view();
  });
  saver.change(l1);
  saver.change(l2);
  saver.change(l3);
  expect(puts.length).toBe(0);
  t.fire();
  await saver.flush();
  expect(puts).toEqual([l3]);
  expect(log.saved).toBe(1);
});

test("a failed put reports once, reloads once and never applies a result", async () => {
  const { t, saver, log } = setup(async () => {
    throw new Error("x");
  });
  saver.change(l1);
  t.fire();
  await saver.flush();
  expect(log.errors).toEqual([LAYOUT_SAVE_FAILED]);
  expect(LAYOUT_SAVE_FAILED).toBe("Couldn't save the layout");
  expect(log.reloads).toBe(1);
  expect(log.saved).toBe(0);
  expect(saver.isBusy()).toBe(false);
});

test("isBusy covers the debounce wait and the pending put", async () => {
  const d = deferred();
  const { t, saver } = setup(() => d.promise);
  expect(saver.isBusy()).toBe(false);
  saver.change(l1);
  expect(saver.isBusy()).toBe(true);
  t.fire();
  expect(saver.isBusy()).toBe(true);
  d.resolve(view());
  await saver.flush();
  expect(saver.isBusy()).toBe(false);
});

test("flush sends a pending change at once and resolves after the put", async () => {
  const d = deferred();
  let sent = 0;
  const { saver, log } = setup(() => {
    sent++;
    return d.promise;
  });
  saver.change(l1);
  const done = saver.flush();
  expect(sent).toBe(1);
  let finished = false;
  void done.then(() => {
    finished = true;
  });
  await Promise.resolve();
  expect(finished).toBe(false);
  d.resolve(view());
  await done;
  expect(finished).toBe(true);
  expect(log.saved).toBe(1);
});

test("a change made while a put is in flight is sent next and the stale result is not applied", async () => {
  const first = deferred();
  const puts: unknown[] = [];
  const { t, saver, log } = setup((l) => {
    puts.push(l);
    return puts.length === 1 ? first.promise : Promise.resolve(view());
  });
  saver.change(l1);
  t.fire();
  saver.change(l2);
  first.resolve(view());
  t.fire();
  await saver.flush();
  expect(puts).toEqual([l1, l2]);
  expect(log.saved).toBe(1);
  expect(saver.isBusy()).toBe(false);
});

test("a change after a failure is still sent", async () => {
  let calls = 0;
  const { t, saver, log } = setup(async () => {
    if (++calls === 1) throw new Error("x");
    return view();
  });
  saver.change(l1);
  t.fire();
  await saver.flush();
  saver.change(l2);
  t.fire();
  await saver.flush();
  expect(calls).toBe(2);
  expect(log.saved).toBe(1);
});

test("cancel drops a pending change", async () => {
  let calls = 0;
  const { t, saver } = setup(async () => {
    calls++;
    return view();
  });
  saver.change(l1);
  saver.cancel();
  t.fire();
  await saver.flush();
  expect(calls).toBe(0);
  expect(saver.isBusy()).toBe(false);
});

test("the gate drops a fetch begun before a save settled and refuses edits while locked", () => {
  const g = createLayoutGate();
  const token = g.begin();
  expect(g.isCurrent(token)).toBe(true);
  g.bump();
  expect(g.isCurrent(token)).toBe(false);
  expect(g.isCurrent(g.begin())).toBe(true);
  expect(g.isLocked()).toBe(false);
  g.lock();
  expect(g.isLocked()).toBe(true);
  g.unlock();
  expect(g.isLocked()).toBe(false);
});
