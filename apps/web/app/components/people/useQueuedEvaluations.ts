"use client";

import { useCallback, useEffect, useState } from "react";
import { type Candidate, pruneQueued } from "../../../lib/people-ui";

/**
 * Evaluations requested this session, shared by the People section and the Needs-you setup card.
 * The candidates API has no "queued" flag, so ids are kept here and dropped once the candidate
 * disappears from the list (after the run, or a refresh).
 */
export function useQueuedEvaluations(candidates: readonly Candidate[] | undefined): {
  queued: ReadonlySet<string>;
  markQueued: (ids: readonly string[]) => void;
} {
  const [queued, setQueued] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    if (!candidates) return;
    setQueued((q) => {
      const next = pruneQueued(q, candidates);
      return next.size === q.size ? q : next;
    });
  }, [candidates]);
  const markQueued = useCallback(
    (ids: readonly string[]) => setQueued((q) => new Set([...q, ...ids])),
    [],
  );
  return { queued, markQueued };
}
