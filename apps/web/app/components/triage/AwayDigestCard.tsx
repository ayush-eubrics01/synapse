"use client";

import type { AutoReplyView, AwayDigest } from "@synapse/contracts";
import { deliveryLabel, digestTitle, holdReasonLabel, kindLabel } from "../../../lib/away";
import { relMinutes } from "../../../lib/format";
import { Avatar } from "../ui/Avatar";
import { Button } from "../ui/Button";
import { Actions, absoluteTime, CardFrame, metaLine } from "./CardFrame";

function Row({ v, now }: { v: AutoReplyView; now: Date | null }) {
  const outcome =
    v.decision === "sent" ? deliveryLabel(v.outgoingStatus) : holdReasonLabel(v.reason);
  return (
    <li className="syn-away-row" data-decision={v.decision}>
      <Avatar id={v.recipient.slackUserId} name={v.recipient.name} size={28} />
      <div className="syn-away-row-main">
        <div className="syn-away-row-line">
          <span className="syn-away-row-name">{v.recipient.name ?? v.recipient.slackUserId}</span>
          <span className="syn-away-row-kind">{kindLabel(v.kind)}</span>
        </div>
        <div className="syn-away-row-sub">
          {v.conversationLabel ?? "an unknown conversation"}
          {now ? ` · ${relMinutes(v.createdAt, now)}` : ""}
        </div>
      </div>
      <span className="syn-away-row-outcome" title={absoluteTime(v.createdAt)}>
        {outcome}
      </span>
    </li>
  );
}

/** The return digest (spec A17): what Synapse did while the user was away. */
export function AwayDigestCard({
  digest,
  now,
  onDismiss,
}: {
  digest: AwayDigest;
  now: Date | null;
  onDismiss: (sessionId: string) => void;
}) {
  const rows = [...digest.sent, ...digest.held];
  return (
    <CardFrame
      tag="WHILE YOU WERE AWAY"
      tone="blue"
      meta={metaLine(digest.session.endedAt, now, "away ended")}
      metaTitle={absoluteTime(digest.session.endedAt)}
      title={digestTitle(digest.sent.length, digest.held.length)}
    >
      {rows.length > 0 && (
        <ul className="syn-away-rows">
          {rows.map((v) => (
            <Row key={v.id} v={v} now={now} />
          ))}
        </ul>
      )}
      <Actions>
        <Button variant="secondary" onClick={() => onDismiss(digest.session.id)}>
          Dismiss
        </Button>
      </Actions>
    </CardFrame>
  );
}
