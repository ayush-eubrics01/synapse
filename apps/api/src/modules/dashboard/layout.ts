import {
  DASHBOARD_SECTION_IDS,
  type DashboardLayout,
  type DashboardLayoutErrorCode,
  type DashboardSectionId,
  DEFAULT_DASHBOARD_LAYOUT,
  dashboardLayoutInputSchema,
} from "@synapse/contracts";

const KNOWN = new Set<string>(DASHBOARD_SECTION_IDS);

export function defaultLayout(): DashboardLayout {
  return structuredClone(DEFAULT_DASHBOARD_LAYOUT);
}

/**
 * Turns any value into a valid layout. Anything that fails the input schema (corrupt or
 * hand-edited rows included) becomes the default layout; otherwise unknown ids are dropped,
 * duplicates keep their first occurrence, missing ids are appended in registry order and
 * `triage` is forced visible and expanded.
 */
export function normaliseLayout(input: unknown): DashboardLayout {
  const parsed = dashboardLayoutInputSchema.safeParse(input);
  if (!parsed.success) return defaultLayout();
  const seen = new Set<string>();
  const sections: DashboardLayout["sections"] = [];
  for (const s of parsed.data.sections) {
    if (!KNOWN.has(s.id) || seen.has(s.id)) continue;
    seen.add(s.id);
    sections.push({
      id: s.id as DashboardSectionId,
      visible: s.visible,
      collapsed: s.collapsed,
      width: s.width,
    });
  }
  for (const d of DEFAULT_DASHBOARD_LAYOUT.sections) {
    if (!seen.has(d.id)) sections.push({ ...d });
  }
  return {
    version: 1,
    sections: sections.map((s) =>
      s.id === "triage" ? { ...s, visible: true, collapsed: false } : s,
    ),
  };
}

export class LayoutError extends Error {
  constructor(readonly code: Exclude<DashboardLayoutErrorCode, "invalid_layout" | "invalid_name">) {
    super(code);
    this.name = "LayoutError";
  }
}
