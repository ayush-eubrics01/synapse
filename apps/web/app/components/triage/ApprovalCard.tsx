"use client";

import type { ApprovalView } from "@synapse/contracts";
import { Button } from "../ui/Button";
import { Actions, CardFrame, Explainer, metaLine, Quote } from "./CardFrame";

/** "slack.send" → "SLACK SEND". */
function actionTag(action: string): string {
  return action.replace(/[._]/g, " ").toUpperCase();
}

/** H4: a send approval shows exactly what will be posted, to whom and where. */
export function ApprovalCard({
  approval: a,
  now,
  onDecide,
}: {
  approval: ApprovalView;
  now: Date | null;
  onDecide: (id: string, decision: "approve" | "reject") => void;
}) {
  const o = a.outgoing;
  return (
    <CardFrame
      tag={`APPROVAL · ${actionTag(a.action)}`}
      tone="blue"
      meta={metaLine(a.createdAt, now, a.requestedByModule)}
      title={
        o
          ? `Send to ${o.recipientName ?? "unknown recipient"} in ${o.conversationLabel}`
          : `${a.action} on ${a.targetIntegration}/${a.targetRef}`
      }
    >
      {o && <Quote>{o.text}</Quote>}
      <Explainer>
        {o
          ? o.threadReply
            ? "Posts as a thread reply. Nothing is sent until you approve."
            : "Posts to the conversation (not in a thread). Nothing is sent until you approve."
          : `${a.riskLevel} risk · requested by ${a.requestedByModule}`}
      </Explainer>
      <Actions>
        <Button variant="primary" onClick={() => onDecide(a.id, "approve")}>
          Approve
        </Button>
        <Button variant="secondary" onClick={() => onDecide(a.id, "reject")}>
          Reject
        </Button>
      </Actions>
    </CardFrame>
  );
}
