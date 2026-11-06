"use client";

import type { ApprovalView } from "@synapse/contracts";

export function ApprovalsList({
  approvals,
  onDecide,
}: {
  approvals: ApprovalView[];
  onDecide: (id: string, decision: "approve" | "reject") => void;
}) {
  if (approvals.length === 0) return <p>No pending approvals.</p>;
  return (
    <ul style={{ paddingLeft: "1rem" }}>
      {approvals.map((a) => (
        <li key={a.id} style={{ marginBottom: 8 }}>
          <strong>{a.action}</strong> on {a.targetIntegration}/{a.targetRef} ({a.riskLevel}) from{" "}
          {a.requestedByModule}
          {a.outgoing && (
            <div>
              <div>
                To: {a.outgoing.recipientName ?? "unknown recipient"} in{" "}
                {a.outgoing.conversationLabel}
                {a.outgoing.threadReply ? " (thread reply)" : " (not in a thread)"}
              </div>
              <div style={{ whiteSpace: "pre-wrap" }}>{a.outgoing.text}</div>
            </div>
          )}{" "}
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
