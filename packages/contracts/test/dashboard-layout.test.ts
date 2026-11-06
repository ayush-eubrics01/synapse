import { expect, test } from "bun:test";
import {
  DASHBOARD_SECTION_IDS,
  DEFAULT_DASHBOARD_LAYOUT,
  dashboardLayoutInputSchema,
  dashboardLayoutSchema,
  layoutNameSchema,
} from "../src/index";

test("default layout lists every section id in order, half/half then full", () => {
  expect(DEFAULT_DASHBOARD_LAYOUT.sections.map((s) => s.id)).toEqual([...DASHBOARD_SECTION_IDS]);
  expect(DEFAULT_DASHBOARD_LAYOUT.sections.map((s) => s.width)).toEqual([
    "half",
    "half",
    ...Array(7).fill("full"),
  ]);
  expect(DEFAULT_DASHBOARD_LAYOUT.sections.every((s) => s.visible && !s.collapsed)).toBe(true);
  expect(dashboardLayoutSchema.safeParse(DEFAULT_DASHBOARD_LAYOUT).success).toBe(true);
});

const sec = { id: "triage", visible: true, collapsed: false, width: "full" };

test("dashboardLayoutSchema is strict", () => {
  const ok = { version: 1, sections: [sec] };
  expect(dashboardLayoutSchema.safeParse(ok).success).toBe(true);
  expect(dashboardLayoutSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  expect(
    dashboardLayoutSchema.safeParse({ version: 1, sections: [{ ...sec, width: "third" }] }).success,
  ).toBe(false);
  expect(dashboardLayoutSchema.safeParse({ ...ok, version: 2 }).success).toBe(false);
  expect(
    dashboardLayoutSchema.safeParse({ version: 1, sections: [{ ...sec, id: "overview" }] }).success,
  ).toBe(false);
  expect(
    dashboardLayoutSchema.safeParse({ version: 1, sections: [{ ...sec, extra: 1 }] }).success,
  ).toBe(false);
});

test("dashboardLayoutInputSchema accepts unknown ids but bounds them", () => {
  expect(
    dashboardLayoutInputSchema.safeParse({ version: 1, sections: [{ ...sec, id: "x-unknown" }] })
      .success,
  ).toBe(true);
  expect(
    dashboardLayoutInputSchema.safeParse({ version: 1, sections: [{ ...sec, id: "" }] }).success,
  ).toBe(false);
  expect(
    dashboardLayoutInputSchema.safeParse({ version: 1, sections: Array(51).fill(sec) }).success,
  ).toBe(false);
});

test("layoutNameSchema trims and bounds", () => {
  expect(layoutNameSchema.safeParse("").success).toBe(false);
  expect(layoutNameSchema.safeParse("   ").success).toBe(false);
  expect(layoutNameSchema.safeParse("a".repeat(41)).success).toBe(false);
  expect(layoutNameSchema.parse(" Focus ")).toBe("Focus");
});
