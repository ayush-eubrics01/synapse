import type { DashboardLayout, DashboardLayoutView } from "@synapse/contracts";
import { type TimerApi, trailingDebounce } from "./debounce";

export const LAYOUT_SAVE_FAILED = "Couldn't save the layout";

export interface LayoutSaverDeps {
  put: (layout: DashboardLayout) => Promise<DashboardLayoutView>;
  onSaved: (v: DashboardLayoutView) => void;
  onError: (text: string) => void;
  /** Re-reads the stored layout after a failed save. */
  reload: () => void;
  timers?: TimerApi;
}

/**
 * Debounced layout saver (spec D5). `isBusy()` is true from the first `change` until its PUT
 * settles, so a live refresh can leave the local layout alone meanwhile.
 */
export function createLayoutSaver(deps: LayoutSaverDeps) {
  let pending: DashboardLayout | null = null;
  let inFlight = 0;
  let chain: Promise<void> = Promise.resolve();

  const send = (): Promise<void> => {
    const layout = pending;
    if (layout === null) return chain;
    pending = null;
    const busyBefore = inFlight > 0;
    inFlight++;
    const run = async () => {
      let saved: DashboardLayoutView | null = null;
      let failed = false;
      try {
        saved = await deps.put(layout);
      } catch {
        failed = true;
      }
      inFlight--;
      // A newer edit is already waiting or in flight: this result is stale and must not apply.
      const newer = pending !== null || inFlight > 0;
      if (failed) {
        deps.onError(LAYOUT_SAVE_FAILED);
        deps.reload();
      } else if (saved && !newer) deps.onSaved(saved);
    };
    // Puts are sent in order; with none in flight the first one goes out synchronously.
    chain = busyBefore ? chain.then(run) : run();
    return chain;
  };

  const debounced = trailingDebounce(() => void send(), 500, deps.timers);

  return {
    change(l: DashboardLayout): void {
      pending = l;
      debounced.call();
    },
    async flush(): Promise<void> {
      debounced.cancel();
      await send();
      await chain;
    },
    isBusy: () => pending !== null || inFlight > 0,
    cancel(): void {
      debounced.cancel();
      pending = null;
    },
  };
}

/**
 * Guards layout application: a fetch that began before `bump()` is stale (`isCurrent`), and
 * while locked (a picker call is changing the active layout) edits are refused.
 */
export function createLayoutGate() {
  let generation = 0;
  let locked = false;
  return {
    begin: () => generation,
    bump: () => void generation++,
    isCurrent: (token: number) => token === generation,
    lock: () => {
      locked = true;
    },
    unlock: () => {
      locked = false;
    },
    isLocked: () => locked,
  };
}
