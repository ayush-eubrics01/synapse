"use client";

import type { ResolveDecisionDto } from "../../../lib/api";
import type { OutgoingAttention } from "../../../lib/needs-you";
import { Button } from "../ui/Button";
import { Actions, CardFrame, Explainer, metaLine, Quote, SEND_STATUS } from "./CardFrame";

const LABEL: Record<ResolveDecisionDto, string> = {
  mark_sent: "Mark sent",
  resend: "Resend",
  discard: "Discard send",
};
const VARIANT: Record<ResolveDecisionDto, "primary" | "secondary" | "ghost"> = {
  mark_sent: "primary",
  resend: "secondary",
  discard: "ghost",
};

/** A send whose delivery is unknown. The choices are exactly the server's (resolveNeedsAttention). */
export function OutgoingAttentionCard({
  out,
  now,
  onResolve,
}: {
  out: OutgoingAttention;
  now: Date | null;
  onResolve: (outgoingId: string, decision: ResolveDecisionDto) => void;
}) {
  const attention = out.status === "needs_attention";
  return (
    <CardFrame
      tag={attention ? "SEND · NEEDS ATTENTION" : "SEND · UNVERIFIED"}
      tone={attention ? "red" : "amber"}
      meta={metaLine(out.at, now, out.origin === "urgent" ? "urgent reply" : "follow-up")}
      title={`Message to ${out.recipient} in ${out.conversation}`}
    >
      {out.text !== null && <Quote>{out.text}</Quote>}
      <Explainer>
        {SEND_STATUS[out.status] ?? out.status}. Synapse couldn't confirm delivery. Check Slack,
        then choose.
      </Explainer>
      {out.actions.includes("resend") && <Explainer>Requires your approval to resend.</Explainer>}
      <Actions>
        {out.actions.map((a) => (
          <Button key={a} variant={VARIANT[a]} onClick={() => onResolve(out.outgoingId, a)}>
            {LABEL[a]}
          </Button>
        ))}
      </Actions>
    </CardFrame>
  );
}
