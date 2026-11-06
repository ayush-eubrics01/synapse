export interface PaletteItem {
  id: string;
  label: string;
  group: "go to" | "conversation" | "person" | "jira" | "project" | "action";
  run: () => void;
}

/** Case-insensitive substring over "label group"; an empty query returns everything. */
export function filterPalette(items: PaletteItem[], q: string): PaletteItem[] {
  const needle = q.trim().toLowerCase();
  if (needle === "") return items;
  return items.filter((i) => `${i.label} ${i.group}`.toLowerCase().includes(needle));
}

/** Moves the active row, clamped to the list; 0 when the list is empty. */
export function movePalette(i: number, delta: 1 | -1, len: number): number {
  if (len <= 0) return 0;
  return Math.min(len - 1, Math.max(0, i + delta));
}
