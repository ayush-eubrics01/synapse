import type { DashboardOverview } from "@synapse/contracts";

export type SectionId =
  | "overview"
  | "triage"
  | "inbox"
  | "commitments"
  | "jira"
  | "people"
  | "system";

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
  "jira",
  "people",
  "system",
];

/**
 * Sidebar nav (spec D1). The Needs-you badge is the number of cards the feed shows
 * (`buildNeedsYou`), so badge and feed always agree. The Inbox badge is the number of
 * conversations where they wrote last; the other badges come from the overview.
 */
export function sidebarItems(
  counts: DashboardOverview["counts"] | null,
  needsYou: number,
  waitingConversations = 0,
): NavItem[] {
  return [
    { id: "overview", label: "Overview" },
    { id: "triage", label: "Needs you", count: needsYou, hot: needsYou > 0 },
    { id: "inbox", label: "Inbox", count: waitingConversations },
    { id: "commitments", label: "Commitments", count: counts?.commitmentsToReview ?? 0 },
    { id: "jira", label: "Jira", count: counts?.jiraAttention ?? 0 },
    { id: "people", label: "People", count: counts?.peopleToEvaluate ?? 0 },
    { id: "system", label: "System" },
  ];
}
