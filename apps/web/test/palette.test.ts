import { expect, test } from "bun:test";
import { filterPalette, movePalette, type PaletteItem } from "../lib/palette";

const run = () => {};
const items: PaletteItem[] = [
  { id: "a", label: "Inbox", group: "go to", run },
  { id: "b", label: "Ada Lovelace", group: "person", run },
  { id: "c", label: "Toggle theme", group: "action", run },
];

test("filterPalette matches label and group, case-insensitively", () => {
  expect(filterPalette(items, "inb").map((i) => i.id)).toEqual(["a"]);
  expect(filterPalette(items, "PERSON").map((i) => i.id)).toEqual(["b"]);
  expect(filterPalette(items, "zzz")).toEqual([]);
});

test("empty query returns all", () => {
  expect(filterPalette(items, "")).toEqual(items);
  expect(filterPalette(items, "  ")).toEqual(items);
});

test("movePalette clamps", () => {
  expect(movePalette(0, -1, 3)).toBe(0);
  expect(movePalette(2, 1, 3)).toBe(2);
  expect(movePalette(1, 1, 3)).toBe(2);
  expect(movePalette(1, -1, 3)).toBe(0);
  expect(movePalette(5, 1, 0)).toBe(0);
});
