import { z } from "zod";

/** Every `<section id>` in `apps/web/app/page.tsx` except `overview`. */
export const DASHBOARD_SECTION_IDS = [
  "triage",
  "running",
  "inbox",
  "commitments",
  "jira",
  "projects",
  "engineering",
  "people",
  "system",
] as const;
export type DashboardSectionId = (typeof DASHBOARD_SECTION_IDS)[number];

export const sectionWidthSchema = z.enum(["full", "half"]);

const sectionShape = {
  visible: z.boolean(),
  collapsed: z.boolean(),
  width: sectionWidthSchema,
};

export const dashboardLayoutSchema = z.strictObject({
  version: z.literal(1),
  sections: z.array(z.strictObject({ id: z.enum(DASHBOARD_SECTION_IDS), ...sectionShape })),
});
export type DashboardLayout = z.infer<typeof dashboardLayoutSchema>;

/** Request shape: unknown ids pass and are dropped by normalisation. */
export const dashboardLayoutInputSchema = z.strictObject({
  version: z.literal(1),
  sections: z.array(z.strictObject({ id: z.string().min(1).max(40), ...sectionShape })).max(50),
});

export const layoutNameSchema = z.string().trim().min(1).max(40);

export const MAX_DASHBOARD_LAYOUTS = 10;

export const DEFAULT_DASHBOARD_LAYOUT: DashboardLayout = {
  version: 1,
  sections: DASHBOARD_SECTION_IDS.map((id) => ({
    id,
    visible: true,
    collapsed: false,
    width: id === "triage" || id === "running" ? "half" : "full",
  })),
};

export interface DashboardLayoutView {
  id: string;
  name: string;
  isActive: boolean;
  layout: DashboardLayout;
  updatedAt: string;
}

export interface DashboardLayoutSummary {
  id: string;
  name: string;
  isActive: boolean;
  updatedAt: string;
}

export interface DashboardLayoutsResponse {
  active: DashboardLayoutView;
  layouts: DashboardLayoutSummary[];
}

export type DashboardLayoutErrorCode =
  | "name_taken"
  | "limit_reached"
  | "active_layout"
  | "last_layout"
  | "not_found"
  | "invalid_layout"
  | "invalid_name";
