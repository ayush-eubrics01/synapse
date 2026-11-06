import { useRef, useState } from "react";

export interface DeferredOptions {
  delayMs: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  /** Called whenever the pending set changes (scheduled, undone, or a commit started). */
  onChange?: () => void;
  /** A commit that rejects is reported here; it is never rethrown. */
  onError?: (error: unknown, key: string) => void;
}

export interface Deferred {
  schedule(key: string, commit: () => Promise<void>): void;
  undo(key: string): boolean;
  pending(): Set<string>;
  flushAll(): void;
}

/**
 * Deferred commits for Undo (spec D8): the API call runs only after `delayMs`. A key is pending
 * until its commit starts; after that, undo returns false.
 */
export function createDeferred(opts: DeferredOptions): Deferred {
  const setTimer = opts.setTimer ?? setTimeout;
  const clearTimer = opts.clearTimer ?? clearTimeout;
  type Entry = { timer: ReturnType<typeof setTimeout>; commit: () => Promise<void> };
  const entries = new Map<string, Entry>();
  const changed = () => opts.onChange?.();

  const start = (key: string, e: Entry) => {
    if (entries.get(key) !== e) return; // replaced or undone meanwhile
    entries.delete(key);
    changed();
    let p: Promise<void>;
    try {
      p = e.commit();
    } catch (err) {
      p = Promise.reject(err);
    }
    p.catch((err: unknown) => opts.onError?.(err, key));
  };

  return {
    schedule(key, commit) {
      const prev = entries.get(key);
      if (prev) clearTimer(prev.timer);
      const entry: Entry = { commit, timer: setTimer(() => start(key, entry), opts.delayMs) };
      entries.set(key, entry);
      changed();
    },
    undo(key) {
      const e = entries.get(key);
      if (!e) return false;
      clearTimer(e.timer);
      entries.delete(key);
      changed();
      return true;
    },
    pending() {
      return new Set(entries.keys());
    },
    flushAll() {
      for (const [key, e] of [...entries]) {
        clearTimer(e.timer);
        start(key, e);
      }
    },
  };
}

/** One Deferred per component; re-renders whenever the pending set changes. */
export function useDeferred(
  delayMs: number,
  onError?: (error: unknown, key: string) => void,
): Deferred {
  const [, setTick] = useState(0);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const ref = useRef<Deferred | null>(null);
  if (ref.current === null) {
    ref.current = createDeferred({
      delayMs,
      onChange: () => setTick((t) => t + 1),
      onError: (e, k) => onErrorRef.current?.(e, k),
    });
  }
  return ref.current;
}
