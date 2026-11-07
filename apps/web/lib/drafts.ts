/**
 * Unsent reply drafts, kept in memory only so they survive a component remount (a customise
 * action or layout switch). Never persisted: a reload loses them, by design.
 */
export type DraftKey = `reply:${string}` | `code_answer:${string}` | `followup:${string}`;

const drafts = new Map<DraftKey, string>();

export function readDraft(key: DraftKey): string | undefined {
  return drafts.get(key);
}

export function writeDraft(key: DraftKey, text: string): void {
  drafts.set(key, text);
}

export function clearDraft(key: DraftKey): void {
  drafts.delete(key);
}

/** For tests. */
export function clearAllDrafts(): void {
  drafts.clear();
}
