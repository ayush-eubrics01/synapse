import type { DashboardLayout, DashboardSectionId } from "@synapse/contracts";

type Section = DashboardLayout["sections"][number];

/** Labels match the sidebar; `running` has no sidebar entry. */
export const SECTION_LABELS: Record<DashboardSectionId, string> = {
  triage: "Needs you",
  running: "How Synapse is running",
  inbox: "Inbox",
  commitments: "Commitments",
  jira: "Jira",
  projects: "Projects",
  engineering: "Engineering",
  people: "People",
  system: "System",
};

const patch = (
  l: DashboardLayout,
  id: DashboardSectionId,
  p: Partial<Section>,
): DashboardLayout => ({
  ...l,
  sections: l.sections.map((s) => (s.id === id ? { ...s, ...p } : s)),
});

/** Swaps a section with its neighbour; nothing happens at either end. */
export function moveSection(
  l: DashboardLayout,
  id: DashboardSectionId,
  delta: -1 | 1,
): DashboardLayout {
  const from = l.sections.findIndex((s) => s.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= l.sections.length) return l;
  const sections = [...l.sections];
  [sections[from], sections[to]] = [sections[to] as Section, sections[from] as Section];
  return { ...l, sections };
}

/** Needs you always stays visible. */
export function setVisible(
  l: DashboardLayout,
  id: DashboardSectionId,
  visible: boolean,
): DashboardLayout {
  return id === "triage" ? l : patch(l, id, { visible });
}

/** Needs you never collapses. */
export function setCollapsed(
  l: DashboardLayout,
  id: DashboardSectionId,
  collapsed: boolean,
): DashboardLayout {
  return id === "triage" ? l : patch(l, id, { collapsed });
}

export function setWidth(
  l: DashboardLayout,
  id: DashboardSectionId,
  width: Section["width"],
): DashboardLayout {
  return patch(l, id, { width });
}

export function hiddenSections(l: DashboardLayout): DashboardSectionId[] {
  return l.sections.filter((s) => !s.visible).map((s) => s.id);
}

export type LayoutRow =
  | { kind: "pair"; ids: [DashboardSectionId, DashboardSectionId] }
  | { kind: "single"; id: DashboardSectionId };

/** Two consecutive visible `half` sections share a row; hidden sections are skipped. */
export function layoutRows(l: DashboardLayout): LayoutRow[] {
  const visible = l.sections.filter((s) => s.visible);
  const rows: LayoutRow[] = [];
  for (let i = 0; i < visible.length; i++) {
    const a = visible[i] as Section;
    const b = visible[i + 1];
    if (a.width === "half" && b?.width === "half") {
      rows.push({ kind: "pair", ids: [a.id, b.id] });
      i++;
    } else rows.push({ kind: "single", id: a.id });
  }
  return rows;
}

/** Like `moveSection`, but steps over hidden sections so one click always moves a visible one. */
export function moveVisible(
  l: DashboardLayout,
  id: DashboardSectionId,
  delta: -1 | 1,
): DashboardLayout {
  const from = l.sections.findIndex((s) => s.id === id);
  let to = from + delta;
  while (l.sections[to] && !l.sections[to]?.visible) to += delta;
  if (from < 0 || to < 0 || to >= l.sections.length) return l;
  const sections = [...l.sections];
  const [moved] = sections.splice(from, 1);
  sections.splice(to, 0, moved as Section);
  return { ...l, sections };
}

const LAYOUT_ERRORS: Record<string, string> = {
  name_taken: "A layout with that name already exists",
  limit_reached: "You can keep up to 10 layouts",
  active_layout: "Switch to another layout before deleting this one",
  last_layout: "You can't delete the only layout",
};

/** Toast text for a layouts API error code. */
export function layoutErrorText(code: string | undefined): string {
  return (code && LAYOUT_ERRORS[code]) || "Couldn't update the layouts";
}
