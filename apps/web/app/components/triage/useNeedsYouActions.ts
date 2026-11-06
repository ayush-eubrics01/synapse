"use client";

import { useState } from "react";
import { useDeferred } from "../../../lib/deferred";
import {
  createNeedsYouActions,
  type NeedsYouHandlers,
  realNeedsYouApi,
  UNDO_DELAY_MS,
} from "../../../lib/needs-you-actions";
import { useToast } from "../ui/Toasts";

export interface NeedsYouActionsOptions {
  refresh: () => Promise<string | null>;
  setActionError: (error: string | null) => void;
  setDeferredError: (error: string) => void;
  toggleHistory: (slackUserId: string) => void;
  seeAllPeople: () => void;
  onEvaluationQueued?: (slackUserId: string) => void;
}

/** React wrapper over `createNeedsYouActions`: hidden = pending deferrals plus committing keys. */
export function useNeedsYouActions(opts: NeedsYouActionsOptions): {
  handlers: NeedsYouHandlers;
  hidden: Set<string>;
} {
  const toast = useToast();
  const [committing, setCommitting] = useState<Set<string>>(() => new Set());
  const deferred = useDeferred(UNDO_DELAY_MS);
  const handlers = createNeedsYouActions({
    ...opts,
    api: realNeedsYouApi,
    deferred,
    toast,
    committing: {
      add: (key) => setCommitting((s) => new Set(s).add(key)),
      delete: (key) =>
        setCommitting((s) => {
          const next = new Set(s);
          next.delete(key);
          return next;
        }),
    },
  });
  return { handlers, hidden: new Set([...deferred.pending(), ...committing]) };
}
