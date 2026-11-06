"use client";

import type { SlackStatusDto } from "../../lib/api";

/** Slack collection facts. The backfill is started from its Needs-you setup card. */
export function SlackStatus({
  status,
  onSkip,
}: {
  status: SlackStatusDto | null;
  onSkip: () => void;
}) {
  if (!status) return <p>No Slack status yet.</p>;
  const { incremental, backfill, searchesToday } = status;
  return (
    <section>
      <p>
        Incremental: checkpoint {incremental.checkpoint ?? "none"}, last success{" "}
        {incremental.lastSuccessAt ?? "never"}
        {incremental.lastError?.kind === "parse_failed" && (
          <>
            {" "}
            <button type="button" onClick={onSkip}>
              Skip unreadable page
            </button>
          </>
        )}
      </p>
      <p>
        Backfill: {backfill.status}
        {backfill.pagesDone > 0 && ` (${backfill.pagesDone} pages)`}
        {backfill.status === "error" && backfill.lastError && ` - ${backfill.lastError.kind}`}
      </p>
      <p>Searches today: {searchesToday}</p>
    </section>
  );
}
