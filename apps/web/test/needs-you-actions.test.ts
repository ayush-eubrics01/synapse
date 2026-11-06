import { expect, test } from "bun:test";
import { TOAST_MS } from "../app/components/ui/Toasts";
import { createDeferred } from "../lib/deferred";
import {
  createNeedsYouActions,
  type NeedsYouApi,
  type NeedsYouHandlers,
  TOASTS,
  UNDO_DELAY_MS,
} from "../lib/needs-you-actions";

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

/** Lets the async commit/refresh chain run (all fakes resolve immediately). */
const settle = () => new Promise((r) => setTimeout(r, 0));

const DELAY = 5000;

function setup(fail: Partial<Record<keyof NeedsYouApi, Error>> = {}, evalQueued = true) {
  const calls: string[] = [];
  const api = new Proxy({} as NeedsYouApi, {
    get:
      (_t, name: string) =>
      (...args: unknown[]) => {
        calls.push(`${name}(${args.map((a) => JSON.stringify(a)).join(",")})`);
        const err = fail[name as keyof NeedsYouApi];
        if (err) return Promise.reject(err);
        if (name === "evaluatePerson" || name === "acceptSuggestion") {
          return Promise.resolve(evalQueued ? { queued: true } : { queued: false, reason: "busy" });
        }
        return Promise.resolve({});
      },
  });
  const timers = fakeTimers();
  const deferred = createDeferred({
    delayMs: DELAY,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  const toasts: Array<{ text: string; undo?: () => void }> = [];
  const errors: Array<string | null> = [];
  const deferredErrors: string[] = [];
  const committing = new Set<string>();
  const evaluationsQueued: string[] = [];
  let refreshes = 0;
  const handlers: NeedsYouHandlers = createNeedsYouActions({
    api,
    deferred,
    toast: { show: (text, undo) => toasts.push({ text, undo }) },
    refresh: async () => {
      refreshes += 1;
      return null;
    },
    setActionError: (e) => errors.push(e),
    setDeferredError: (e) => deferredErrors.push(e),
    committing,
    toggleHistory: () => {},
    seeAllPeople: () => {},
    seeAllJira: () => {},
    onEvaluationQueued: (id) => evaluationsQueued.push(id),
  });
  const hidden = () => new Set([...deferred.pending(), ...committing]);
  return {
    calls,
    timers,
    deferred,
    toasts,
    errors,
    deferredErrors,
    hidden,
    handlers,
    evaluationsQueued,
    refreshes: () => refreshes,
  };
}

const DEFERRED: Array<{
  name: string;
  run: (h: NeedsYouHandlers) => void;
  key: string;
  toast: string;
  call: string;
}> = [
  {
    name: "flag review",
    run: (h) => h.reviewFlag("fl1", "acknowledged"),
    key: "flag:fl1",
    toast: "Red flag acknowledged",
    call: 'reviewFlag("fl1","acknowledged")',
  },
  {
    name: "follow-up discard",
    run: (h) => h.discardFollowup("f1"),
    key: "followup:f1",
    toast: "Draft discarded",
    call: 'discardFollowup("f1")',
  },
  {
    name: "commitment reject",
    run: (h) => h.rejectCommitment("c1"),
    key: "commitment:c1",
    toast: "Marked as not a commitment",
    call: 'reviewCommitment("c1","reject")',
  },
  {
    name: "suggestion dismiss",
    run: (h) => h.recDismiss("r1"),
    key: "recommendation:r1",
    toast: "Suggestion dismissed",
    call: 'dismissSuggestion("r1")',
  },
];

for (const d of DEFERRED) {
  test(`${d.name} is deferred: hidden at once, called only after the delay, exact toast`, async () => {
    const s = setup();
    d.run(s.handlers);
    expect(s.calls).toEqual([]);
    expect(s.hidden().has(d.key)).toBe(true);
    expect(s.toasts.map((t) => t.text)).toEqual([d.toast]);
    expect(typeof s.toasts[0]?.undo).toBe("function");
    s.timers.advance(DELAY - 1);
    await settle();
    expect(s.calls).toEqual([]);
    s.timers.advance(1);
    await settle();
    expect(s.calls).toEqual([d.call]);
    expect(s.refreshes()).toBe(1);
    expect(s.hidden().has(d.key)).toBe(false);
  });

  test(`${d.name}: Undo cancels the call and unhides the item`, async () => {
    const s = setup();
    d.run(s.handlers);
    s.toasts[0]?.undo?.();
    expect(s.hidden().has(d.key)).toBe(false);
    s.timers.advance(DELAY * 2);
    await settle();
    expect(s.calls).toEqual([]);
    expect(s.refreshes()).toBe(0);
  });
}

test("Undo after the commit started says it is too late; the commit still runs once", async () => {
  const s = setup();
  s.handlers.reviewFlag("fl1", "dismissed");
  s.timers.advance(DELAY);
  await settle();
  expect(s.calls).toEqual(['reviewFlag("fl1","dismissed")']);
  s.toasts[0]?.undo?.();
  expect(s.toasts.map((t) => t.text)).toEqual(["Red flag dismissed", TOASTS.tooLateToUndo]);
  expect(TOASTS.tooLateToUndo).toBe("Too late to undo");
  expect(s.toasts[1]?.undo).toBeUndefined();
  expect(s.calls).toHaveLength(1);
});

test("the Undo toast disappears before the deferred commit can start", () => {
  expect(UNDO_DELAY_MS).toBe(5000);
  expect(TOAST_MS).toBe(4500);
  expect(TOAST_MS).toBeLessThan(UNDO_DELAY_MS);
});

test("a queued evaluation from the feed is reported to the shared queued set; a refusal is not", async () => {
  const ok = setup();
  ok.handlers.evaluatePerson("U0ADA0001");
  await settle();
  expect(ok.evaluationsQueued).toEqual(["U0ADA0001"]);
  expect(ok.toasts.map((t) => t.text)).toEqual([TOASTS.evaluationQueued]);
  const refused = setup({}, false);
  refused.handlers.evaluatePerson("U0ADA0001");
  await settle();
  expect(refused.evaluationsQueued).toEqual([]);
});

test("the other flag review choices have their own toast copy", () => {
  const s = setup();
  s.handlers.reviewFlag("a", "contacted");
  s.handlers.reviewFlag("b", "dismissed");
  expect(s.toasts.map((t) => t.text)).toEqual([
    "Red flag marked as contacted",
    "Red flag dismissed",
  ]);
});

const IMMEDIATE: Array<{ name: string; run: (h: NeedsYouHandlers) => void; call: string }> = [
  {
    name: "urgent reply",
    run: (h) => h.urgentReply("m1", "on it"),
    call: 'requestUrgentReply("m1","on it")',
  },
  {
    name: "follow-up send",
    run: (h) => h.sendFollowup("f1", "any update?"),
    call: 'sendFollowup("f1","any update?")',
  },
  {
    name: "approve",
    run: (h) => h.decide("a1", "approve"),
    call: 'decideApproval("a1","approve",)',
  },
  { name: "reject", run: (h) => h.decide("a1", "reject"), call: 'decideApproval("a1","reject",)' },
  {
    name: "recommendation reject with reason",
    run: (h) => h.recDecide({ approvalId: "ra1", decision: "reject", reason: "not yet" }),
    call: 'decideApproval("ra1","reject","not yet")',
  },
  {
    name: "resolve",
    run: (h) => h.resolve("o1", "mark_sent"),
    call: 'resolveOutgoing("o1","mark_sent")',
  },
  { name: "evaluate", run: (h) => h.evaluatePerson("U1"), call: 'evaluatePerson("U1")' },
  { name: "accept suggestion", run: (h) => h.recEvaluate("r1"), call: 'acceptSuggestion("r1")' },
  {
    name: "identity confirm",
    run: (h) => h.confirmIdentity("U0ADA0001"),
    call: 'confirmSlackIdentity("U0ADA0001")',
  },
  { name: "backfill", run: (h) => h.startBackfill(), call: "startBackfill()" },
  {
    name: "dismiss away digest",
    run: (h) => h.dismissAwayDigest("S1"),
    call: 'dismissAwayDigest("S1")',
  },
  { name: "away on", run: (h) => h.setAway(true), call: "setAway(true)" },
  {
    name: "track commitment",
    run: (h) => h.trackCommitment("c1"),
    call: 'reviewCommitment("c1","accept",)',
  },
];

for (const i of IMMEDIATE) {
  test(`${i.name} calls the API at once and never defers`, () => {
    const s = setup();
    i.run(s.handlers);
    // JSON.stringify(undefined) is undefined, which joins as an empty argument.
    expect(s.calls).toEqual([i.call]);
    expect(s.deferred.pending().size).toBe(0);
    expect(s.timers.size()).toBe(0);
    expect(s.hidden().size).toBe(0);
  });
}

test("immediate actions toast their confirmation only after the call succeeds", async () => {
  const s = setup();
  s.handlers.urgentReply("m1", "on it");
  s.handlers.startBackfill();
  s.handlers.decide("a1", "approve");
  await settle();
  expect(s.toasts.map((t) => t.text)).toEqual([
    TOASTS.approvalRequested,
    TOASTS.backfillQueued,
    "Approved",
  ]);
  expect(s.toasts.every((t) => t.undo === undefined)).toBe(true);
  const failing = setup({ requestUrgentReply: new Error("409 conflict") });
  failing.handlers.urgentReply("m1", "on it");
  await settle();
  expect(failing.toasts).toEqual([]);
  expect(failing.errors).toContain("409 conflict");
});

test("a failed deferred commit reports its error and the key leaves hidden after refresh", async () => {
  const s = setup({ reviewFlag: new Error("POST /api/security/flags/fl1/review failed with 500") });
  s.handlers.reviewFlag("fl1", "acknowledged");
  s.timers.advance(DELAY);
  // While the commit runs, the key stays hidden so the card can't flash back.
  expect(s.hidden().has("flag:fl1")).toBe(true);
  await settle();
  expect(s.deferredErrors).toEqual(["POST /api/security/flags/fl1/review failed with 500"]);
  expect(s.errors).not.toContain("POST /api/security/flags/fl1/review failed with 500");
  expect(s.refreshes()).toBe(1);
  expect(s.hidden().has("flag:fl1")).toBe(false);
});

test("an immediate action right after a failed deferred commit clears only immediate errors", async () => {
  const s = setup({ reviewFlag: new Error("deferred commit failed") });
  s.handlers.reviewFlag("fl1", "acknowledged");
  s.timers.advance(DELAY);
  await settle();
  expect(s.deferredErrors).toEqual(["deferred commit failed"]);
  // Within the 5 s the user acts again: the immediate path clears its own error channel only.
  s.handlers.urgentStatus("m1", "acknowledged");
  await settle();
  expect(s.errors.at(-1)).toBeNull();
  expect(s.deferredErrors).toEqual(["deferred commit failed"]);
});

test("the Away toggle toasts its result, and a failure is surfaced without a toast", async () => {
  const s = setup();
  s.handlers.setAway(true);
  s.handlers.setAway(false);
  await settle();
  expect(s.toasts.map((t) => t.text)).toEqual(["Away mode on", "Away mode off"]);
  const failing = setup({ setAway: new Error("500 boom") });
  failing.handlers.setAway(true);
  await settle();
  expect(failing.toasts).toEqual([]);
  expect(failing.errors).toContain("500 boom");
});
