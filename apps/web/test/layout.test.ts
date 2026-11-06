import { expect, test } from "bun:test";
import { type DashboardLayout, DEFAULT_DASHBOARD_LAYOUT } from "@synapse/contracts";
import {
  hiddenSections,
  layoutErrorText,
  layoutRows,
  moveSection,
  moveVisible,
  SECTION_LABELS,
  setCollapsed,
  setVisible,
  setWidth,
} from "../lib/layout";

const ids = (l: DashboardLayout) => l.sections.map((s) => s.id);
const mk = (
  ...s: Array<[DashboardLayout["sections"][number]["id"], "half" | "full", boolean?]>
): DashboardLayout => ({
  version: 1,
  sections: s.map(([id, width, visible]) => ({
    id,
    width,
    visible: visible ?? true,
    collapsed: false,
  })),
});

test("moveSection does nothing at either end and swaps otherwise", () => {
  expect(moveSection(DEFAULT_DASHBOARD_LAYOUT, "triage", -1)).toEqual(DEFAULT_DASHBOARD_LAYOUT);
  const last = DEFAULT_DASHBOARD_LAYOUT.sections.at(-1)?.id as "system";
  expect(moveSection(DEFAULT_DASHBOARD_LAYOUT, last, 1)).toEqual(DEFAULT_DASHBOARD_LAYOUT);
  expect(ids(moveSection(DEFAULT_DASHBOARD_LAYOUT, "triage", 1)).slice(0, 2)).toEqual([
    "running",
    "triage",
  ]);
});

test("triage can be neither hidden nor collapsed", () => {
  expect(setVisible(DEFAULT_DASHBOARD_LAYOUT, "triage", false)).toEqual(DEFAULT_DASHBOARD_LAYOUT);
  expect(setCollapsed(DEFAULT_DASHBOARD_LAYOUT, "triage", true)).toEqual(DEFAULT_DASHBOARD_LAYOUT);
  const l = setCollapsed(DEFAULT_DASHBOARD_LAYOUT, "jira", true);
  expect(l.sections.find((s) => s.id === "jira")?.collapsed).toBe(true);
  const w = setWidth(DEFAULT_DASHBOARD_LAYOUT, "jira", "half");
  expect(w.sections.find((s) => s.id === "jira")?.width).toBe("half");
});

test("layoutRows pairs the default's two halves and leaves seven singles", () => {
  const rows = layoutRows(DEFAULT_DASHBOARD_LAYOUT);
  expect(rows[0]).toEqual({ kind: "pair", ids: ["triage", "running"] });
  expect(rows.length).toBe(8);
  expect(rows.slice(1).every((r) => r.kind === "single")).toBe(true);
});

test("hidden sections are skipped when pairing", () => {
  expect(layoutRows(mk(["jira", "half"], ["people", "half", false], ["system", "half"]))).toEqual([
    { kind: "pair", ids: ["jira", "system"] },
  ]);
});

test("a lone half is a single; three halves are a pair then a single", () => {
  expect(layoutRows(mk(["jira", "half"], ["inbox", "full"]))).toEqual([
    { kind: "single", id: "jira" },
    { kind: "single", id: "inbox" },
  ]);
  expect(layoutRows(mk(["jira", "half"], ["inbox", "half"], ["system", "half"]))).toEqual([
    { kind: "pair", ids: ["jira", "inbox"] },
    { kind: "single", id: "system" },
  ]);
});

test("hiddenSections lists hidden ids; helpers never mutate", () => {
  const before = JSON.stringify(DEFAULT_DASHBOARD_LAYOUT);
  const hidden = setVisible(DEFAULT_DASHBOARD_LAYOUT, "jira", false);
  expect(hiddenSections(hidden)).toEqual(["jira"]);
  expect(setVisible(hidden, "jira", true)).not.toBe(hidden);
  moveSection(DEFAULT_DASHBOARD_LAYOUT, "inbox", 1);
  setWidth(DEFAULT_DASHBOARD_LAYOUT, "inbox", "half");
  expect(JSON.stringify(DEFAULT_DASHBOARD_LAYOUT)).toBe(before);
});

test("labels", () => {
  expect(SECTION_LABELS.running).toBe("How Synapse is running");
  expect(SECTION_LABELS.triage).toBe("Needs you");
  expect(SECTION_LABELS.jira).toBe("Jira");
});

test("moveVisible steps over hidden sections and stops at the ends", () => {
  const l = mk(["inbox", "full"], ["jira", "full", false], ["system", "full"]);
  expect(ids(moveVisible(l, "inbox", 1))).toEqual(["jira", "system", "inbox"]);
  expect(ids(moveVisible(l, "system", -1))).toEqual(["system", "inbox", "jira"]);
  expect(moveVisible(l, "inbox", -1)).toBe(l);
  expect(moveVisible(l, "system", 1)).toBe(l);
});

test("layout error codes map to the spec's toast text", () => {
  expect(layoutErrorText("name_taken")).toBe("A layout with that name already exists");
  expect(layoutErrorText("limit_reached")).toBe("You can keep up to 10 layouts");
  expect(layoutErrorText("active_layout")).toBe(
    "Switch to another layout before deleting this one",
  );
  expect(layoutErrorText("last_layout")).toBe("You can't delete the only layout");
  expect(layoutErrorText(undefined)).toBe("Couldn't update the layouts");
});
