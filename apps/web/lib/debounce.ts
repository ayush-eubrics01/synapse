export interface TimerApi {
  set(fn: () => void, ms: number): unknown;
  clear(id: unknown): void;
}

const realTimers: TimerApi = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

/** Trailing debounce: a burst of calls runs `fn` once, `ms` after the last call. */
export function trailingDebounce(
  fn: () => void,
  ms: number,
  timers: TimerApi = realTimers,
): { call(): void; cancel(): void } {
  let pending: unknown = null;
  const cancel = () => {
    if (pending !== null) timers.clear(pending);
    pending = null;
  };
  return {
    call() {
      cancel();
      pending = timers.set(() => {
        pending = null;
        fn();
      }, ms);
    },
    cancel,
  };
}
