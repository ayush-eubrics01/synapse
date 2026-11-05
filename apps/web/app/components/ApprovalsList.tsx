"use client";

import type { Approval } from "@synapse/contracts";

export function ApprovalsList({
  approvals,
  onDecide,
}: {
  approvals: Approval[];
  onDecide: (id: string, decision: "approve" | "reject") => void;
}) {
  if (approvals.length === 0) return <p>No pending approvals.</p>;
  return (
    <ul style={{ paddingLeft: "1rem" }}>
      {approvals.map((a) => (
        <li key={a.id} style={{ marginBottom: 8 }}>
          <strong>{a.action}</strong> on {a.targetIntegration}/{a.targetRef} ({a.riskLevel}) from{" "}
          {a.requestedByModule}{" "}
          <button type="button" onClick={() => onDecide(a.id, "approve")}>
            Approve
          </button>{" "}
          <button type="button" onClick={() => onDecide(a.id, "reject")}>
            Reject
          </button>
        </li>
      ))}
    </ul>
  );
}
