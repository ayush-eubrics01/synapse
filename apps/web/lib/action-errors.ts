/**
 * Action errors come from two channels. An immediate action clears only `immediate` when it
 * starts, so a deferred commit's failure (reported up to 5 s after the click, spec D8) stays on
 * screen until the user dismisses it.
 */
export interface ActionErrors {
  immediate: string | null;
  deferred: string | null;
}

export const NO_ACTION_ERRORS: ActionErrors = { immediate: null, deferred: null };

/** The line shown under the header, deferred failure first; null when there is none. */
export function actionErrorText(e: ActionErrors): string | null {
  const parts = [e.deferred, e.immediate].filter((x): x is string => x !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}
