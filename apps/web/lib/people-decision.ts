export interface DecisionTarget {
  id: string;
  approvalId: string | null;
}

export interface Decision {
  approvalId: string;
  decision: "approve" | "reject";
  reason?: string;
}

/**
 * Maps a recommendation action to the approvals call: the approval id, never the recommendation id.
 * Null when the item has no approval to decide.
 */
export function decisionFor(
  item: DecisionTarget,
  decision: "approve" | "reject",
  reason?: string,
): Decision | null {
  if (!item.approvalId) return null;
  return decision === "reject"
    ? { approvalId: item.approvalId, decision, reason }
    : { approvalId: item.approvalId, decision };
}
