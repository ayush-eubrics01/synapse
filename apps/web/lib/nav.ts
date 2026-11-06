import type { DashboardOverview } from "@synapse/contracts";

export type SectionId = "overview" | "triage" | "inbox" | "commitments" | "people" | "system";

export interface NavItem {
  id: SectionId;
  label: string;
  count?: number;
  hot?: boolean;
}

export const SECTION_IDS: SectionId[] = [
  "overview",
  "triage",
  "inbox",
  "commitments",
  "people",
  "system",
];

/** Sidebar nav (spec D1) with badge counts from the overview; no counts until it loads. */
export function sidebarItems(counts: DashboardOverview["counts"] | null): NavItem[] {
  const needsYou = counts
    ? counts.urgent +
      counts.outgoingAttention +
      counts.approvals +
      counts.redFlags +
      counts.followupDrafts +
      counts.commitmentsToReview +
      counts.profileRecommendations
    : 0;
  return [
    { id: "overview", label: "Overview" },
    { id: "triage", label: "Needs you", count: needsYou, hot: needsYou > 0 },
    { id: "inbox", label: "Inbox", count: counts?.conversations ?? 0 },
    { id: "commitments", label: "Commitments", count: counts?.commitmentsToReview ?? 0 },
    { id: "people", label: "People", count: counts?.peopleToEvaluate ?? 0 },
    { id: "system", label: "System" },
  ];
}
