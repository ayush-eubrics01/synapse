"use client";

import type { SlackStatusDto } from "../../lib/api";
import { backfillAction } from "../../lib/backfill-action";

export function SlackStatus({
  status,
  onBackfill,
}: {
  status: SlackStatusDto | null;
  onBackfill: () => void;
}) {
  if (!status) return <p>No Slack status yet.</p>;
  const { incremental, backfill, searchesToday } = status;
  // R54 + R60 M4: start from idle; resume from error or a running backfill with no live job.
  const action = backfillAction(backfill);
  return (
    <section>
      <p>
        Incremental: checkpoint {incremental.checkpoint ?? "none"}, last success{" "}
        {incremental.lastSuccessAt ?? "never"}
      </p>
      <p>
        Backfill: {backfill.status}
        {backfill.pagesDone > 0 && ` (${backfill.pagesDone} pages)`}
        {backfill.status === "error" && backfill.lastError && ` - ${backfill.lastError.kind}`}{" "}
        <button type="button" disabled={!action.enabled} onClick={onBackfill}>
          {action.label}
        </button>
      </p>
      <p>Searches today: {searchesToday}</p>
    </section>
  );
}
