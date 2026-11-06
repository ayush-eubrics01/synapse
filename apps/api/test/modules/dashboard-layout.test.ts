import { describe, expect, test } from "bun:test";
import { DASHBOARD_SECTION_IDS, DEFAULT_DASHBOARD_LAYOUT } from "@synapse/contracts";
import { normaliseLayout } from "../../src/modules/dashboard/layout";

const sec = (id: string, extra: object = {}) => ({
  id,
  visible: true,
  collapsed: false,
  width: "full",
  ...extra,
});

describe("normaliseLayout", () => {
  test("drops unknown ids and keeps the first of duplicates", () => {
    const out = normaliseLayout({
      version: 1,
      sections: [sec("x-old"), sec("jira", { width: "half" }), sec("jira", { visible: false })],
    });
    expect(out.sections.some((s) => (s.id as string) === "x-old")).toBe(false);
    const jira = out.sections.filter((s) => s.id === "jira");
    expect(jira).toHaveLength(1);
    expect(jira[0]).toMatchObject({ visible: true, width: "half" });
  });

  test("appends missing ids in registry order with defaults", () => {
    const out = normaliseLayout({ version: 1, sections: [sec("system", { width: "half" })] });
    expect(out.sections.map((s) => s.id)).toEqual([
      "system",
      ...DASHBOARD_SECTION_IDS.filter((i) => i !== "system"),
    ]);
    expect(out.sections[0]?.width).toBe("half");
    const rest = out.sections.slice(1);
    for (const s of rest) {
      const d = DEFAULT_DASHBOARD_LAYOUT.sections.find((x) => x.id === s.id);
      expect(s).toEqual(d as NonNullable<typeof d>);
    }
  });

  test("forces triage visible and expanded", () => {
    const out = normaliseLayout({
      version: 1,
      sections: [sec("triage", { visible: false, collapsed: true })],
    });
    expect(out.sections.find((s) => s.id === "triage")).toMatchObject({
      visible: true,
      collapsed: false,
    });
  });

  test("anything invalid becomes a deep copy of the default", () => {
    for (const bad of [null, 42, { version: 2, sections: [] }, { version: 1, sections: "x" }]) {
      const out = normaliseLayout(bad);
      expect(out).toEqual(DEFAULT_DASHBOARD_LAYOUT);
      expect(out).not.toBe(DEFAULT_DASHBOARD_LAYOUT);
      expect(out.sections).not.toBe(DEFAULT_DASHBOARD_LAYOUT.sections);
    }
  });

  test("does not mutate the input", () => {
    const input = { version: 1, sections: [sec("triage", { visible: false }), sec("x-old")] };
    const copy = structuredClone(input);
    normaliseLayout(input);
    expect(input).toEqual(copy);
  });
});
