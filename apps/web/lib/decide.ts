export interface DecisionOutcome {
  actionError: string | null;
  loadError: string | null;
}

// Runs a decision, then a refresh. The two errors are kept apart so a successful
// refresh can never hide a failed decision (e.g. 409 or 404).
export async function decideThenRefresh(
  decide: () => Promise<unknown>,
  refresh: () => Promise<string | null>,
): Promise<DecisionOutcome> {
  let actionError: string | null = null;
  try {
    await decide();
  } catch (e) {
    actionError = e instanceof Error ? e.message : String(e);
  }
  return { actionError, loadError: await refresh() };
}
